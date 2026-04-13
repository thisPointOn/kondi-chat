use crate::protocol::{BackendEvent, GitInfo, MessageStats, ToolCallInfo};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub content: String,
    pub model_label: Option<String>,
    pub tool_calls: Vec<ToolCallInfo>,
    pub stats: Option<MessageStats>,
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
    pub pending_history: Vec<Vec<Line<'static>>>,
    /// Bash-style input history.
    pub user_inputs: Vec<String>,
    pub history_idx: Option<usize>,
    pub history_draft: String,
    pub input: String,
    pub status: String,
    pub model: String,
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
            status: "Starting...".to_string(),
            model: "auto".to_string(),
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
    }

    /// Called when the user presses Enter. Renders the user line into
    /// pending_history (will land in terminal scrollback) and tracks it
    /// for input history recall.
    pub fn add_user_message(&mut self, text: &str) {
        self.user_inputs.push(text.to_string());
        let lines = render_user_lines(text);
        self.pending_history.push(lines);
        self.is_processing = true;
        self.activity.clear();
        self.status = "thinking...".to_string();
        self.start_time = Instant::now();
        self.history_idx = None;
        self.history_draft.clear();
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

    fn push_system(&mut self, text: String) {
        let lines = render_system_lines(&text);
        self.pending_history.push(lines);
    }

    pub fn handle_backend_event(&mut self, event: BackendEvent) {
        match event {
            BackendEvent::Ready { mode, status, git_info, resumed, resumed_session_id, resumed_message_count, .. } => {
                self.status = status;
                self.model = mode;
                self.git_info = git_info;
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
            BackendEvent::Message { id, role, content, model_label } => {
                if role == "assistant" {
                    self.messages.clear();
                    self.messages.push(ChatMessage {
                        id: id.clone(),
                        content,
                        model_label: model_label.clone(),
                        tool_calls: vec![],
                        stats: None,
                    });
                    if model_label.is_some() {
                        self.working_id = Some(id);
                    }
                } else if role == "system" {
                    self.push_system(content);
                }
            }
            BackendEvent::MessageUpdate { id, content, model_label, tool_calls, stats } => {
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == id) {
                    if let Some(c) = content { msg.content = c; }
                    if let Some(l) = model_label { msg.model_label = Some(l); }
                    if let Some(tc) = tool_calls { msg.tool_calls = tc; }
                    if let Some(s) = stats {
                        self.session_cost += s.cost_usd;
                        msg.stats = Some(s);
                        if let Some(ref label) = msg.model_label {
                            self.model = label.clone();
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
            BackendEvent::Status { text } => {
                self.status = text;
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

pub fn render_assistant_lines(msg: &ChatMessage) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = vec![Line::from("")];

    let label = msg.model_label.clone().unwrap_or_else(|| "assistant".to_string());
    out.push(Line::from(vec![
        Span::styled("● ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        Span::styled(label, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
    ]));

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
        for line in msg.content.lines() {
            out.push(Line::from(Span::styled(
                format!("  {}", line),
                Style::default().fg(BODY),
            )));
        }
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

/// K logo: 48x44 pixels packed into 24x22 cells via quarter-block
/// characters (2x2 pixels per cell). Same detail as the 48-wide
/// half-block version but half the screen footprint.
pub fn splash_lines() -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = vec![Line::from("")];
    for row in 0..QH {
        let mut spans: Vec<Span<'static>> = vec![Span::raw("  ")];
        for col in 0..QW {
            let (color, ch) = QUARTER_CELLS[row * QW + col];
            match color {
                Some(c) => spans.push(Span::styled(ch, Style::default().fg(c))),
                None => spans.push(Span::raw(ch)),
            }
        }
        lines.push(Line::from(spans));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  kondi",
        Style::default().fg(Color::Rgb(80, 200, 230)).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(""));
    lines
}

// Quarter-block K logo: 48x44 pixels in 24x22 cells.
const QW: usize = 24;
const QH: usize = 22;

type QC = (Option<Color>, &'static str);
const QUARTER_CELLS: [QC; 528] = [
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(196,230,220)),"\u{2584}"),(Some(Color::Rgb(143,195,182)),"\u{2584}"),(Some(Color::Rgb(196,217,214)),"\u{2596}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(182,185,199)),"\u{2584}"),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(168,226,200)),"\u{2588}"),(Some(Color::Rgb(121,199,169)),"\u{2588}"),(Some(Color::Rgb(95,168,153)),"\u{2588}"),(Some(Color::Rgb(188,211,208)),"\u{2598}"),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(172,196,208)),"\u{2584}"),(Some(Color::Rgb(80,115,142)),"\u{2588}"),(Some(Color::Rgb(39,56,97)),"\u{2588}"),(Some(Color::Rgb(235,234,234)),"\u{2598}"),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(188,238,219)),"\u{259F}"),(Some(Color::Rgb(151,224,187)),"\u{2588}"),(Some(Color::Rgb(103,196,175)),"\u{2588}"),(Some(Color::Rgb(127,198,184)),"\u{2588}"),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(210,228,232)),"\u{2597}"),(Some(Color::Rgb(97,157,178)),"\u{259F}"),(Some(Color::Rgb(40,91,126)),"\u{2588}"),(Some(Color::Rgb(34,55,95)),"\u{2588}"),(Some(Color::Rgb(96,99,121)),"\u{2598}"),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(154,226,207)),"\u{2588}"),(Some(Color::Rgb(100,200,190)),"\u{2588}"),(Some(Color::Rgb(87,191,179)),"\u{2588}"),(Some(Color::Rgb(147,208,203)),"\u{259B}"),(None," "),(None," "),(None," "),(Some(Color::Rgb(160,209,217)),"\u{2584}"),(Some(Color::Rgb(82,164,180)),"\u{2588}"),(Some(Color::Rgb(43,101,134)),"\u{2588}"),(Some(Color::Rgb(39,67,108)),"\u{2588}"),(Some(Color::Rgb(95,104,138)),"\u{2598}"),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(192,235,233)),"\u{2590}"),(Some(Color::Rgb(96,193,192)),"\u{2588}"),(Some(Color::Rgb(71,176,182)),"\u{2588}"),(Some(Color::Rgb(63,163,168)),"\u{2588}"),(Some(Color::Rgb(184,217,219)),"\u{258C}"),(None," "),(Some(Color::Rgb(190,210,224)),"\u{2597}"),(Some(Color::Rgb(143,206,215)),"\u{2588}"),(Some(Color::Rgb(78,176,185)),"\u{2588}"),(Some(Color::Rgb(50,122,145)),"\u{2588}"),(Some(Color::Rgb(51,92,125)),"\u{2588}"),(Some(Color::Rgb(116,127,163)),"\u{2598}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(133,204,205)),"\u{259F}"),(Some(Color::Rgb(61,157,175)),"\u{2588}"),(Some(Color::Rgb(56,145,163)),"\u{2588}"),(Some(Color::Rgb(66,135,156)),"\u{2588}"),(None," "),(Some(Color::Rgb(166,203,218)),"\u{259F}"),(Some(Color::Rgb(97,198,207)),"\u{2588}"),(Some(Color::Rgb(91,199,198)),"\u{2588}"),(Some(Color::Rgb(55,135,157)),"\u{2588}"),(Some(Color::Rgb(74,113,142)),"\u{2588}"),(Some(Color::Rgb(159,169,193)),"\u{2598}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(84,158,176)),"\u{2588}"),(Some(Color::Rgb(47,121,155)),"\u{2588}"),(Some(Color::Rgb(43,108,144)),"\u{2588}"),(Some(Color::Rgb(102,132,163)),"\u{2588}"),(Some(Color::Rgb(155,217,223)),"\u{2588}"),(Some(Color::Rgb(129,234,226)),"\u{2588}"),(Some(Color::Rgb(104,196,199)),"\u{2588}"),(Some(Color::Rgb(47,125,159)),"\u{2588}"),(Some(Color::Rgb(68,110,145)),"\u{259B}"),(Some(Color::Rgb(219,221,234)),"\u{2598}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(160,192,207)),"\u{2590}"),(Some(Color::Rgb(40,96,145)),"\u{2588}"),(Some(Color::Rgb(38,86,140)),"\u{2588}"),(Some(Color::Rgb(48,88,131)),"\u{2588}"),(Some(Color::Rgb(141,209,214)),"\u{2588}"),(Some(Color::Rgb(170,248,237)),"\u{2588}"),(Some(Color::Rgb(86,178,193)),"\u{2588}"),(Some(Color::Rgb(56,136,167)),"\u{2588}"),(Some(Color::Rgb(137,158,183)),"\u{259B}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(92,124,158)),"\u{259F}"),(Some(Color::Rgb(34,58,130)),"\u{2588}"),(Some(Color::Rgb(57,95,138)),"\u{2588}"),(Some(Color::Rgb(102,200,211)),"\u{2588}"),(Some(Color::Rgb(138,233,233)),"\u{2588}"),(Some(Color::Rgb(76,168,195)),"\u{2588}"),(Some(Color::Rgb(40,99,133)),"\u{2588}"),(Some(Color::Rgb(74,84,125)),"\u{2588}"),(Some(Color::Rgb(202,207,225)),"\u{2596}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(52,66,121)),"\u{2588}"),(Some(Color::Rgb(44,78,122)),"\u{2588}"),(Some(Color::Rgb(68,170,195)),"\u{2588}"),(Some(Color::Rgb(89,201,214)),"\u{2588}"),(Some(Color::Rgb(79,151,183)),"\u{2588}"),(Some(Color::Rgb(27,56,75)),"\u{2588}"),(Some(Color::Rgb(22,32,64)),"\u{2588}"),(Some(Color::Rgb(34,70,128)),"\u{2588}"),(Some(Color::Rgb(84,144,178)),"\u{2588}"),(Some(Color::Rgb(202,225,234)),"\u{2596}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(145,142,169)),"\u{2590}"),(Some(Color::Rgb(22,40,92)),"\u{2588}"),(Some(Color::Rgb(47,116,169)),"\u{2588}"),(Some(Color::Rgb(61,149,188)),"\u{2588}"),(Some(Color::Rgb(81,125,157)),"\u{2588}"),(Some(Color::Rgb(167,168,179)),"\u{259B}"),(Some(Color::Rgb(68,70,81)),"\u{259D}"),(Some(Color::Rgb(25,23,68)),"\u{2588}"),(Some(Color::Rgb(41,63,119)),"\u{2588}"),(Some(Color::Rgb(47,100,153)),"\u{2588}"),(Some(Color::Rgb(102,183,205)),"\u{2588}"),(Some(Color::Rgb(218,237,243)),"\u{2596}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(114,117,139)),"\u{2588}"),(Some(Color::Rgb(36,69,149)),"\u{2588}"),(Some(Color::Rgb(40,87,158)),"\u{2588}"),(Some(Color::Rgb(26,52,88)),"\u{2588}"),(Some(Color::Rgb(102,98,116)),"\u{259B}"),(None," "),(None," "),(Some(Color::Rgb(166,168,193)),"\u{259C}"),(Some(Color::Rgb(27,25,102)),"\u{2588}"),(Some(Color::Rgb(62,87,158)),"\u{2588}"),(Some(Color::Rgb(60,121,182)),"\u{2588}"),(Some(Color::Rgb(123,198,226)),"\u{2588}"),(Some(Color::Rgb(233,245,250)),"\u{2596}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(Some(Color::Rgb(230,231,234)),"\u{2597}"),(Some(Color::Rgb(45,57,129)),"\u{2588}"),(Some(Color::Rgb(32,56,129)),"\u{2588}"),(Some(Color::Rgb(23,26,75)),"\u{2588}"),(Some(Color::Rgb(21,20,88)),"\u{2588}"),(Some(Color::Rgb(179,178,196)),"\u{258C}"),(None," "),(None," "),(None," "),(Some(Color::Rgb(126,128,173)),"\u{259C}"),(Some(Color::Rgb(35,39,132)),"\u{2588}"),(Some(Color::Rgb(64,113,187)),"\u{2588}"),(Some(Color::Rgb(72,141,212)),"\u{2588}"),(Some(Color::Rgb(138,202,241)),"\u{2588}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(Some(Color::Rgb(124,129,177)),"\u{2590}"),(Some(Color::Rgb(22,26,100)),"\u{2588}"),(Some(Color::Rgb(27,19,83)),"\u{2588}"),(Some(Color::Rgb(32,26,105)),"\u{2588}"),(Some(Color::Rgb(76,72,142)),"\u{2588}"),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(92,88,157)),"\u{259C}"),(Some(Color::Rgb(48,59,157)),"\u{2588}"),(Some(Color::Rgb(78,145,220)),"\u{2588}"),(Some(Color::Rgb(81,146,230)),"\u{2588}"),(Some(Color::Rgb(113,182,244)),"\u{2599}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(Some(Color::Rgb(105,100,151)),"\u{2588}"),(Some(Color::Rgb(37,15,84)),"\u{2588}"),(Some(Color::Rgb(41,17,95)),"\u{2588}"),(Some(Color::Rgb(40,16,111)),"\u{2588}"),(Some(Color::Rgb(131,121,175)),"\u{258C}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(89,68,163)),"\u{259C}"),(Some(Color::Rgb(62,53,176)),"\u{2588}"),(Some(Color::Rgb(101,129,226)),"\u{2588}"),(Some(Color::Rgb(99,144,234)),"\u{2588}"),(Some(Color::Rgb(105,169,244)),"\u{2599}"),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(Some(Color::Rgb(212,207,219)),"\u{2597}"),(Some(Color::Rgb(50,22,88)),"\u{2588}"),(Some(Color::Rgb(51,16,94)),"\u{2588}"),(Some(Color::Rgb(49,12,100)),"\u{2588}"),(Some(Color::Rgb(100,75,137)),"\u{259B}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(120,90,181)),"\u{259C}"),(Some(Color::Rgb(67,36,179)),"\u{2588}"),(Some(Color::Rgb(90,75,216)),"\u{2588}"),(Some(Color::Rgb(100,120,233)),"\u{2588}"),(Some(Color::Rgb(122,151,238)),"\u{2588}"),(Some(Color::Rgb(186,201,251)),"\u{2596}"),(None," "),(None," "),(None," "),
    (None," "),(None," "),(Some(Color::Rgb(112,89,133)),"\u{2590}"),(Some(Color::Rgb(56,27,92)),"\u{2588}"),(Some(Color::Rgb(95,69,125)),"\u{2588}"),(Some(Color::Rgb(124,101,146)),"\u{2580}"),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(170,152,211)),"\u{2580}"),(Some(Color::Rgb(123,96,195)),"\u{2588}"),(Some(Color::Rgb(78,49,184)),"\u{2588}"),(Some(Color::Rgb(79,53,185)),"\u{2588}"),(Some(Color::Rgb(104,92,202)),"\u{2588}"),(Some(Color::Rgb(219,217,244)),"\u{258C}"),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(Some(Color::Rgb(240,238,244)),"\u{2580}"),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
    (None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),(None," "),
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
