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

/// K logo: 60x52 pixels in 30x13 braille cells. Slightly larger than
/// the previous 24x11 so the dots read as bigger pixels.
pub fn splash_lines() -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = vec![Line::from("")];
    for row in 0..BH {
        let mut spans: Vec<Span<'static>> = vec![Span::raw(" ")];
        for col in 0..BW {
            let (color, ch) = BRAILLE_CELLS[row * BW + col];
            match color {
                Some(c) => spans.push(Span::styled(ch, Style::default().fg(c))),
                None => spans.push(Span::raw(ch)),
            }
        }
        lines.push(Line::from(spans));
    }
    lines.push(Line::from(Span::styled(
        " kondi",
        Style::default().fg(Color::Rgb(80, 200, 230)).add_modifier(Modifier::BOLD),
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
