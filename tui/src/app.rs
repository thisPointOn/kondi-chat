use crate::protocol::{BackendEvent, GitInfo, MessageStats, ToolCallInfo};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use std::collections::VecDeque;
use std::time::Instant;

/// Hard upper bound on the compose-input length. Sized to roughly match the
/// max visual capacity of the input box (~18 lines × a typical terminal
/// width). Past this, `insert_char` is a no-op so the user can't type into
/// invisible scroll territory inside the box.
const MAX_INPUT_CHARS: usize = 8000;

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub content: String,
    pub model_label: Option<String>,
    pub tool_calls: Vec<ToolCallInfo>,
    pub stats: Option<MessageStats>,
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PermissionDialog {
    pub id: String,
    pub tool: String,
    pub summary: String,
    pub tier: String,
}

/// State for the interactive key-setup wizard modal.
#[derive(Debug, Clone)]
pub struct WizardState {
    pub id: String,
    /// "select" — pick a numbered option; "input" — type a value.
    pub step: String,
    pub title: String,
    pub options: Vec<String>,
    /// Render typed input as dots (used for the API key).
    pub masked: bool,
    pub hint: String,
    /// Accumulates keystrokes during an "input" step.
    pub input: String,
}

pub struct App {
    /// Holds AT MOST one entry: the in-progress assistant message currently
    /// being streamed by the backend. When stats arrive (= turn complete),
    /// the message is rendered to a Vec<Line> and pushed to pending_history,
    /// then this is cleared. Past messages live in normal terminal scrollback.
    pub messages: Vec<ChatMessage>,
    /// Render queue for the main loop. Each entry is a fully-rendered chat
    /// message (one user/assistant turn or one system note). The main loop
    /// drains this on every iteration via terminal.insert_before(...) so the
    /// lines land in normal scrollback above the inline viewport.
    ///
    pub pending_history: Vec<Vec<Line<'static>>>,
    /// Bash-style input history.
    pub user_inputs: Vec<String>,
    pub history_idx: Option<usize>,
    pub history_draft: String,
    pub input: String,
    /// Cursor position within `input`, measured in *characters* (not bytes)
    /// so multibyte UTF-8 content doesn't desync the index.
    pub input_cursor: usize,
    pub status: String,
    /// Last model that actually handled a turn (set by MessageUpdate
    /// stats). Shown alongside the profile name in the indicator.
    pub model: String,
    /// Active profile name (set by model_override with pinned=false).
    pub profile_name: String,
    /// True when the router override is set (via /use). False when the
    /// router is free to pick models for each phase.
    pub routing_pinned: bool,
    pub is_processing: bool,
    pub detail_scroll: usize,
    pub detail_view: Option<String>,
    pub show_activity: bool,
    pub activity: Vec<(String, String)>,
    pub working_id: Option<String>,
    pub start_time: Instant,
    pub session_cost: f64,
    pub pending_permissions: Vec<PermissionDialog>,
    /// Active key-setup wizard modal, if any.
    pub wizard: Option<WizardState>,
    pub git_info: Option<GitInfo>,
    /// Most recent completed assistant message body — used by Ctrl+Y to copy.
    pub last_assistant_content: Option<String>,
    /// Last completed message — kept for Ctrl+T/Ctrl+O/Ctrl+R detail views
    /// after the message has been flushed to scrollback.
    pub last_completed_message: Option<ChatMessage>,
    /// Type-ahead queue: submits (or slash commands) that were entered
    /// while a previous turn was still running. Drained one at a time in
    /// the main loop when `is_processing` flips back to false. Prevents
    /// concurrent turns from racing over shared context / session state.
    pub pending_submits: VecDeque<String>,
    /// Aliases (or ids) of models the backend reports as available. Populated
    /// from the `ready` event and consumed by the `@` autocomplete system.
    pub available_models: Vec<String>,
    /// Persistent clipboard handle. On X11 arboard serves the selection
    /// from a background thread owned by this struct; if we drop it after
    /// each copy the contents disappear instantly. Kept alive for the
    /// lifetime of the TUI so pastes work.
    clipboard: Option<arboard::Clipboard>,
    /// Progressive streaming: how many rendered+wrapped lines of the
    /// current streaming message have already been flushed to terminal
    /// scrollback via insert_before. Reset to 0 when the message completes.
    /// This lets long streaming responses scroll naturally into scrollback
    /// instead of being trapped in the small preview area.
    pub stream_lines_flushed: usize,
}

const SPINNER_FRAMES: &[&str] = &["◐", "◓", "◑", "◒"];

impl App {
    pub fn spinner(&self) -> &str {
        if !self.is_processing { return "" }
        let elapsed = self.start_time.elapsed().as_millis() as usize;
        SPINNER_FRAMES[(elapsed / 100) % SPINNER_FRAMES.len()]
    }

    pub fn new() -> Self {
        let mut pending_history = vec![];
        pending_history.push(splash_lines());
        Self {
            messages: vec![],
            pending_history,
            user_inputs: vec![],
            history_idx: None,
            history_draft: String::new(),
            input: String::new(),
            input_cursor: 0,
            status: "Starting...".to_string(),
            model: String::new(),
            profile_name: "auto".to_string(),
            routing_pinned: false,
            is_processing: false,
            detail_scroll: 0,
            detail_view: None,
            show_activity: false,
            activity: vec![],
            working_id: None,
            start_time: Instant::now(),
            session_cost: 0.0,
            pending_permissions: vec![],
            wizard: None,
            git_info: None,
            last_assistant_content: None,
            pending_submits: VecDeque::new(),
            available_models: vec![],
            last_completed_message: None,
            clipboard: arboard::Clipboard::new().ok(),
            stream_lines_flushed: 0,
        }
    }

    pub fn history_prev(&mut self) {
        if self.user_inputs.is_empty() { return; }
        let next = match self.history_idx {
            None => {
                self.history_draft = self.input.clone();
                0
            }
            Some(i) => (i + 1).min(self.user_inputs.len() - 1),
        };
        self.history_idx = Some(next);
        // user_inputs is newest-last, history_idx 0 = most recent.
        let len = self.user_inputs.len();
        self.input = self.user_inputs[len - 1 - next].clone();
        self.input_cursor = self.char_len();
    }

    pub fn history_next(&mut self) {
        if self.user_inputs.is_empty() { return; }
        match self.history_idx {
            None => {}
            Some(0) => {
                self.history_idx = None;
                self.input = std::mem::take(&mut self.history_draft);
            }
            Some(i) => {
                let next = i - 1;
                self.history_idx = Some(next);
                let len = self.user_inputs.len();
                self.input = self.user_inputs[len - 1 - next].clone();
            }
        }
        self.input_cursor = self.char_len();
    }

    /// Called when the user presses Enter and a submit is dispatched to
    /// the backend. Records the user line in scrollback AND marks the
    /// session as processing (spinner on, status "thinking...").
    pub fn add_user_message(&mut self, text: &str) {
        self.record_user_line(text);
        self.begin_processing();
    }

    /// Push a user line into scrollback + history recall without flipping
    /// the processing state. Used when queueing type-ahead during an
    /// already-running turn — the line is visible immediately but the
    /// current turn's spinner/status is untouched.
    pub fn record_user_line(&mut self, text: &str) {
        self.user_inputs.push(text.to_string());
        let lines = render_user_lines(text);
        self.pending_history.push(lines);
        self.history_idx = None;
        self.history_draft.clear();
    }

    fn begin_processing(&mut self) {
        self.is_processing = true;
        self.activity.clear();
        self.status = "thinking...".to_string();
        self.start_time = Instant::now();
    }

    /// Queue a submit/command to fire when the current turn finishes.
    /// No scrollback line is written — the inline viewport renders the
    /// full live queue below the in-progress message, and the message
    /// itself will land in scrollback (as a normal `❯` user line) when
    /// it actually fires via `pop_pending_submit`. Keeping the queued
    /// text out of scrollback until it really runs avoids a duplicate
    /// "queued: X" + "X" pair once the current turn finishes.
    pub fn queue_submit(&mut self, text: String) {
        self.pending_submits.push_back(text);
    }

    /// Drain the next queued submit and render it as a normal user line.
    /// The caller (main loop) is responsible for actually sending the
    /// TuiCommand over stdin — App has no writer handle.
    pub fn pop_pending_submit(&mut self) -> Option<String> {
        let text = self.pending_submits.pop_front()?;
        self.add_user_message(&text);
        Some(text)
    }

    /// Drop every queued submit without firing them. Called when the user
    /// hits Esc on an empty input while the queue has entries — gives an
    /// escape hatch if they change their mind mid-queue.
    pub fn clear_pending_submits(&mut self) -> usize {
        let n = self.pending_submits.len();
        self.pending_submits.clear();
        if n > 0 {
            self.push_system(format!("Cleared {n} queued submit{}.", if n == 1 { "" } else { "s" }));
        }
        n
    }

    // ── Input editing (cursor-aware, UTF-8 safe) ───────────────────

    fn char_len(&self) -> usize { self.input.chars().count() }

    /// Convert a char index into a byte index for slicing `self.input`.
    fn byte_at(&self, char_idx: usize) -> usize {
        self.input
            .char_indices()
            .nth(char_idx)
            .map(|(b, _)| b)
            .unwrap_or(self.input.len())
    }

    pub fn insert_char(&mut self, c: char) {
        // Hard cap matches the compose box's max visual size — past this,
        // the user can't see what they're typing, so we stop accepting
        // input rather than silently growing off-screen. Also bounds paste.
        if self.input.chars().count() >= MAX_INPUT_CHARS { return; }
        let byte = self.byte_at(self.input_cursor);
        self.input.insert(byte, c);
        self.input_cursor += 1;
    }

    pub fn backspace_at_cursor(&mut self) {
        if self.input_cursor == 0 { return; }
        let prev = self.input_cursor - 1;
        let start = self.byte_at(prev);
        let end = self.byte_at(self.input_cursor);
        self.input.replace_range(start..end, "");
        self.input_cursor = prev;
    }

    pub fn delete_at_cursor(&mut self) {
        if self.input_cursor >= self.char_len() { return; }
        let start = self.byte_at(self.input_cursor);
        let end = self.byte_at(self.input_cursor + 1);
        self.input.replace_range(start..end, "");
    }

    pub fn cursor_left(&mut self) {
        if self.input_cursor > 0 { self.input_cursor -= 1; }
    }

    pub fn cursor_right(&mut self) {
        if self.input_cursor < self.char_len() { self.input_cursor += 1; }
    }

    pub fn cursor_home(&mut self) { self.input_cursor = 0; }
    pub fn cursor_end(&mut self) { self.input_cursor = self.char_len(); }

    pub fn clear_input(&mut self) {
        self.input.clear();
        self.input_cursor = 0;
    }

    /// Copy the most recent completed assistant message to the system
    /// clipboard. Shows a one-line system note describing the result so the
    /// user has feedback that ^Y did something.
    pub fn copy_last_response(&mut self) {
        let Some(content) = self.last_assistant_content.clone() else {
            self.push_system("Nothing to copy yet — wait for an assistant response.".into());
            return;
        };
        // Lazily (re)initialize on failure so a transient clipboard hiccup
        // doesn't leave the handle permanently broken.
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().ok();
        }
        let Some(cb) = self.clipboard.as_mut() else {
            self.push_system("Clipboard unavailable (no X11/Wayland display?).".into());
            return;
        };
        match cb.set_text(content.clone()) {
            Ok(()) => {
                let chars = content.chars().count();
                self.push_system(format!("Copied last response to clipboard ({chars} chars)."));
            }
            Err(e) => {
                // Drop the handle so the next call retries with a fresh one.
                self.clipboard = None;
                self.push_system(format!("Clipboard copy failed: {e}"));
            }
        }
    }

    pub fn toggle_detail(&mut self, view: &str) {
        if self.detail_view.as_deref() == Some(view) {
            self.detail_view = None;
        } else {
            self.detail_view = Some(view.to_string());
        }
        self.detail_scroll = 0;
    }

    /// Render the in-progress message (if any) and push to pending_history,
    /// then clear messages. Called when stats arrive on a MessageUpdate.
    /// Activity lines (router decisions, step announcements) are prepended
    /// so they survive into terminal scrollback alongside the response.
    fn flush_in_progress(&mut self) {
        if let Some(msg) = self.messages.drain(..).next() {
            self.last_completed_message = Some(msg.clone());
            let mut lines: Vec<Line<'static>> = Vec::new();

            if self.stream_lines_flushed > 0 {
                // Progressive streaming was active — header, activity,
                // and most content are already in scrollback. Push the
                // remaining tail (what was visible in the preview) plus
                // the stats footer. The tail is rendered fresh here so
                // it includes any final content that wasn't flushed yet.
                self.activity.clear();

                // Render all content, then take only the unflushed tail.
                // We can't wrap here (no terminal width), so push unwrapped
                // lines — the main loop will wrap them via pending_history.
                let content_lines = render_content_lines(&msg.content);
                // Simpler: just push the last ~8 unwrapped lines as the tail.
                // Some may duplicate what's in scrollback, but that's better
                // than dropping content.
                let tail_start = content_lines.len().saturating_sub(8);
                let remaining: Vec<Line<'static>> = content_lines.into_iter()
                    .skip(tail_start)
                    .collect();
                lines.extend(remaining);

                // Stats footer
                if let Some(ref stats) = msg.stats {
                    let models = stats.models.join(", ");
                    let mut parts = format!(
                        "  ▸ {}in / {}out · ${:.4} · {}",
                        stats.input_tokens, stats.output_tokens, stats.cost_usd, models
                    );
                    if stats.iterations > 1 {
                        parts.push_str(&format!(" · {} steps", stats.iterations));
                    }
                    if let Some(ref reason) = &stats.route_reason {
                        parts.push_str(&format!(" · route: {}", reason));
                    }
                    lines.push(Line::from(Span::styled(parts, Style::default().fg(Color::DarkGray))));
                }
            } else {
                // No progressive flush happened — render everything.
                for (kind, text) in self.activity.drain(..) {
                    if kind == "tool" { continue; }
                    lines.push(Line::from(Span::styled(
                        format!("  {}", text),
                        Style::default().fg(Color::Yellow).add_modifier(Modifier::DIM),
                    )));
                }
                lines.extend(render_assistant_lines(&msg));
            }

            if !lines.is_empty() {
                self.pending_history.push(lines);
            }
            self.stream_lines_flushed = 0;
        } else {
            self.activity.clear();
        }
    }

    pub fn push_system_public(&mut self, text: String) {
        self.push_system(text);
    }

    fn push_system(&mut self, text: String) {
        let lines = render_system_lines(&text);
        self.pending_history.push(lines);
    }

    pub fn handle_backend_event(&mut self, event: BackendEvent) {
        match event {
            BackendEvent::Ready { mode, status, git_info, resumed, resumed_session_id, resumed_message_count, models, .. } => {
                self.status = status;
                self.model = mode;
                self.git_info = git_info;
                self.available_models = models;
                if resumed {
                    let id = resumed_session_id.unwrap_or_default();
                    let count = resumed_message_count.unwrap_or(0);
                    self.push_system(format!(
                        "Resumed session {} ({} messages).",
                        id.chars().take(8).collect::<String>(),
                        count,
                    ));
                }
            }
            BackendEvent::Message { id, role, content, model_label, reasoning_content } => {
                if role == "assistant" {
                    self.messages.clear();
                    self.messages.push(ChatMessage {
                        id: id.clone(),
                        content,
                        model_label: model_label.clone(),
                        tool_calls: vec![],
                        stats: None,
                        reasoning_content,
                    });
                    if model_label.is_some() {
                        self.working_id = Some(id);
                    }
                } else if role == "system" {
                    self.push_system(content);
                }
            }
            BackendEvent::MessageUpdate { id, content, model_label, tool_calls, stats, reasoning_content } => {
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == id) {
                    if let Some(c) = content { msg.content = c; }
                    if let Some(l) = model_label { msg.model_label = Some(l); }
                    if let Some(tc) = tool_calls { msg.tool_calls = tc; }
                    if let Some(r) = reasoning_content { msg.reasoning_content = Some(r); }
                    if let Some(s) = stats {
                        self.session_cost += s.cost_usd;
                        msg.stats = Some(s);
                        if let Some(ref label) = msg.model_label {
                            self.model = label.clone();
                        }
                        if !msg.content.is_empty() {
                            self.last_assistant_content = Some(msg.content.clone());
                        }
                        self.is_processing = false;
                        self.working_id = None;
                        self.status = String::new();
                        self.flush_in_progress();
                    }
                }
            }
            BackendEvent::ToolCall { name, args, is_error } => {
                if let Some(ref wid) = self.working_id {
                    if let Some(msg) = self.messages.iter_mut().find(|m| m.id == *wid) {
                        msg.tool_calls.push(ToolCallInfo {
                            name: name.clone(),
                            args: args.clone(),
                            result: None,
                            is_error,
                            diff: None,
                        });
                    }
                }
                self.activity.push(("tool".to_string(), format!("{name}({args})")));
            }
            BackendEvent::Status { text, git_info } => {
                self.status = text;
                if let Some(g) = git_info { self.git_info = Some(g); }
            }
            BackendEvent::Activity { text, activity_type } => {
                self.activity.push((activity_type, text));
            }
            BackendEvent::Error { message } => {
                self.push_system(format!("Error: {message}"));
                self.is_processing = false;
                self.status = String::new();
            }
            BackendEvent::PermissionRequest { id, tool, args: _, summary, tier } => {
                self.pending_permissions.push(PermissionDialog { id, tool, summary, tier });
            }
            BackendEvent::PermissionTimeout { id, tool } => {
                self.pending_permissions.retain(|p| p.id != id);
                self.push_system(format!("Permission request for {tool} timed out and was denied"));
            }
            BackendEvent::CommandResult { output } => {
                // Some commands (e.g. /keys, which talks via wizard events)
                // return no text — don't push a blank line for those.
                if !output.trim().is_empty() {
                    self.push_system(output);
                }
                self.is_processing = false;
                self.status = String::new();
            }
            BackendEvent::WizardPrompt { id, step, title, options, masked, hint } => {
                self.wizard = Some(WizardState {
                    id, step, title, options, masked, hint,
                    input: String::new(),
                });
            }
            BackendEvent::WizardDone { message } => {
                self.wizard = None;
                if !message.trim().is_empty() {
                    self.push_system(message);
                }
            }
            BackendEvent::ModelOverride { label, pinned } => {
                if pinned {
                    self.model = label;
                } else {
                    self.profile_name = label;
                }
                self.routing_pinned = pinned;
            }
        }
    }
}

// ── Renderers (also used by ui.rs for the in-progress preview) ──────

const PINK: Color = Color::Rgb(255, 20, 147);
const BODY: Color = Color::Rgb(210, 210, 210);

pub fn render_user_lines(text: &str) -> Vec<Line<'static>> {
    let mut out = vec![];
    let style = Style::default().fg(PINK).add_modifier(Modifier::BOLD);
    let prefix = Span::styled("❯ ", style);
    let mut first = true;
    for line in text.lines() {
        if first {
            out.push(Line::from(vec![prefix.clone(), Span::styled(line.to_string(), style)]));
            first = false;
        } else {
            out.push(Line::from(Span::styled(format!("  {}", line), style)));
        }
    }
    if first {
        out.push(Line::from(prefix));
    }
    out
}

pub fn render_system_lines(text: &str) -> Vec<Line<'static>> {
    let mut out = vec![];
    for line in text.lines() {
        out.push(Line::from(Span::styled(
            line.to_string(),
            Style::default().fg(Color::Yellow),
        )));
    }
    out
}

/// Walk `content` line by line. When we hit a markdown table block, render
/// it as a box-drawing table; otherwise emit the line as plain body text.
fn render_markdown_body(out: &mut Vec<Line<'static>>, content: &str) {
    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        if let Some(end) = detect_table_at(&lines, i) {
            let table_rows = parse_table(&lines[i..end]);
            render_table(out, &table_rows);
            i = end;
        } else {
            out.push(Line::from(Span::styled(
                format!("  {}", lines[i]),
                Style::default().fg(BODY),
            )));
            i += 1;
        }
    }
}

/// If lines[start..] begins a markdown table, return the exclusive end index.
/// Requirements: header row (starts with `|`), separator row (only `|`, `-`,
/// `:`, and whitespace), then zero or more data rows starting with `|`.
fn detect_table_at(lines: &[&str], start: usize) -> Option<usize> {
    if start + 1 >= lines.len() { return None; }
    let header = lines[start].trim_start();
    if !header.starts_with('|') || header.matches('|').count() < 2 { return None; }
    let sep = lines[start + 1].trim_start();
    if !sep.starts_with('|') { return None; }
    let sep_body: String = sep.chars().filter(|c| !c.is_whitespace()).collect();
    if !sep_body.chars().all(|c| matches!(c, '|' | '-' | ':')) { return None; }
    if !sep_body.contains('-') { return None; }
    // Walk forward consuming data rows.
    let mut end = start + 2;
    while end < lines.len() && lines[end].trim_start().starts_with('|') {
        end += 1;
    }
    Some(end)
}

/// Split a markdown row like `| a | b | c |` into trimmed cell strings.
fn parse_row(line: &str) -> Vec<String> {
    let trimmed = line.trim().trim_start_matches('|').trim_end_matches('|');
    trimmed.split('|').map(|c| c.trim().to_string()).collect()
}

/// Returns (header, data_rows). Skips the separator row.
fn parse_table(lines: &[&str]) -> (Vec<String>, Vec<Vec<String>>) {
    let header = parse_row(lines[0]);
    let mut data: Vec<Vec<String>> = Vec::new();
    for raw in &lines[2..] {
        let mut row = parse_row(raw);
        // Pad / trim to header width so the renderer doesn't index OOB.
        while row.len() < header.len() { row.push(String::new()); }
        row.truncate(header.len());
        data.push(row);
    }
    (header, data)
}

/// Strip inline markdown formatting so we measure and display plain text.
fn strip_md(s: &str) -> String {
    s.replace("**", "").replace('`', "")
}

/// Display width of a string in terminal columns. Emoji and CJK chars
/// take 2 columns; variation selectors and zero-width joiners take 0.
fn display_width(s: &str) -> usize {
    use unicode_width::UnicodeWidthStr;
    UnicodeWidthStr::width(s)
}

fn render_table(out: &mut Vec<Line<'static>>, table: &(Vec<String>, Vec<Vec<String>>)) {
    let (header, data) = table;
    let cols = header.len();
    if cols == 0 { return; }

    // 1. Strip markdown from ALL cells, compute widths from display width.
    let clean_header: Vec<String> = header.iter().map(|h| strip_md(h)).collect();
    let clean_data: Vec<Vec<String>> = data.iter().map(|row|
        row.iter().map(|c| strip_md(c)).collect()
    ).collect();

    let mut widths: Vec<usize> = clean_header.iter().map(|h| display_width(h)).collect();
    for row in &clean_data {
        for (i, cell) in row.iter().enumerate() {
            let w = display_width(cell);
            if w > widths[i] { widths[i] = w; }
        }
    }

    // 2. Cap to fit within 120 columns.
    // Row layout: "  │" + for each col: " " + content(width) + " " + "│" = 3 + sum(width+3)
    let max_w = 120usize;
    let overhead = 3 + 3 * cols;
    let budget = max_w.saturating_sub(overhead);
    let total: usize = widths.iter().sum();

    if total > budget && budget > 0 {
        let min_col = 6usize;
        let mut new_widths: Vec<usize> = widths.iter()
            .map(|w| ((*w as f64 / total as f64) * budget as f64).floor() as usize)
            .map(|w| w.max(min_col))
            .collect();
        loop {
            let sum: usize = new_widths.iter().sum();
            if sum <= budget { break; }
            if let Some(max_idx) = new_widths.iter().enumerate().max_by_key(|(_, w)| *w).map(|(i, _)| i) {
                new_widths[max_idx] = new_widths[max_idx].saturating_sub(1).max(min_col);
                if new_widths[max_idx] == min_col { break; }
            } else { break; }
        }
        widths = new_widths;
    }

    // 3. Render — border and data lines use the same widths array.
    let header_style = Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD);
    let border_style = Style::default().fg(Color::DarkGray);
    let body_style = Style::default().fg(BODY);

    out.push(border_line(&widths, '┌', '┬', '┐', border_style));
    out.push(data_line(&clean_header, &widths, header_style, border_style));
    out.push(border_line(&widths, '├', '┼', '┤', border_style));
    for row in &clean_data {
        out.push(data_line(row, &widths, body_style, border_style));
    }
    out.push(border_line(&widths, '└', '┴', '┘', border_style));
}

/// Render a border row: `  ┌──────┬──────┐`
fn border_line(widths: &[usize], left: char, mid: char, right: char, style: Style) -> Line<'static> {
    let mut s = String::from("  ");
    s.push(left);
    for (i, w) in widths.iter().enumerate() {
        for _ in 0..(w + 2) { s.push('─'); }
        s.push(if i + 1 == widths.len() { right } else { mid });
    }
    Line::from(Span::styled(s, style))
}

/// Render a data row: `  │ text  │ text │`
/// Uses display_width for padding so emoji/CJK chars align correctly.
fn data_line(cells: &[String], widths: &[usize], cell_style: Style, border_style: Style) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = vec![Span::styled("  │", border_style)];
    for (i, cell) in cells.iter().enumerate() {
        let w = widths[i];
        let dw = display_width(cell);
        let display: String = if dw > w {
            // Truncate by display width, not char count.
            let mut t = String::new();
            let mut tw = 0usize;
            for ch in cell.chars() {
                let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                if tw + cw >= w { break; }
                t.push(ch);
                tw += cw;
            }
            // Pad if truncation left us short (e.g. skipped a 2-wide char).
            while tw + 1 < w { t.push(' '); tw += 1; }
            t.push('…');
            t
        } else {
            let mut t = cell.clone();
            for _ in 0..(w - dw) { t.push(' '); }
            t
        };
        spans.push(Span::styled(format!(" {} ", display), cell_style));
        spans.push(Span::styled("│", border_style));
    }
    Line::from(spans)
}

pub fn render_assistant_lines(msg: &ChatMessage) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = vec![];

    let label = msg.model_label.clone().unwrap_or_else(|| "assistant".to_string());
    let mut header_spans = vec![
        Span::styled("● ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        Span::styled(label, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
    ];
    if msg.reasoning_content.as_deref().map(str::is_empty) == Some(false) {
        header_spans.push(Span::styled(
            "  [^R reasoning]",
            Style::default().fg(Color::Magenta).add_modifier(Modifier::DIM),
        ));
    }
    out.push(Line::from(header_spans));

    // Cap tool call display to avoid the list dominating the viewport.
    // Show the first few and last one, with a "... and N more" in between.
    let max_visible = 5;
    let tc_count = msg.tool_calls.len();
    for (i, tc) in msg.tool_calls.iter().enumerate() {
        if tc_count > max_visible + 1 && i >= max_visible - 1 && i < tc_count - 1 {
            if i == max_visible - 1 {
                out.push(Line::from(Span::styled(
                    format!("  … and {} more tool calls", tc_count - max_visible),
                    Style::default().fg(Color::DarkGray).add_modifier(Modifier::DIM),
                )));
            }
            continue;
        }
        let color = if tc.is_error { Color::Red } else { Color::Cyan };
        out.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(format!("⎿ {}", tc.name), Style::default().fg(color)),
            Span::styled(format!("({})", tc.args), Style::default().fg(Color::DarkGray)),
        ]));
        if let Some(ref diff) = tc.diff {
            push_diff_lines(&mut out, diff, 10, "    ");
        }
    }

    if !msg.content.is_empty() {
        render_markdown_body(&mut out, &msg.content);
    }

    // Mark where content ends — used by progressive streaming flush.
    // Everything before this point (header + tool calls + content) is the
    // "body". Stats are appended only on completion.

    if let Some(ref stats) = msg.stats {
        let models = stats.models.join(", ");
        let mut parts = format!(
            "  ▸ {}in / {}out · ${:.4} · {}",
            stats.input_tokens, stats.output_tokens, stats.cost_usd, models
        );
        if stats.iterations > 1 {
            parts.push_str(&format!(" · {} steps", stats.iterations));
        }
        if let Some(ref reason) = stats.route_reason {
            parts.push_str(&format!(" · route: {}", reason));
        }
        out.push(Line::from(Span::styled(parts, Style::default().fg(Color::DarkGray))));
    }

    out
}

/// Render only the markdown body content of a message — no header, no tool
/// calls, no stats. Used by the progressive streaming flush so that only
/// the LLM's text output scrolls into the terminal scrollback, while the
/// tool call list and header stay compact in the preview area.
pub fn render_content_lines(content: &str) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    if !content.is_empty() {
        render_markdown_body(&mut out, content);
    }
    out
}

/// Splash screen: K braille logo + "kondi" inside a compact pink border.
pub fn splash_lines() -> Vec<Line<'static>> {
    use unicode_width::UnicodeWidthStr;

    let pink = Style::default().fg(PINK);
    let cyan = Color::Rgb(80, 200, 230);
    let text_row = BH / 2;

    let value_prop_for_row = |row: usize| match row {
        2 => "  A coding assistant that asks for help.",
        3 => "  Built for developers, by developers.",
        4 => "  https://kondi.chat",
        _ => "",
    };

    // Width inside the border, excluding the leading outer margin and border
    // glyphs themselves. This matches the actual rendered content: one left
    // padding cell, the 30-cell logo, then whichever text appears on that row.
    let inner = (0..BH)
        .map(|row| {
            let text = if row == text_row {
                "  kondi"
            } else {
                value_prop_for_row(row)
            };
            // Interior width: logo (BW chars) + text (text.width())
            1 + BW + text.width() // 1 for the interior space after '║'
        })
        .max()
        .unwrap_or(1 + BW);

    let mut lines: Vec<Line<'static>> = vec![
        Line::from(""),
        Line::from(Span::styled(format!(" ╔{}╗", "═".repeat(inner)), pink)),
    ];

    for row in 0..BH {
        let mut spans: Vec<Span<'static>> = vec![Span::styled(" ║ ", pink)];
        for col in 0..BW {
            let (color, ch) = BRAILLE_CELLS[row * BW + col];
            match color {
                Some(c) => spans.push(Span::styled(ch, Style::default().fg(c))),
                None => spans.push(Span::raw(ch)),
            }
        }

        let value_prop_line = value_prop_for_row(row);
        if row == text_row {
            spans.push(Span::styled(
                "  kondi",
                Style::default().fg(cyan).add_modifier(Modifier::BOLD),
            ));
        } else if !value_prop_line.is_empty() {
            spans.push(Span::styled(
                value_prop_line,
                Style::default().fg(Color::DarkGray),
            ));
        }

        // Interior row width: 1 (interior space from prefix) + logo + optional text
        let logo_text_width: usize = spans[1..]
            .iter()
            .map(|sp| sp.content.width())
            .sum();
        let content_width = 1 + logo_text_width;
        let pad = inner.saturating_sub(content_width);
        if pad > 0 {
            spans.push(Span::raw(" ".repeat(pad)));
        }
        spans.push(Span::styled("║", pink));
        lines.push(Line::from(spans));
    }

    lines.push(Line::from(Span::styled(
        format!(" ╚{}╝", "═".repeat(inner)),
        pink,
    )));
    lines.push(Line::from(""));
    lines
}

// Braille K logo: 60x52 pixels in 30x13 cells.
const BW: usize = 30;
const BH: usize = 13;

type BC = (Option<Color>, &'static str);
const BRAILLE_CELLS: [BC; 390] = [
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(195,235,220)),"\u{2880}"),(Some(Color::Rgb(151,213,191)),"\u{28E0}"),(Some(Color::Rgb(134,198,178)),"\u{28E4}"),(Some(Color::Rgb(114,172,160)),"\u{28E4}"),(Some(Color::Rgb(234,241,240)),"\u{2844}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(239,237,244)),"\u{2880}"),(Some(Color::Rgb(139,155,178)),"\u{28E0}"),(Some(Color::Rgb(97,108,138)),"\u{28E4}"),(Some(Color::Rgb(232,231,232)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(170,234,210)),"\u{28F0}"),(Some(Color::Rgb(153,224,188)),"\u{28FF}"),(Some(Color::Rgb(119,204,177)),"\u{28FF}"),(Some(Color::Rgb(100,188,169)),"\u{28FF}"),(Some(Color::Rgb(131,190,180)),"\u{285F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(158,199,208)),"\u{2880}"),(Some(Color::Rgb(110,166,186)),"\u{28E4}"),(Some(Color::Rgb(75,127,153)),"\u{28F6}"),(Some(Color::Rgb(49,85,119)),"\u{28FF}"),(Some(Color::Rgb(57,80,114)),"\u{28FF}"),(Some(Color::Rgb(125,130,151)),"\u{281F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(179,232,227)),"\u{28F0}"),(Some(Color::Rgb(122,209,196)),"\u{28FF}"),(Some(Color::Rgb(88,191,188)),"\u{28FF}"),(Some(Color::Rgb(81,184,180)),"\u{28FF}"),(Some(Color::Rgb(94,184,180)),"\u{28FF}"),(Some(Color::Rgb(218,238,236)),"\u{2803}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(161,202,216)),"\u{28C0}"),(Some(Color::Rgb(137,204,212)),"\u{28F4}"),(Some(Color::Rgb(102,181,192)),"\u{28FE}"),(Some(Color::Rgb(58,137,159)),"\u{28FF}"),(Some(Color::Rgb(39,96,127)),"\u{28FF}"),(Some(Color::Rgb(56,83,123)),"\u{287F}"),(Some(Color::Rgb(63,80,119)),"\u{280B}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(192,226,233)),"\u{28A0}"),(Some(Color::Rgb(96,180,187)),"\u{28FF}"),(Some(Color::Rgb(58,151,172)),"\u{28FF}"),(Some(Color::Rgb(54,141,162)),"\u{28FF}"),(Some(Color::Rgb(46,123,148)),"\u{28FF}"),(Some(Color::Rgb(144,179,193)),"\u{284F}"),(Some(Color::Rgb(153,195,214)),"\u{28E0}"),(Some(Color::Rgb(118,203,213)),"\u{28F4}"),(Some(Color::Rgb(124,210,214)),"\u{28FF}"),(Some(Color::Rgb(91,193,198)),"\u{28FF}"),(Some(Color::Rgb(65,155,171)),"\u{28FF}"),(Some(Color::Rgb(57,119,148)),"\u{28FF}"),(Some(Color::Rgb(51,97,128)),"\u{281F}"),(Some(Color::Rgb(141,156,181)),"\u{280B}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(90,145,170)),"\u{28FE}"),(Some(Color::Rgb(44,98,150)),"\u{28FF}"),(Some(Color::Rgb(39,91,140)),"\u{28FF}"),(Some(Color::Rgb(48,96,137)),"\u{28FF}"),(Some(Color::Rgb(91,147,171)),"\u{28FF}"),(Some(Color::Rgb(170,234,232)),"\u{28FF}"),(Some(Color::Rgb(139,231,225)),"\u{28FF}"),(Some(Color::Rgb(100,193,201)),"\u{28FF}"),(Some(Color::Rgb(68,148,172)),"\u{28FF}"),(Some(Color::Rgb(87,140,170)),"\u{287F}"),(Some(Color::Rgb(109,143,172)),"\u{281B}"),(Some(Color::Rgb(195,197,216)),"\u{2801}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(129,149,177)),"\u{28FC}"),(Some(Color::Rgb(31,49,114)),"\u{28FF}"),(Some(Color::Rgb(44,82,133)),"\u{28FF}"),(Some(Color::Rgb(68,143,173)),"\u{28FF}"),(Some(Color::Rgb(92,204,214)),"\u{28FF}"),(Some(Color::Rgb(115,207,219)),"\u{28FF}"),(Some(Color::Rgb(77,156,181)),"\u{28FF}"),(Some(Color::Rgb(35,87,114)),"\u{28FF}"),(Some(Color::Rgb(29,57,92)),"\u{28FF}"),(Some(Color::Rgb(39,59,113)),"\u{28FF}"),(Some(Color::Rgb(55,110,154)),"\u{28E6}"),(Some(Color::Rgb(180,211,224)),"\u{28C4}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(148,143,160)),"\u{28B0}"),(Some(Color::Rgb(30,43,97)),"\u{28FF}"),(Some(Color::Rgb(39,84,142)),"\u{28FF}"),(Some(Color::Rgb(47,118,173)),"\u{28FF}"),(Some(Color::Rgb(55,132,165)),"\u{28FF}"),(Some(Color::Rgb(77,114,140)),"\u{28FF}"),(Some(Color::Rgb(98,120,144)),"\u{281B}"),(Some(Color::Rgb(166,162,168)),"\u{2809}"),(Some(Color::Rgb(109,110,122)),"\u{283B}"),(Some(Color::Rgb(50,50,95)),"\u{28FF}"),(Some(Color::Rgb(34,46,107)),"\u{28FF}"),(Some(Color::Rgb(51,87,146)),"\u{28FF}"),(Some(Color::Rgb(56,127,174)),"\u{28FF}"),(Some(Color::Rgb(118,192,215)),"\u{28F7}"),(Some(Color::Rgb(185,223,236)),"\u{28C4}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(183,188,208)),"\u{2880}"),(Some(Color::Rgb(61,70,127)),"\u{28FF}"),(Some(Color::Rgb(33,55,134)),"\u{28FF}"),(Some(Color::Rgb(30,49,113)),"\u{28FF}"),(Some(Color::Rgb(26,35,90)),"\u{28FF}"),(Some(Color::Rgb(23,21,82)),"\u{28FF}"),(Some(Color::Rgb(138,137,159)),"\u{280F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(210,212,225)),"\u{2808}"),(Some(Color::Rgb(91,93,148)),"\u{283B}"),(Some(Color::Rgb(48,49,132)),"\u{28FF}"),(Some(Color::Rgb(57,82,163)),"\u{28FF}"),(Some(Color::Rgb(64,122,193)),"\u{28FF}"),(Some(Color::Rgb(78,155,218)),"\u{28FF}"),(Some(Color::Rgb(133,197,240)),"\u{28F7}"),(Some(Color::Rgb(194,224,248)),"\u{28C4}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(93,90,147)),"\u{28FE}"),(Some(Color::Rgb(30,21,91)),"\u{28FF}"),(Some(Color::Rgb(33,16,86)),"\u{28FF}"),(Some(Color::Rgb(37,21,102)),"\u{28FF}"),(Some(Color::Rgb(39,24,114)),"\u{28FF}"),(Some(Color::Rgb(114,109,167)),"\u{281F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(145,140,184)),"\u{2808}"),(Some(Color::Rgb(75,66,152)),"\u{283B}"),(Some(Color::Rgb(65,61,164)),"\u{28FF}"),(Some(Color::Rgb(73,106,203)),"\u{28FF}"),(Some(Color::Rgb(90,134,226)),"\u{28FF}"),(Some(Color::Rgb(101,154,236)),"\u{28FF}"),(Some(Color::Rgb(129,182,244)),"\u{28F7}"),(Some(Color::Rgb(171,205,249)),"\u{28C4}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(121,105,146)),"\u{28F8}"),(Some(Color::Rgb(40,9,83)),"\u{28FF}"),(Some(Color::Rgb(47,12,89)),"\u{28FF}"),(Some(Color::Rgb(66,32,108)),"\u{28FF}"),(Some(Color::Rgb(79,48,121)),"\u{283F}"),(Some(Color::Rgb(146,128,173)),"\u{280B}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(174,159,210)),"\u{2808}"),(Some(Color::Rgb(130,103,188)),"\u{283B}"),(Some(Color::Rgb(97,70,187)),"\u{28BF}"),(Some(Color::Rgb(83,59,197)),"\u{28FF}"),(Some(Color::Rgb(89,77,209)),"\u{28FF}"),(Some(Color::Rgb(81,94,219)),"\u{28FF}"),(Some(Color::Rgb(98,109,222)),"\u{28F7}"),(Some(Color::Rgb(131,135,229)),"\u{28E6}"),(Some(Color::Rgb(173,170,231)),"\u{28C0}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(108,88,129)),"\u{2809}"),(Some(Color::Rgb(103,82,122)),"\u{2809}"),(Some(Color::Rgb(174,163,183)),"\u{2809}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(231,227,243)),"\u{2808}"),(Some(Color::Rgb(155,135,204)),"\u{2809}"),(Some(Color::Rgb(97,68,175)),"\u{2809}"),(Some(Color::Rgb(88,56,161)),"\u{2809}"),(Some(Color::Rgb(130,100,181)),"\u{2809}"),(Some(Color::Rgb(216,206,234)),"\u{2801}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
];
fn push_diff_lines(out: &mut Vec<Line<'static>>, diff: &str, max_lines: usize, indent: &str) {
    let all: Vec<&str> = diff.lines().collect();
    let show = all.len().min(max_lines);
    for raw in all.iter().take(show) {
        let style = if raw.starts_with("+++") || raw.starts_with("---") {
            Style::default().fg(Color::DarkGray)
        } else if raw.starts_with('+') {
            Style::default().fg(Color::Green)
        } else if raw.starts_with('-') {
            Style::default().fg(Color::Red)
        } else if raw.starts_with("@@") {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::Gray)
        };
        out.push(Line::from(Span::styled(format!("{}{}", indent, raw), style)));
    }
    if all.len() > show {
        out.push(Line::from(Span::styled(
            format!("{}... {} more lines (^O for full diff)", indent, all.len() - show),
            Style::default().fg(Color::DarkGray),
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Input editing (cursor-aware, UTF-8 safe) ──────────────────

    #[test]
    fn insert_char_basic() {
        let mut app = App::new();
        app.insert_char('H');
        app.insert_char('i');
        assert_eq!(app.input, "Hi");
        assert_eq!(app.input_cursor, 2);
    }

    #[test]
    fn insert_char_mid_cursor() {
        let mut app = App::new();
        app.insert_char('H');
        app.insert_char('i');
        app.cursor_left();
        app.insert_char('!');
        assert_eq!(app.input, "H!i");
        assert_eq!(app.input_cursor, 2);
    }

    #[test]
    fn insert_char_utf8_multibyte() {
        let mut app = App::new();
        app.insert_char('λ');
        app.insert_char('☃');
        app.insert_char('a');
        assert_eq!(app.input, "λ☃a");
        assert_eq!(app.input_cursor, 3);
        // byte length > char count for multibyte
        assert!(app.input.len() > 3);
    }

    #[test]
    fn backspace_at_start_does_nothing() {
        let mut app = App::new();
        app.input = "hi".into();
        app.input_cursor = 0;
        app.backspace_at_cursor();
        assert_eq!(app.input, "hi");
        assert_eq!(app.input_cursor, 0);
    }

    #[test]
    fn backspace_at_end() {
        let mut app = App::new();
        app.input = "abc".into();
        app.input_cursor = 3;
        app.backspace_at_cursor();
        assert_eq!(app.input, "ab");
        assert_eq!(app.input_cursor, 2);
    }

    #[test]
    fn backspace_mid() {
        let mut app = App::new();
        app.input = "abc".into();
        app.input_cursor = 2; // after 'b'
        app.backspace_at_cursor();
        assert_eq!(app.input, "ac");
        assert_eq!(app.input_cursor, 1);
    }

    #[test]
    fn backspace_utf8_multibyte() {
        let mut app = App::new();
        app.input = "aλc".into();
        app.input_cursor = 2; // after λ (index 2 = after 'λ')
        app.backspace_at_cursor();
        assert_eq!(app.input, "ac");
        assert_eq!(app.input_cursor, 1);
    }

    #[test]
    fn delete_at_end_does_nothing() {
        let mut app = App::new();
        app.input = "abc".into();
        app.input_cursor = 3;
        app.delete_at_cursor();
        assert_eq!(app.input, "abc");
        assert_eq!(app.input_cursor, 3);
    }

    #[test]
    fn delete_at_start() {
        let mut app = App::new();
        app.input = "abc".into();
        app.input_cursor = 0;
        app.delete_at_cursor();
        assert_eq!(app.input, "bc");
        assert_eq!(app.input_cursor, 0);
    }

    #[test]
    fn delete_mid() {
        let mut app = App::new();
        app.input = "abc".into();
        app.input_cursor = 1; // after 'a'
        app.delete_at_cursor();
        assert_eq!(app.input, "ac");
        assert_eq!(app.input_cursor, 1);
    }

    #[test]
    fn cursor_left_at_start_does_nothing() {
        let mut app = App::new();
        app.input = "hi".into();
        app.input_cursor = 0;
        app.cursor_left();
        assert_eq!(app.input_cursor, 0);
    }

    #[test]
    fn cursor_left_normal() {
        let mut app = App::new();
        app.input = "hi".into();
        app.input_cursor = 2;
        app.cursor_left();
        assert_eq!(app.input_cursor, 1);
    }

    #[test]
    fn cursor_right_at_end_does_nothing() {
        let mut app = App::new();
        app.input = "hi".into();
        app.input_cursor = 2;
        app.cursor_right();
        assert_eq!(app.input_cursor, 2);
    }

    #[test]
    fn cursor_right_normal() {
        let mut app = App::new();
        app.input = "hi".into();
        app.input_cursor = 0;
        app.cursor_right();
        assert_eq!(app.input_cursor, 1);
    }

    #[test]
    fn cursor_home() {
        let mut app = App::new();
        app.input = "hello".into();
        app.input_cursor = 5;
        app.cursor_home();
        assert_eq!(app.input_cursor, 0);
    }

    #[test]
    fn cursor_end() {
        let mut app = App::new();
        app.input = "hello".into();
        app.input_cursor = 0;
        app.cursor_end();
        assert_eq!(app.input_cursor, 5);
    }

    #[test]
    fn cursor_end_utf8() {
        let mut app = App::new();
        app.input = "λ☃".into();
        app.input_cursor = 0;
        app.cursor_end();
        assert_eq!(app.input_cursor, 2); // 2 chars, not bytes
    }

    #[test]
    fn clear_input() {
        let mut app = App::new();
        app.input = "something long".into();
        app.input_cursor = 5;
        app.clear_input();
        assert_eq!(app.input, "");
        assert_eq!(app.input_cursor, 0);
    }

    // ── History navigation ────────────────────────────────────────

    #[test]
    fn history_prev_empty_does_nothing() {
        let mut app = App::new();
        app.history_prev();
        assert!(app.history_idx.is_none());
    }

    #[test]
    fn history_prev_first_time_saves_draft() {
        let mut app = App::new();
        app.user_inputs = vec!["old1".into(), "old2".into()];
        app.input = "draft".into();
        app.input_cursor = 5;
        app.history_prev();
        // history_idx 0 = most recent entry = "old2" (newest-last convention)
        assert_eq!(app.history_idx, Some(0));
        assert_eq!(app.input, "old2");
        assert_eq!(app.history_draft, "draft");
        assert_eq!(app.input_cursor, 4); // "old2".chars().count()
    }

    #[test]
    fn history_prev_wrap_at_bottom() {
        let mut app = App::new();
        app.user_inputs = vec!["old1".into()];
        app.input = "draft".into();
        app.history_prev();
        assert_eq!(app.history_idx, Some(0));
        assert_eq!(app.input, "old1");
        // Press again — stays at last
        app.history_prev();
        assert_eq!(app.history_idx, Some(0));
        assert_eq!(app.input, "old1");
    }

    #[test]
    fn history_next_returns_to_draft() {
        let mut app = App::new();
        app.user_inputs = vec!["old1".into()];
        app.input = "draft".into();
        app.history_prev(); // idx=0
        app.history_next(); // idx=None, restore draft
        assert!(app.history_idx.is_none());
        assert_eq!(app.input, "draft");
    }

    #[test]
    fn history_next_empty_does_nothing() {
        let mut app = App::new();
        app.history_next();
        assert!(app.history_idx.is_none());
    }

    #[test]
    fn history_next_from_none_does_nothing() {
        let mut app = App::new();
        app.user_inputs = vec!["a".into()];
        app.history_next(); // None -> no-op
        assert!(app.history_idx.is_none());
    }

    #[test]
    fn history_traversal_walks_both_directions() {
        let mut app = App::new();
        // user_inputs: newest-last, so [0]="third", [1]="second", [2]="first"
        app.user_inputs = vec!["first".into(), "second".into(), "third".into()];
        app.input = "fresh".into();
        // prev 1 → third (idx=0, most recent)
        app.history_prev();
        assert_eq!(app.history_idx, Some(0));
        assert_eq!(app.input, "third");
        // prev 2 → second (idx=1)
        app.history_prev();
        assert_eq!(app.history_idx, Some(1));
        assert_eq!(app.input, "second");
        // next → third (idx=0)
        app.history_next();
        assert_eq!(app.history_idx, Some(0));
        assert_eq!(app.input, "third");
        // next → draft (idx=None)
        app.history_next();
        assert!(app.history_idx.is_none());
        assert_eq!(app.input, "fresh");
    }

    // ── Type-ahead queue ──────────────────────────────────────────

    #[test]
    fn queue_and_pop_submit() {
        let mut app = App::new();
        app.queue_submit("msg1".into());
        app.queue_submit("msg2".into());
        // First pop fires add_user_message → records user line + begins processing
        let popped = app.pop_pending_submit();
        assert_eq!(popped.as_deref(), Some("msg1"));
        assert!(app.is_processing);
        assert!(app.user_inputs.contains(&"msg1".to_string()));
        // Second pop
        // But is_processing is already true; pop_pending_submit doesn't
        // check is_processing — it just calls add_user_message again.
        let popped2 = app.pop_pending_submit();
        assert_eq!(popped2.as_deref(), Some("msg2"));
        // Queue is now empty
        assert!(app.pop_pending_submit().is_none());
    }

    #[test]
    fn pop_empty_queue_returns_none() {
        let mut app = App::new();
        assert!(app.pop_pending_submit().is_none());
        assert!(!app.is_processing);
    }

    #[test]
    fn clear_pending_submits_returns_count() {
        let mut app = App::new();
        app.queue_submit("a".into());
        app.queue_submit("b".into());
        app.queue_submit("c".into());
        let n = app.clear_pending_submits();
        assert_eq!(n, 3);
        assert!(app.pop_pending_submit().is_none());
    }

    #[test]
    fn clear_empty_queue_returns_zero() {
        let mut app = App::new();
        let n = app.clear_pending_submits();
        assert_eq!(n, 0);
    }

    // ── add_user_message / record_user_line ───────────────────────

    #[test]
    fn add_user_message_sets_processing() {
        let mut app = App::new();
        // App::new() already has splash_lines in pending_history
        let before = app.pending_history.len();
        app.add_user_message("hello");
        assert!(app.is_processing);
        assert_eq!(app.status, "thinking...");
        assert!(app.user_inputs.contains(&"hello".to_string()));
        assert_eq!(app.pending_history.len(), before + 1);
    }

    #[test]
    fn record_user_line_does_not_set_processing() {
        let mut app = App::new();
        let was_processing = app.is_processing;
        // App::new() already has splash_lines in pending_history
        let before = app.pending_history.len();
        app.record_user_line("typeahead");
        assert_eq!(app.is_processing, was_processing); // unchanged
        assert!(app.user_inputs.contains(&"typeahead".to_string()));
        assert_eq!(app.pending_history.len(), before + 1);
    }

    // ── Render functions ──────────────────────────────────────────

    #[test]
    fn render_user_lines_single_line() {
        let lines = render_user_lines("hello");
        assert!(!lines.is_empty());
        // First line should contain "❯ " and "hello"
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("❯"));
        assert!(text.contains("hello"));
    }

    #[test]
    fn render_user_lines_multiline() {
        let lines = render_user_lines("line1\nline2");
        assert_eq!(lines.len(), 2);
        let l0: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        let l1: String = lines[1].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(l0.contains("❯"));
        assert!(l0.contains("line1"));
        assert!(l1.contains("line2"));
        assert!(!l1.contains("❯"));
    }

    #[test]
    fn render_user_lines_empty() {
        let lines = render_user_lines("");
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("❯"));
    }

    #[test]
    fn render_system_lines_basic() {
        let lines = render_system_lines("note");
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("note"));
    }

    #[test]
    fn render_system_lines_multiline() {
        let lines = render_system_lines("a\nb\nc");
        assert_eq!(lines.len(), 3);
    }

    // ── Table parsing ─────────────────────────────────────────────

    #[test]
    fn parse_row_basic() {
        let row = parse_row("| a | b | c |");
        assert_eq!(row, vec!["a", "b", "c"]);
    }

    #[test]
    fn parse_row_whitespace() {
        let row = parse_row("|  hello  | world |");
        assert_eq!(row, vec!["hello", "world"]);
    }

    #[test]
    fn parse_row_no_bars() {
        let row = parse_row(" just text ");
        assert_eq!(row, vec!["just text"]);
    }

    #[test]
    fn parse_table_basic() {
        let lines = [
            "| Name | Age |",
            "|------|-----|",
            "| Alice | 30 |",
            "| Bob   | 25 |",
        ];
        let (header, data) = parse_table(&lines);
        assert_eq!(header, vec!["Name", "Age"]);
        assert_eq!(data.len(), 2);
        assert_eq!(data[0], vec!["Alice", "30"]);
        assert_eq!(data[1], vec!["Bob", "25"]);
    }

    #[test]
    fn parse_table_uneven_rows() {
        let lines = [
            "| A | B | C |",
            "|---|---|---|",
            "| 1 | 2 |",
            "| 3 | 4 | 5 | 6 |",
        ];
        let (header, data) = parse_table(&lines);
        assert_eq!(header, vec!["A", "B", "C"]);
        // Short row gets padded to 3
        assert_eq!(data[0], vec!["1", "2", ""]);
        // Long row gets truncated to 3
        assert_eq!(data[1], vec!["3", "4", "5"]);
    }

    // ── detect_table_at ───────────────────────────────────────────

    #[test]
    fn detect_table_valid() {
        let lines = [
            "| Col1 | Col2 |",
            "|------|------|",
            "| a    | b    |",
            "| c    | d    |",
            "plain text after",
        ];
        let end = detect_table_at(&lines, 0);
        assert_eq!(end, Some(4)); // header + sep + 2 data rows
    }

    #[test]
    fn detect_table_at_not_enough_lines() {
        let lines = ["| H |"];
        assert_eq!(detect_table_at(&lines, 0), None);
    }

    #[test]
    fn detect_table_no_pipe_start() {
        let lines = ["Not a table", "---|---"];
        assert_eq!(detect_table_at(&lines, 0), None);
    }

    #[test]
    fn detect_table_sep_missing_dash() {
        let lines = ["| H |", "|   |", "| a |"];
        assert_eq!(detect_table_at(&lines, 0), None);
    }

    #[test]
    fn detect_table_sep_has_non_table_chars() {
        let lines = ["| H |", "| -x- |", "| a |"];
        assert_eq!(detect_table_at(&lines, 0), None);
    }

    #[test]
    fn detect_table_not_starting_at_zero() {
        let lines = [
            "plain text",
            "| A | B |",
            "|---|---|",
            "| 1 | 2 |",
            "more plain",
        ];
        let end = detect_table_at(&lines, 1);
        assert_eq!(end, Some(4));
    }

    // ── push_diff_lines ───────────────────────────────────────────

    #[test]
    fn push_diff_lines_basic() {
        let mut out: Vec<Line<'static>> = Vec::new();
        push_diff_lines(&mut out, "  unchanged\n+ added\n- removed", 10, "  ");
        // Should have 3 content lines
        assert!(out.len() >= 3);
        // First line: "  unchanged" with dark gray / None style
        let l0: String = out[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(l0.contains("unchanged"));
        // Second line: "+ added" with green
        let l1: String = out[1].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(l1.contains("added"));
        // Third line: "- removed" with red
        let l2: String = out[2].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(l2.contains("removed"));
    }

    #[test]
    fn push_diff_lines_truncates() {
        let mut out: Vec<Line<'static>> = Vec::new();
        let diff = (0..20).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        push_diff_lines(&mut out, &diff, 5, "  ");
        // show = 5 lines + 1 truncation note = 6
        assert_eq!(out.len(), 6);
        let last: String = out[5].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(last.contains("more lines"));
    }

    #[test]
    fn push_diff_lines_empty() {
        let mut out: Vec<Line<'static>> = Vec::new();
        push_diff_lines(&mut out, "", 10, "  ");
        assert!(out.is_empty());
    }

    // ── splash_lines ──────────────────────────────────────────────

    #[test]
    fn splash_lines_has_expected_content() {
        let lines = splash_lines();
        assert!(!lines.is_empty());
        // At least one line should mention "kondi"
        let has_kondi = lines.iter().any(|line| {
            line.spans.iter().any(|s| s.content.contains("kondi"))
        });
        assert!(has_kondi || lines.len() > 5); // splash at minimum has logo lines
    }
}
