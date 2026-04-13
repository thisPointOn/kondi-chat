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

/// K logo rendered from the actual source image at 48×44 pixels (half
/// the previous pixel size). 22 cell rows via the half-block technique.
pub fn splash_lines() -> Vec<Line<'static>> {
    const W: usize = 48;
    const CELL_ROWS: usize = 22;
    let mut lines: Vec<Line<'static>> = vec![Line::from("")];
    for cr in 0..CELL_ROWS {
        let mut spans: Vec<Span<'static>> = vec![Span::raw("  ")];
        for c in 0..W {
            let (top, bot) = PIXEL_PAIRS[cr * W + c];
            spans.push(match (top, bot) {
                (None, None) => Span::raw(" "),
                (Some(t), None) => Span::styled("\u{2580}", Style::default().fg(t)),
                (None, Some(b)) => Span::styled("\u{2584}", Style::default().fg(b)),
                (Some(t), Some(b)) => Span::styled("\u{2580}", Style::default().fg(t).bg(b)),
            });
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

type CP = (Option<Color>, Option<Color>);
const PIXEL_PAIRS: [CP; 1056] = [
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(217,240,234))),(None,Some(Color::Rgb(176,221,207))),(None,Some(Color::Rgb(155,206,191))),(None,Some(Color::Rgb(132,185,174))),(None,Some(Color::Rgb(196,217,214))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(180,185,200))),(None,Some(Color::Rgb(184,186,199))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(237,249,244)),Some(Color::Rgb(144,222,190))),(Some(Color::Rgb(151,218,193)),Some(Color::Rgb(141,217,173))),(Some(Color::Rgb(121,201,168)),Some(Color::Rgb(143,213,177))),(Some(Color::Rgb(113,192,161)),Some(Color::Rgb(109,191,171))),(Some(Color::Rgb(100,178,157)),Some(Color::Rgb(97,177,161))),(Some(Color::Rgb(79,147,136)),Some(Color::Rgb(107,171,159))),(Some(Color::Rgb(188,211,208)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(227,233,240))),(None,Some(Color::Rgb(117,160,176))),(Some(Color::Rgb(193,203,217)),Some(Color::Rgb(30,89,114))),(Some(Color::Rgb(76,108,138)),Some(Color::Rgb(23,62,102))),(Some(Color::Rgb(9,43,94)),Some(Color::Rgb(5,28,81))),(Some(Color::Rgb(16,26,71)),Some(Color::Rgb(126,127,143))),(Some(Color::Rgb(235,234,234)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(237,251,248))),(Some(Color::Rgb(177,234,214)),Some(Color::Rgb(150,230,196))),(Some(Color::Rgb(152,227,181)),Some(Color::Rgb(175,235,193))),(Some(Color::Rgb(165,228,188)),Some(Color::Rgb(115,207,186))),(Some(Color::Rgb(107,199,176)),Some(Color::Rgb(99,197,177))),(Some(Color::Rgb(103,192,173)),Some(Color::Rgb(103,198,177))),(Some(Color::Rgb(92,182,163)),Some(Color::Rgb(85,184,166))),(Some(Color::Rgb(143,201,189)),Some(Color::Rgb(191,225,220))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(210,228,232))),(None,Some(Color::Rgb(93,155,180))),(Some(Color::Rgb(161,193,207)),Some(Color::Rgb(38,125,149))),(Some(Color::Rgb(62,135,155)),Some(Color::Rgb(37,88,126))),(Some(Color::Rgb(31,92,120)),Some(Color::Rgb(33,49,106))),(Some(Color::Rgb(31,57,103)),Some(Color::Rgb(6,34,74))),(Some(Color::Rgb(7,31,77)),Some(Color::Rgb(92,99,126))),(Some(Color::Rgb(96,99,121)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(188,240,229)),Some(Color::Rgb(145,225,211))),(Some(Color::Rgb(154,229,195)),Some(Color::Rgb(131,212,196))),(Some(Color::Rgb(132,216,195)),Some(Color::Rgb(89,195,192))),(Some(Color::Rgb(93,196,187)),Some(Color::Rgb(89,194,187))),(Some(Color::Rgb(97,198,181)),Some(Color::Rgb(86,191,183))),(Some(Color::Rgb(91,194,179)),Some(Color::Rgb(74,183,176))),(Some(Color::Rgb(92,187,176)),Some(Color::Rgb(118,194,191))),(Some(Color::Rgb(233,244,243)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(204,230,235))),(None,Some(Color::Rgb(117,189,200))),(Some(Color::Rgb(151,200,209)),Some(Color::Rgb(60,157,176))),(Some(Color::Rgb(58,145,171)),Some(Color::Rgb(62,155,165))),(Some(Color::Rgb(49,138,159)),Some(Color::Rgb(46,99,132))),(Some(Color::Rgb(43,92,126)),Some(Color::Rgb(36,78,119))),(Some(Color::Rgb(33,57,109)),Some(Color::Rgb(12,54,89))),(Some(Color::Rgb(10,45,84)),Some(Color::Rgb(103,113,150))),(Some(Color::Rgb(95,104,138)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(217,244,243)),Some(Color::Rgb(167,227,223))),(Some(Color::Rgb(119,210,197)),Some(Color::Rgb(97,193,188))),(Some(Color::Rgb(97,194,195)),Some(Color::Rgb(71,176,188))),(Some(Color::Rgb(74,184,188)),Some(Color::Rgb(69,174,182))),(Some(Color::Rgb(77,182,184)),Some(Color::Rgb(66,166,175))),(Some(Color::Rgb(76,178,179)),Some(Color::Rgb(65,161,170))),(Some(Color::Rgb(58,165,166)),Some(Color::Rgb(54,149,158))),(Some(Color::Rgb(159,208,209)),Some(Color::Rgb(209,227,230))),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(190,210,224))),(Some(Color::Rgb(235,238,243)),Some(Color::Rgb(107,191,204))),(Some(Color::Rgb(152,211,220)),Some(Color::Rgb(81,187,194))),(Some(Color::Rgb(97,185,195)),Some(Color::Rgb(75,180,187))),(Some(Color::Rgb(72,169,184)),Some(Color::Rgb(68,170,175))),(Some(Color::Rgb(66,160,168)),Some(Color::Rgb(50,119,149))),(Some(Color::Rgb(46,106,137)),Some(Color::Rgb(38,103,129))),(Some(Color::Rgb(38,95,131)),Some(Color::Rgb(18,66,97))),(Some(Color::Rgb(15,63,97)),Some(Color::Rgb(135,146,178))),(Some(Color::Rgb(116,127,163)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(207,236,238))),(Some(Color::Rgb(116,203,200)),Some(Color::Rgb(78,173,179))),(Some(Color::Rgb(75,171,183)),Some(Color::Rgb(60,150,174))),(Some(Color::Rgb(58,161,178)),Some(Color::Rgb(53,147,168))),(Some(Color::Rgb(61,161,174)),Some(Color::Rgb(52,140,161))),(Some(Color::Rgb(59,149,165)),Some(Color::Rgb(54,132,155))),(Some(Color::Rgb(50,142,158)),Some(Color::Rgb(33,111,140))),(Some(Color::Rgb(71,140,157)),Some(Color::Rgb(110,147,172))),(None,None),(None,None),(None,Some(Color::Rgb(180,201,218))),(Some(Color::Rgb(230,228,235)),Some(Color::Rgb(90,180,202))),(Some(Color::Rgb(129,183,207)),Some(Color::Rgb(79,206,212))),(Some(Color::Rgb(73,185,200)),Some(Color::Rgb(108,218,211))),(Some(Color::Rgb(85,198,201)),Some(Color::Rgb(111,223,210))),(Some(Color::Rgb(87,198,197)),Some(Color::Rgb(82,179,186))),(Some(Color::Rgb(82,192,190)),Some(Color::Rgb(53,121,153))),(Some(Color::Rgb(59,136,164)),Some(Color::Rgb(29,92,123))),(Some(Color::Rgb(36,101,129)),Some(Color::Rgb(42,83,121))),(Some(Color::Rgb(27,71,104)),Some(Color::Rgb(191,198,217))),(Some(Color::Rgb(159,169,193)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(146,205,211)),Some(Color::Rgb(87,163,176))),(Some(Color::Rgb(56,145,164)),Some(Color::Rgb(48,120,156))),(Some(Color::Rgb(51,130,163)),Some(Color::Rgb(46,114,154))),(Some(Color::Rgb(50,130,158)),Some(Color::Rgb(44,110,148))),(Some(Color::Rgb(47,119,150)),Some(Color::Rgb(42,103,143))),(Some(Color::Rgb(47,113,146)),Some(Color::Rgb(37,100,137))),(Some(Color::Rgb(25,85,126)),Some(Color::Rgb(32,67,115))),(Some(Color::Rgb(183,192,208)),Some(Color::Rgb(168,185,206))),(Some(Color::Rgb(229,233,240)),Some(Color::Rgb(133,211,219))),(Some(Color::Rgb(130,186,207)),Some(Color::Rgb(131,240,228))),(Some(Color::Rgb(95,208,216)),Some(Color::Rgb(158,250,235))),(Some(Color::Rgb(113,233,223)),Some(Color::Rgb(151,246,230))),(Some(Color::Rgb(132,238,222)),Some(Color::Rgb(107,201,199))),(Some(Color::Rgb(124,224,212)),Some(Color::Rgb(54,124,163))),(Some(Color::Rgb(72,151,175)),Some(Color::Rgb(44,129,166))),(Some(Color::Rgb(44,111,152)),Some(Color::Rgb(31,112,144))),(Some(Color::Rgb(25,95,128)),Some(Color::Rgb(112,133,167))),(Some(Color::Rgb(68,103,141)),None),(Some(Color::Rgb(219,221,234)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(195,219,227)),Some(Color::Rgb(125,166,187))),(Some(Color::Rgb(46,120,147)),Some(Color::Rgb(29,85,135))),(Some(Color::Rgb(46,100,154)),Some(Color::Rgb(41,80,147))),(Some(Color::Rgb(41,96,146)),Some(Color::Rgb(40,84,142))),(Some(Color::Rgb(40,94,142)),Some(Color::Rgb(31,72,130))),(Some(Color::Rgb(37,92,136)),Some(Color::Rgb(32,56,111))),(Some(Color::Rgb(21,55,108)),Some(Color::Rgb(104,150,172))),(Some(Color::Rgb(85,113,150)),Some(Color::Rgb(151,243,237))),(Some(Color::Rgb(149,229,226)),Some(Color::Rgb(181,253,244))),(Some(Color::Rgb(175,254,236)),Some(Color::Rgb(191,253,247))),(Some(Color::Rgb(184,251,241)),Some(Color::Rgb(132,234,226))),(Some(Color::Rgb(148,242,232)),Some(Color::Rgb(63,155,176))),(Some(Color::Rgb(83,173,186)),Some(Color::Rgb(52,145,178))),(Some(Color::Rgb(45,123,162)),Some(Color::Rgb(58,159,182))),(Some(Color::Rgb(41,142,168)),Some(Color::Rgb(81,123,158))),(Some(Color::Rgb(44,109,141)),Some(Color::Rgb(206,201,217))),(Some(Color::Rgb(161,166,192)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(190,204,217))),(Some(Color::Rgb(62,107,144)),Some(Color::Rgb(25,62,115))),(Some(Color::Rgb(32,64,133)),Some(Color::Rgb(40,59,133))),(Some(Color::Rgb(40,71,141)),Some(Color::Rgb(27,39,115))),(Some(Color::Rgb(28,53,123)),Some(Color::Rgb(53,81,124))),(Some(Color::Rgb(45,69,119)),Some(Color::Rgb(102,179,187))),(Some(Color::Rgb(106,173,185)),Some(Color::Rgb(81,189,209))),(Some(Color::Rgb(112,213,223)),Some(Color::Rgb(109,226,228))),(Some(Color::Rgb(138,235,233)),Some(Color::Rgb(133,247,240))),(Some(Color::Rgb(169,255,248)),Some(Color::Rgb(115,198,211))),(Some(Color::Rgb(130,223,222)),Some(Color::Rgb(63,148,188))),(Some(Color::Rgb(64,153,181)),Some(Color::Rgb(47,149,191))),(Some(Color::Rgb(54,158,190)),Some(Color::Rgb(35,86,116))),(Some(Color::Rgb(53,138,162)),Some(Color::Rgb(20,15,67))),(Some(Color::Rgb(23,33,74)),Some(Color::Rgb(26,47,109))),(Some(Color::Rgb(206,196,208)),Some(Color::Rgb(42,62,111))),(None,Some(Color::Rgb(202,207,225))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(114,138,165)),Some(Color::Rgb(52,70,123))),(Some(Color::Rgb(20,39,109)),Some(Color::Rgb(22,17,90))),(Some(Color::Rgb(30,28,104)),Some(Color::Rgb(36,67,101))),(Some(Color::Rgb(47,79,116)),Some(Color::Rgb(63,140,167))),(Some(Color::Rgb(83,163,178)),Some(Color::Rgb(54,148,190))),(Some(Color::Rgb(62,165,198)),Some(Color::Rgb(76,205,217))),(Some(Color::Rgb(89,222,227)),Some(Color::Rgb(74,189,205))),(Some(Color::Rgb(101,224,225)),Some(Color::Rgb(92,170,202))),(Some(Color::Rgb(99,174,199)),Some(Color::Rgb(95,165,197))),(Some(Color::Rgb(70,161,200)),Some(Color::Rgb(52,104,138))),(Some(Color::Rgb(34,124,163)),Some(Color::Rgb(49,50,64))),(Some(Color::Rgb(25,51,71)),Some(Color::Rgb(1,0,4))),(Some(Color::Rgb(15,20,41)),Some(Color::Rgb(22,23,49))),(Some(Color::Rgb(24,29,75)),Some(Color::Rgb(29,59,92))),(Some(Color::Rgb(36,60,129)),Some(Color::Rgb(29,44,96))),(Some(Color::Rgb(34,105,154)),Some(Color::Rgb(38,71,135))),(Some(Color::Rgb(39,90,139)),Some(Color::Rgb(47,134,171))),(Some(Color::Rgb(199,216,230)),Some(Color::Rgb(52,138,173))),(None,Some(Color::Rgb(202,225,234))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(185,188,207)),Some(Color::Rgb(105,96,131))),(Some(Color::Rgb(14,8,75)),Some(Color::Rgb(5,14,56))),(Some(Color::Rgb(29,49,88)),Some(Color::Rgb(41,91,149))),(Some(Color::Rgb(48,114,156)),Some(Color::Rgb(44,97,168))),(Some(Color::Rgb(49,123,179)),Some(Color::Rgb(49,130,174))),(Some(Color::Rgb(61,174,196)),Some(Color::Rgb(47,120,174))),(Some(Color::Rgb(56,147,184)),Some(Color::Rgb(82,157,199))),(Some(Color::Rgb(93,163,205)),Some(Color::Rgb(55,103,132))),(Some(Color::Rgb(83,140,175)),Some(Color::Rgb(93,97,116))),(Some(Color::Rgb(64,80,109)),Some(Color::Rgb(241,236,235))),(Some(Color::Rgb(196,188,193)),None),(None,None),(Some(Color::Rgb(68,70,81)),None),(Some(Color::Rgb(3,1,35)),Some(Color::Rgb(64,65,106))),(Some(Color::Rgb(25,19,69)),Some(Color::Rgb(9,7,62))),(Some(Color::Rgb(43,77,123)),Some(Color::Rgb(29,19,89))),(Some(Color::Rgb(37,65,116)),Some(Color::Rgb(58,92,148))),(Some(Color::Rgb(40,79,142)),Some(Color::Rgb(50,83,134))),(Some(Color::Rgb(56,154,186)),Some(Color::Rgb(43,87,152))),(Some(Color::Rgb(64,162,188)),Some(Color::Rgb(64,169,198))),(Some(Color::Rgb(209,232,238)),Some(Color::Rgb(74,172,198))),(None,Some(Color::Rgb(218,237,243))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(240,237,240)),Some(Color::Rgb(172,169,171))),(Some(Color::Rgb(33,31,58)),Some(Color::Rgb(12,34,88))),(Some(Color::Rgb(26,63,128)),Some(Color::Rgb(40,68,157))),(Some(Color::Rgb(41,78,161)),Some(Color::Rgb(39,70,153))),(Some(Color::Rgb(43,93,160)),Some(Color::Rgb(43,84,172))),(Some(Color::Rgb(42,94,169)),Some(Color::Rgb(33,80,132))),(Some(Color::Rgb(45,115,163)),Some(Color::Rgb(21,30,60))),(Some(Color::Rgb(31,65,88)),Some(Color::Rgb(7,0,42))),(Some(Color::Rgb(7,0,24)),Some(Color::Rgb(71,69,98))),(Some(Color::Rgb(228,227,226)),None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(234,234,240)),None),(Some(Color::Rgb(50,53,111)),Some(Color::Rgb(216,217,228))),(Some(Color::Rgb(17,15,85)),Some(Color::Rgb(35,39,111))),(Some(Color::Rgb(33,23,110)),Some(Color::Rgb(25,26,105))),(Some(Color::Rgb(73,106,167)),Some(Color::Rgb(38,32,130))),(Some(Color::Rgb(60,95,154)),Some(Color::Rgb(79,115,182))),(Some(Color::Rgb(47,96,165)),Some(Color::Rgb(64,104,172))),(Some(Color::Rgb(70,178,210)),Some(Color::Rgb(59,109,182))),(Some(Color::Rgb(87,180,212)),Some(Color::Rgb(78,185,223))),(Some(Color::Rgb(227,241,247)),Some(Color::Rgb(100,186,224))),(None,Some(Color::Rgb(233,245,250))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(230,231,234))),(Some(Color::Rgb(94,101,133)),Some(Color::Rgb(37,49,121))),(Some(Color::Rgb(20,38,130)),Some(Color::Rgb(31,40,135))),(Some(Color::Rgb(40,59,147)),Some(Color::Rgb(33,58,137))),(Some(Color::Rgb(38,74,159)),Some(Color::Rgb(20,34,75))),(Some(Color::Rgb(26,56,100)),Some(Color::Rgb(21,11,59))),(Some(Color::Rgb(19,15,51)),Some(Color::Rgb(27,23,90))),(Some(Color::Rgb(28,23,83)),Some(Color::Rgb(26,27,102))),(Some(Color::Rgb(7,6,73)),Some(Color::Rgb(26,25,96))),(Some(Color::Rgb(140,139,164)),Some(Color::Rgb(218,218,229))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(192,193,213)),None),(Some(Color::Rgb(24,27,112)),Some(Color::Rgb(164,164,196))),(Some(Color::Rgb(33,37,124)),Some(Color::Rgb(22,25,118))),(Some(Color::Rgb(44,49,146)),Some(Color::Rgb(41,48,140))),(Some(Color::Rgb(75,127,195)),Some(Color::Rgb(50,75,161))),(Some(Color::Rgb(62,109,187)),Some(Color::Rgb(72,143,206))),(Some(Color::Rgb(69,124,200)),Some(Color::Rgb(64,118,201))),(Some(Color::Rgb(81,186,232)),Some(Color::Rgb(77,136,217))),(Some(Color::Rgb(111,190,233)),Some(Color::Rgb(80,180,239))),(Some(Color::Rgb(240,248,252)),Some(Color::Rgb(121,190,241))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(160,168,196)),Some(Color::Rgb(88,91,158))),(Some(Color::Rgb(16,22,116)),Some(Color::Rgb(16,21,98))),(Some(Color::Rgb(31,43,116)),Some(Color::Rgb(26,19,70))),(Some(Color::Rgb(20,22,67)),Some(Color::Rgb(31,17,90))),(Some(Color::Rgb(26,16,80)),Some(Color::Rgb(34,22,95))),(Some(Color::Rgb(30,24,94)),Some(Color::Rgb(33,24,102))),(Some(Color::Rgb(31,29,107)),Some(Color::Rgb(37,30,117))),(Some(Color::Rgb(18,15,103)),Some(Color::Rgb(21,12,109))),(Some(Color::Rgb(88,86,146)),Some(Color::Rgb(180,178,210))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(137,135,179)),None),(Some(Color::Rgb(22,19,123)),Some(Color::Rgb(119,110,169))),(Some(Color::Rgb(48,56,151)),Some(Color::Rgb(29,18,133))),(Some(Color::Rgb(61,105,183)),Some(Color::Rgb(54,58,162))),(Some(Color::Rgb(79,163,225)),Some(Color::Rgb(71,114,199))),(Some(Color::Rgb(74,131,218)),Some(Color::Rgb(91,175,239))),(Some(Color::Rgb(79,134,225)),Some(Color::Rgb(88,147,228))),(Some(Color::Rgb(81,173,242)),Some(Color::Rgb(78,131,228))),(Some(Color::Rgb(129,190,245)),Some(Color::Rgb(79,167,243))),(None,Some(Color::Rgb(132,191,246))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(225,224,239)),Some(Color::Rgb(150,147,189))),(Some(Color::Rgb(33,31,112)),Some(Color::Rgb(15,0,64))),(Some(Color::Rgb(25,14,69)),Some(Color::Rgb(44,17,89))),(Some(Color::Rgb(37,17,92)),Some(Color::Rgb(42,15,88))),(Some(Color::Rgb(37,18,91)),Some(Color::Rgb(43,14,89))),(Some(Color::Rgb(38,18,95)),Some(Color::Rgb(46,18,105))),(Some(Color::Rgb(42,25,114)),Some(Color::Rgb(51,22,115))),(Some(Color::Rgb(32,14,110)),Some(Color::Rgb(35,4,105))),(Some(Color::Rgb(72,58,138)),Some(Color::Rgb(191,184,212))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(112,95,170)),None),(Some(Color::Rgb(39,17,143)),Some(Color::Rgb(118,93,177))),(Some(Color::Rgb(61,56,175)),Some(Color::Rgb(47,11,150))),(Some(Color::Rgb(72,99,204)),Some(Color::Rgb(68,48,177))),(Some(Color::Rgb(109,169,240)),Some(Color::Rgb(67,71,200))),(Some(Color::Rgb(123,161,235)),Some(Color::Rgb(105,115,230))),(Some(Color::Rgb(80,128,228)),Some(Color::Rgb(143,150,235))),(Some(Color::Rgb(73,159,242)),Some(Color::Rgb(100,140,233))),(Some(Color::Rgb(132,190,247)),Some(Color::Rgb(65,142,239))),(None,Some(Color::Rgb(120,175,246))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(212,207,219))),(Some(Color::Rgb(77,61,115)),Some(Color::Rgb(41,9,77))),(Some(Color::Rgb(34,3,76)),Some(Color::Rgb(50,16,86))),(Some(Color::Rgb(47,16,86)),Some(Color::Rgb(53,18,96))),(Some(Color::Rgb(47,13,88)),Some(Color::Rgb(57,20,108))),(Some(Color::Rgb(53,18,104)),Some(Color::Rgb(51,10,103))),(Some(Color::Rgb(57,22,112)),Some(Color::Rgb(37,0,84))),(Some(Color::Rgb(34,0,91)),Some(Color::Rgb(129,108,153))),(Some(Color::Rgb(138,119,167)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(137,111,188)),None),(Some(Color::Rgb(53,8,149)),Some(Color::Rgb(170,152,207))),(Some(Color::Rgb(71,42,182)),Some(Color::Rgb(70,24,158))),(Some(Color::Rgb(67,58,204)),Some(Color::Rgb(63,23,174))),(Some(Color::Rgb(84,72,220)),Some(Color::Rgb(70,50,197))),(Some(Color::Rgb(135,128,236)),Some(Color::Rgb(71,53,212))),(Some(Color::Rgb(120,145,238)),Some(Color::Rgb(99,85,224))),(Some(Color::Rgb(72,130,237)),Some(Color::Rgb(109,120,233))),(Some(Color::Rgb(98,141,237)),Some(Color::Rgb(85,119,233))),(Some(Color::Rgb(220,228,251)),Some(Color::Rgb(85,119,232))),(None,Some(Color::Rgb(186,201,251))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(130,110,149)),Some(Color::Rgb(94,69,117))),(Some(Color::Rgb(26,0,69)),Some(Color::Rgb(66,38,97))),(Some(Color::Rgb(45,9,92)),Some(Color::Rgb(88,64,113))),(Some(Color::Rgb(39,0,89)),Some(Color::Rgb(122,104,139))),(Some(Color::Rgb(40,1,83)),Some(Color::Rgb(182,171,191))),(Some(Color::Rgb(73,40,105)),None),(Some(Color::Rgb(176,162,187)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(219,213,235)),None),(Some(Color::Rgb(122,91,188)),None),(Some(Color::Rgb(68,24,171)),Some(Color::Rgb(217,209,236))),(Some(Color::Rgb(55,21,172)),Some(Color::Rgb(152,130,202))),(Some(Color::Rgb(56,28,185)),Some(Color::Rgb(107,78,184))),(Some(Color::Rgb(66,36,197)),Some(Color::Rgb(85,54,173))),(Some(Color::Rgb(82,59,206)),Some(Color::Rgb(75,40,162))),(Some(Color::Rgb(81,74,211)),Some(Color::Rgb(80,42,162))),(Some(Color::Rgb(72,77,219)),Some(Color::Rgb(98,63,169))),(Some(Color::Rgb(110,113,223)),Some(Color::Rgb(139,118,199))),(Some(Color::Rgb(214,213,244)),Some(Color::Rgb(225,222,244))),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(239,236,244)),None),(Some(Color::Rgb(241,240,244)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
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
