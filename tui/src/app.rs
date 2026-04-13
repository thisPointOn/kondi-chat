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

/// K logo: 24x22 pixels in 24x11 gap-free cells via half-blocks.
/// Each pixel fills its cell half completely — no dot spacing like
/// braille. The half-block technique uses fg for the top pixel and
/// bg for the bottom pixel of each cell row.
pub fn splash_lines() -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = vec![Line::from("")];
    for row in 0..SH {
        let mut spans: Vec<Span<'static>> = vec![Span::raw("  ")];
        for col in 0..SW {
            let (top, bot) = SPLASH_CELLS[row * SW + col];
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

// Half-block K logo: 24x22 pixels in 24x11 cells. Gap-free.
const SW: usize = 24;
const SH: usize = 11;

type SC = (Option<Color>, Option<Color>);
const SPLASH_CELLS: [SC; 264] = [
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(178,230,204))),(Some(Color::Rgb(225,242,236)),Some(Color::Rgb(116,198,167))),(Some(Color::Rgb(196,222,216)),Some(Color::Rgb(91,166,151))),(Some(Color::Rgb(237,243,242)),Some(Color::Rgb(229,237,236))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(215,231,234))),(None,Some(Color::Rgb(74,108,139))),(Some(Color::Rgb(212,216,224)),Some(Color::Rgb(48,64,103))),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(212,245,229)),Some(Color::Rgb(160,229,210))),(Some(Color::Rgb(141,221,182)),Some(Color::Rgb(103,202,190))),(Some(Color::Rgb(97,194,172)),Some(Color::Rgb(75,186,175))),(Some(Color::Rgb(136,202,190)),Some(Color::Rgb(175,221,217))),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(203,229,234))),(None,Some(Color::Rgb(93,173,187))),(Some(Color::Rgb(144,190,203)),Some(Color::Rgb(19,87,122))),(Some(Color::Rgb(29,81,119)),Some(Color::Rgb(39,62,106))),(Some(Color::Rgb(22,45,86)),Some(Color::Rgb(212,213,222))),(Some(Color::Rgb(210,211,216)),None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(225,246,243)),Some(Color::Rgb(164,217,219))),(Some(Color::Rgb(93,194,193)),Some(Color::Rgb(53,155,172))),(Some(Color::Rgb(70,177,183)),Some(Color::Rgb(50,143,162))),(Some(Color::Rgb(63,163,168)),Some(Color::Rgb(80,144,164))),(Some(Color::Rgb(215,235,236)),None),(None,Some(Color::Rgb(185,218,229))),(Some(Color::Rgb(234,238,244)),Some(Color::Rgb(108,206,212))),(Some(Color::Rgb(148,210,218)),Some(Color::Rgb(84,197,197))),(Some(Color::Rgb(80,183,190)),Some(Color::Rgb(39,122,147))),(Some(Color::Rgb(30,110,135)),Some(Color::Rgb(80,116,145))),(Some(Color::Rgb(57,92,126)),Some(Color::Rgb(231,233,238))),(Some(Color::Rgb(218,221,230)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,Some(Color::Rgb(206,224,230))),(Some(Color::Rgb(91,162,180)),Some(Color::Rgb(39,98,147))),(Some(Color::Rgb(44,121,155)),Some(Color::Rgb(35,77,136))),(Some(Color::Rgb(27,93,132)),Some(Color::Rgb(49,89,132))),(Some(Color::Rgb(103,130,163)),Some(Color::Rgb(144,209,213))),(Some(Color::Rgb(178,230,234)),Some(Color::Rgb(169,250,240))),(Some(Color::Rgb(121,228,221)),Some(Color::Rgb(92,190,201))),(Some(Color::Rgb(94,197,199)),Some(Color::Rgb(61,132,163))),(Some(Color::Rgb(40,118,152)),Some(Color::Rgb(168,188,205))),(Some(Color::Rgb(115,143,171)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(134,158,186)),Some(Color::Rgb(59,69,123))),(Some(Color::Rgb(18,40,116)),Some(Color::Rgb(35,68,116))),(Some(Color::Rgb(58,95,139)),Some(Color::Rgb(74,180,200))),(Some(Color::Rgb(106,206,212)),Some(Color::Rgb(89,206,222))),(Some(Color::Rgb(145,246,244)),Some(Color::Rgb(75,146,180))),(Some(Color::Rgb(82,176,201)),Some(Color::Rgb(22,52,75))),(Some(Color::Rgb(23,82,123)),Some(Color::Rgb(18,19,51))),(Some(Color::Rgb(78,92,133)),Some(Color::Rgb(24,63,124))),(None,Some(Color::Rgb(87,148,182))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(197,193,205)),Some(Color::Rgb(118,121,144))),(Some(Color::Rgb(19,35,89)),Some(Color::Rgb(21,56,140))),(Some(Color::Rgb(50,124,175)),Some(Color::Rgb(48,97,165))),(Some(Color::Rgb(60,154,193)),Some(Color::Rgb(11,35,75))),(Some(Color::Rgb(76,118,149)),Some(Color::Rgb(138,133,146))),(Some(Color::Rgb(196,197,206)),None),(Some(Color::Rgb(199,193,194)),None),(Some(Color::Rgb(22,23,67)),Some(Color::Rgb(186,187,206))),(Some(Color::Rgb(39,55,113)),Some(Color::Rgb(21,19,99))),(Some(Color::Rgb(39,105,156)),Some(Color::Rgb(62,80,154))),(Some(Color::Rgb(106,185,207)),Some(Color::Rgb(52,124,184))),(None,Some(Color::Rgb(127,200,227))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,Some(Color::Rgb(188,191,217))),(Some(Color::Rgb(55,68,139)),Some(Color::Rgb(15,20,97))),(Some(Color::Rgb(26,49,126)),Some(Color::Rgb(32,24,82))),(Some(Color::Rgb(25,30,79)),Some(Color::Rgb(20,12,95))),(Some(Color::Rgb(20,14,79)),Some(Color::Rgb(84,82,151))),(Some(Color::Rgb(215,215,226)),None),(None,None),(None,None),(None,None),(Some(Color::Rgb(160,161,194)),None),(Some(Color::Rgb(24,27,125)),Some(Color::Rgb(137,131,183))),(Some(Color::Rgb(70,113,188)),Some(Color::Rgb(32,45,149))),(Some(Color::Rgb(62,142,214)),Some(Color::Rgb(84,148,222))),(Some(Color::Rgb(141,202,241)),Some(Color::Rgb(76,152,234))),(None,Some(Color::Rgb(146,199,246))),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
    (None,None),(None,None),(None,Some(Color::Rgb(237,235,240))),(Some(Color::Rgb(112,106,154)),Some(Color::Rgb(51,21,89))),(Some(Color::Rgb(23,2,72)),Some(Color::Rgb(37,0,83))),(Some(Color::Rgb(48,24,103)),Some(Color::Rgb(37,0,90))),(Some(Color::Rgb(29,4,105)),Some(Color::Rgb(145,126,171))),(Some(Color::Rgb(192,186,214)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(134,115,186)),None),(Some(Color::Rgb(48,40,169)),Some(Color::Rgb(156,131,199))),(Some(Color::Rgb(103,128,227)),Some(Color::Rgb(61,26,175))),(Some(Color::Rgb(95,147,239)),Some(Color::Rgb(85,64,211))),(Some(Color::Rgb(146,196,248)),Some(Color::Rgb(82,105,230))),(None,Some(Color::Rgb(124,153,241))),(None,Some(Color::Rgb(228,234,254))),(None,None),(None,None),(None,None),
    (None,None),(None,None),(Some(Color::Rgb(184,173,195)),None),(Some(Color::Rgb(58,31,93)),None),(Some(Color::Rgb(105,79,135)),None),(Some(Color::Rgb(186,173,198)),None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(Some(Color::Rgb(211,199,230)),None),(Some(Color::Rgb(123,97,197)),None),(Some(Color::Rgb(91,60,189)),None),(Some(Color::Rgb(76,56,188)),Some(Color::Rgb(240,234,241))),(Some(Color::Rgb(120,111,209)),None),(Some(Color::Rgb(238,237,250)),None),(None,None),(None,None),
    (None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),(None,None),
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
