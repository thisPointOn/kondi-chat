use crate::protocol::{BackendEvent, GitInfo, MessageStats, ToolCallInfo};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use std::collections::VecDeque;
use std::time::Instant;

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
    pub git_info: Option<GitInfo>,
    /// Most recent completed assistant message body — used by Ctrl+Y to copy.
    pub last_assistant_content: Option<String>,
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
}

const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
            git_info: None,
            last_assistant_content: None,
            pending_submits: VecDeque::new(),
            available_models: vec![],
            clipboard: arboard::Clipboard::new().ok(),
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
            let mut lines: Vec<Line<'static>> = Vec::new();
            for (kind, text) in self.activity.drain(..) {
                if kind == "tool" { continue; }
                lines.push(Line::from(Span::styled(
                    format!("  {}", text),
                    Style::default().fg(Color::Yellow).add_modifier(Modifier::DIM),
                )));
            }
            lines.extend(render_assistant_lines(&msg));
            self.pending_history.push(lines);
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
                self.push_system(output);
                self.is_processing = false;
                self.status = String::new();
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
    let mut out = vec![Line::from("")];
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
    let mut out = vec![Line::from("")];
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

fn render_table(out: &mut Vec<Line<'static>>, table: &(Vec<String>, Vec<Vec<String>>)) {
    let (header, data) = table;
    let cols = header.len();
    if cols == 0 { return; }
    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for row in data {
        for (i, cell) in row.iter().enumerate() {
            let w = cell.chars().count();
            if w > widths[i] { widths[i] = w; }
        }
    }
    let pad = 1usize;
    let cell_widths: Vec<usize> = widths.iter().map(|w| w + pad * 2).collect();

    let header_style = Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD);
    let border_style = Style::default().fg(Color::DarkGray);
    let body_style = Style::default().fg(BODY);

    // Top border
    out.push(Line::from(Span::styled(
        format!("  {}", border_row(&cell_widths, '┌', '┬', '┐')),
        border_style,
    )));
    // Header row
    out.push(content_row(header, &widths, pad, header_style, border_style));
    // Separator
    out.push(Line::from(Span::styled(
        format!("  {}", border_row(&cell_widths, '├', '┼', '┤')),
        border_style,
    )));
    // Data rows
    for row in data {
        out.push(content_row(row, &widths, pad, body_style, border_style));
    }
    // Bottom border
    out.push(Line::from(Span::styled(
        format!("  {}", border_row(&cell_widths, '└', '┴', '┘')),
        border_style,
    )));
}

fn border_row(cell_widths: &[usize], left: char, mid: char, right: char) -> String {
    let mut s = String::new();
    s.push(left);
    for (i, w) in cell_widths.iter().enumerate() {
        for _ in 0..*w { s.push('─'); }
        s.push(if i + 1 == cell_widths.len() { right } else { mid });
    }
    s
}

fn content_row(
    cells: &[String],
    widths: &[usize],
    pad: usize,
    cell_style: Style,
    border_style: Style,
) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = vec![Span::raw("  ")];
    spans.push(Span::styled("│", border_style));
    for (i, cell) in cells.iter().enumerate() {
        let cell_chars = cell.chars().count();
        let extra = widths[i].saturating_sub(cell_chars);
        let mut content = " ".repeat(pad);
        content.push_str(cell);
        for _ in 0..extra { content.push(' '); }
        for _ in 0..pad { content.push(' '); }
        spans.push(Span::styled(content, cell_style));
        spans.push(Span::styled("│", border_style));
    }
    Line::from(spans)
}

pub fn render_assistant_lines(msg: &ChatMessage) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = vec![Line::from("")];

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

    for tc in &msg.tool_calls {
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

/// Splash screen: K braille logo + "kondi" inside a compact pink border.
pub fn splash_lines() -> Vec<Line<'static>> {
    let pink = Style::default().fg(PINK);
    let cyan = Color::Rgb(80, 200, 230);
    let text_row = BH / 2;

    // Inner width: 1 pad + 30 braille + "  kondi" (8) + 1 pad = 40.
    // The border chars add 2 more (║ on each side) but we don't count those.
    let inner = 40usize;

    let mut lines: Vec<Line<'static>> = vec![
        Line::from(""),
        // Top border
        Line::from(Span::styled(
            format!(" ╔{}╗", "═".repeat(inner)),
            pink,
        )),
    ];

    for row in 0..BH {
        let mut spans: Vec<Span<'static>> = vec![
            Span::styled(" ║ ", pink),
        ];
        for col in 0..BW {
            let (color, ch) = BRAILLE_CELLS[row * BW + col];
            match color {
                Some(c) => spans.push(Span::styled(ch, Style::default().fg(c))),
                None => spans.push(Span::raw(ch)),
            }
        }
        if row == text_row {
            spans.push(Span::styled(
                "  kondi",
                Style::default().fg(cyan).add_modifier(Modifier::BOLD),
            ));
        }
        // Right padding + border. Compute how many chars we've used inside.
        let used = 1 + BW + if row == text_row { 7 } else { 0 }; // " " + braille + maybe "  kondi"
        let pad = inner.saturating_sub(used);
        if pad > 0 {
            spans.push(Span::raw(" ".repeat(pad)));
        }
        spans.push(Span::styled("║", pink));
        lines.push(Line::from(spans));
    }

    // Bottom border
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
