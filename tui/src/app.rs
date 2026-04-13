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
    // Full-span rules: 120 cols covers any reasonable terminal width.
    let rule_style = Style::default().fg(Color::White);
    let rule_line = Line::from(Span::styled("─".repeat(120), rule_style));

    // "kondi" in large block letters beside the K logo. 5 rows tall to
    // roughly match the logo height. Each letter is ~6 cols wide.
    let big_text: [&str; 7] = [
        "                            ",
        " █  █  ████  █   █ ████  █  ",
        " █ █   █  █  ██  █ █  █  █  ",
        " ██    █  █  █ █ █ █  █  █  ",
        " █ █   █  █  █  ██ █  █  █  ",
        " █  █  ████  █   █ ████  █  ",
        "                            ",
    ];
    let text_start = BH / 2 - 3;

    let mut lines: Vec<Line<'static>> = vec![
        Line::from(""),
        rule_line.clone(),
    ];
    let cyan = Color::Rgb(80, 200, 230);
    for row in 0..BH {
        let mut spans: Vec<Span<'static>> = vec![Span::raw(" ")];
        for col in 0..BW {
            let (color, ch) = BRAILLE_CELLS[row * BW + col];
            match color {
                Some(c) => spans.push(Span::styled(ch, Style::default().fg(c))),
                None => spans.push(Span::raw(ch)),
            }
        }
        let text_row = row as isize - text_start as isize;
        if text_row >= 0 && (text_row as usize) < big_text.len() {
            spans.push(Span::styled(
                big_text[text_row as usize].to_string(),
                Style::default().fg(cyan).add_modifier(Modifier::BOLD),
            ));
        }
        lines.push(Line::from(spans));
    }
    lines.push(rule_line);
    lines.push(Line::from(""));
    lines
}

// Braille K logo: 80x68 pixels in 40x17 cells.
const BW: usize = 40;
const BH: usize = 17;

type BC = (Option<Color>, &'static str);
const BRAILLE_CELLS: [BC; 680] = [
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(191,236,218)),"\u{28E0}"),(Some(Color::Rgb(142,215,182)),"\u{28F4}"),(Some(Color::Rgb(141,210,180)),"\u{28FE}"),(Some(Color::Rgb(121,193,172)),"\u{28FF}"),(Some(Color::Rgb(105,174,159)),"\u{28FF}"),(Some(Color::Rgb(147,187,181)),"\u{287F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(132,161,182)),"\u{28C0}"),(Some(Color::Rgb(71,116,141)),"\u{28E4}"),(Some(Color::Rgb(49,80,118)),"\u{28F6}"),(Some(Color::Rgb(57,72,111)),"\u{28FF}"),(Some(Color::Rgb(140,139,153)),"\u{2846}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(161,233,210)),"\u{28F0}"),(Some(Color::Rgb(158,229,190)),"\u{28FF}"),(Some(Color::Rgb(137,216,186)),"\u{28FF}"),(Some(Color::Rgb(105,198,177)),"\u{28FF}"),(Some(Color::Rgb(100,192,173)),"\u{28FF}"),(Some(Color::Rgb(110,189,174)),"\u{28FF}"),(Some(Color::Rgb(214,234,230)),"\u{2803}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(200,218,226)),"\u{2880}"),(Some(Color::Rgb(102,166,184)),"\u{28E0}"),(Some(Color::Rgb(96,156,178)),"\u{28F6}"),(Some(Color::Rgb(72,126,152)),"\u{28FF}"),(Some(Color::Rgb(35,78,117)),"\u{28FF}"),(Some(Color::Rgb(27,52,93)),"\u{28FF}"),(Some(Color::Rgb(79,92,124)),"\u{287F}"),(Some(Color::Rgb(145,145,156)),"\u{280B}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(173,233,227)),"\u{28F0}"),(Some(Color::Rgb(130,214,198)),"\u{28FF}"),(Some(Color::Rgb(100,199,192)),"\u{28FF}"),(Some(Color::Rgb(86,191,186)),"\u{28FF}"),(Some(Color::Rgb(82,186,179)),"\u{28FF}"),(Some(Color::Rgb(77,179,174)),"\u{28FF}"),(Some(Color::Rgb(171,216,214)),"\u{284F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(175,208,221)),"\u{28C0}"),(Some(Color::Rgb(131,203,211)),"\u{28E4}"),(Some(Color::Rgb(117,188,199)),"\u{28FE}"),(Some(Color::Rgb(74,162,176)),"\u{28FF}"),(Some(Color::Rgb(51,124,150)),"\u{28FF}"),(Some(Color::Rgb(39,93,126)),"\u{28FF}"),(Some(Color::Rgb(41,72,113)),"\u{28FF}"),(Some(Color::Rgb(50,72,112)),"\u{281F}"),(Some(Color::Rgb(148,151,180)),"\u{2809}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(180,227,230)),"\u{28A0}"),(Some(Color::Rgb(106,195,194)),"\u{28FF}"),(Some(Color::Rgb(71,170,183)),"\u{28FF}"),(Some(Color::Rgb(62,164,176)),"\u{28FF}"),(Some(Color::Rgb(60,153,167)),"\u{28FF}"),(Some(Color::Rgb(57,147,161)),"\u{28FF}"),(Some(Color::Rgb(95,158,171)),"\u{287F}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(154,184,203)),"\u{28E0}"),(Some(Color::Rgb(111,190,208)),"\u{28F4}"),(Some(Color::Rgb(100,193,203)),"\u{28FE}"),(Some(Color::Rgb(92,197,200)),"\u{28FF}"),(Some(Color::Rgb(78,182,187)),"\u{28FF}"),(Some(Color::Rgb(60,145,164)),"\u{28FF}"),(Some(Color::Rgb(39,101,131)),"\u{28FF}"),(Some(Color::Rgb(53,98,127)),"\u{287F}"),(Some(Color::Rgb(106,127,158)),"\u{281F}"),(Some(Color::Rgb(169,176,203)),"\u{2801}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(230,240,246)),"\u{2880}"),(Some(Color::Rgb(94,171,183)),"\u{28FE}"),(Some(Color::Rgb(57,133,164)),"\u{28FF}"),(Some(Color::Rgb(48,124,156)),"\u{28FF}"),(Some(Color::Rgb(45,117,150)),"\u{28FF}"),(Some(Color::Rgb(42,108,142)),"\u{28FF}"),(Some(Color::Rgb(40,88,129)),"\u{28FF}"),(Some(Color::Rgb(151,185,204)),"\u{28E3}"),(Some(Color::Rgb(146,214,220)),"\u{28F6}"),(Some(Color::Rgb(135,217,220)),"\u{28FF}"),(Some(Color::Rgb(123,228,223)),"\u{28FF}"),(Some(Color::Rgb(108,210,206)),"\u{28FF}"),(Some(Color::Rgb(84,171,186)),"\u{28FF}"),(Some(Color::Rgb(57,142,168)),"\u{28FF}"),(Some(Color::Rgb(59,111,147)),"\u{28FF}"),(Some(Color::Rgb(56,101,136)),"\u{281F}"),(Some(Color::Rgb(143,158,186)),"\u{280B}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(113,153,180)),"\u{28FC}"),(Some(Color::Rgb(43,94,143)),"\u{28FF}"),(Some(Color::Rgb(39,82,143)),"\u{28FF}"),(Some(Color::Rgb(36,78,134)),"\u{28FF}"),(Some(Color::Rgb(46,87,132)),"\u{28FF}"),(Some(Color::Rgb(76,132,162)),"\u{28FF}"),(Some(Color::Rgb(131,201,210)),"\u{28FF}"),(Some(Color::Rgb(171,249,240)),"\u{28FF}"),(Some(Color::Rgb(155,236,230)),"\u{28FF}"),(Some(Color::Rgb(99,190,201)),"\u{28FF}"),(Some(Color::Rgb(66,162,183)),"\u{28FF}"),(Some(Color::Rgb(50,116,149)),"\u{28FF}"),(Some(Color::Rgb(85,141,168)),"\u{283F}"),(Some(Color::Rgb(98,116,153)),"\u{280B}"),(Some(Color::Rgb(236,237,242)),"\u{2801}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(121,143,172)),"\u{28B0}"),(Some(Color::Rgb(35,62,118)),"\u{28FF}"),(Some(Color::Rgb(32,44,115)),"\u{28FF}"),(Some(Color::Rgb(48,87,133)),"\u{28FF}"),(Some(Color::Rgb(69,136,167)),"\u{28FF}"),(Some(Color::Rgb(86,196,210)),"\u{28FF}"),(Some(Color::Rgb(103,217,222)),"\u{28FF}"),(Some(Color::Rgb(110,203,215)),"\u{28FF}"),(Some(Color::Rgb(85,174,200)),"\u{28FF}"),(Some(Color::Rgb(40,107,140)),"\u{28FF}"),(Some(Color::Rgb(31,75,100)),"\u{28FF}"),(Some(Color::Rgb(23,36,77)),"\u{28FF}"),(Some(Color::Rgb(30,50,111)),"\u{28FF}"),(Some(Color::Rgb(49,93,140)),"\u{28F7}"),(Some(Color::Rgb(120,159,190)),"\u{28E6}"),(Some(Color::Rgb(208,228,236)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(190,189,204)),"\u{28A0}"),(Some(Color::Rgb(48,51,100)),"\u{28FF}"),(Some(Color::Rgb(30,52,106)),"\u{28FF}"),(Some(Color::Rgb(45,102,150)),"\u{28FF}"),(Some(Color::Rgb(51,133,178)),"\u{28FF}"),(Some(Color::Rgb(61,158,191)),"\u{28FF}"),(Some(Color::Rgb(77,161,192)),"\u{28FF}"),(Some(Color::Rgb(83,129,160)),"\u{28FF}"),(Some(Color::Rgb(102,132,155)),"\u{283F}"),(Some(Color::Rgb(76,83,105)),"\u{280B}"),(Some(Color::Rgb(97,96,103)),"\u{283B}"),(Some(Color::Rgb(47,46,72)),"\u{28FF}"),(Some(Color::Rgb(22,25,73)),"\u{28FF}"),(Some(Color::Rgb(34,50,106)),"\u{28FF}"),(Some(Color::Rgb(45,82,135)),"\u{28FF}"),(Some(Color::Rgb(46,108,158)),"\u{28FF}"),(Some(Color::Rgb(78,164,193)),"\u{28FF}"),(Some(Color::Rgb(115,189,209)),"\u{28E6}"),(Some(Color::Rgb(192,226,235)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(244,242,240)),"\u{2880}"),(Some(Color::Rgb(68,71,101)),"\u{28FE}"),(Some(Color::Rgb(30,56,125)),"\u{28FF}"),(Some(Color::Rgb(38,70,154)),"\u{28FF}"),(Some(Color::Rgb(40,87,159)),"\u{28FF}"),(Some(Color::Rgb(32,69,121)),"\u{28FF}"),(Some(Color::Rgb(30,56,96)),"\u{28FF}"),(Some(Color::Rgb(25,25,57)),"\u{28FF}"),(Some(Color::Rgb(166,166,170)),"\u{2807}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(221,222,231)),"\u{2808}"),(Some(Color::Rgb(101,103,146)),"\u{283B}"),(Some(Color::Rgb(46,47,113)),"\u{28FF}"),(Some(Color::Rgb(35,35,120)),"\u{28FF}"),(Some(Color::Rgb(60,82,155)),"\u{28FF}"),(Some(Color::Rgb(61,105,171)),"\u{28FF}"),(Some(Color::Rgb(63,131,190)),"\u{28FF}"),(Some(Color::Rgb(92,181,218)),"\u{28FF}"),(Some(Color::Rgb(124,197,230)),"\u{28E6}"),(Some(Color::Rgb(191,226,244)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(112,119,161)),"\u{28FC}"),(Some(Color::Rgb(28,38,123)),"\u{28FF}"),(Some(Color::Rgb(28,42,113)),"\u{28FF}"),(Some(Color::Rgb(27,37,97)),"\u{28FF}"),(Some(Color::Rgb(24,20,75)),"\u{28FF}"),(Some(Color::Rgb(27,24,96)),"\u{28FF}"),(Some(Color::Rgb(25,23,99)),"\u{28FF}"),(Some(Color::Rgb(121,120,159)),"\u{284F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(175,176,204)),"\u{2808}"),(Some(Color::Rgb(76,77,144)),"\u{283B}"),(Some(Color::Rgb(46,46,133)),"\u{28FF}"),(Some(Color::Rgb(46,60,153)),"\u{28FF}"),(Some(Color::Rgb(65,119,191)),"\u{28FF}"),(Some(Color::Rgb(69,132,209)),"\u{28FF}"),(Some(Color::Rgb(79,150,224)),"\u{28FF}"),(Some(Color::Rgb(99,176,237)),"\u{28FF}"),(Some(Color::Rgb(127,190,244)),"\u{28E6}"),(Some(Color::Rgb(183,217,248)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(151,148,193)),"\u{28F0}"),(Some(Color::Rgb(30,26,99)),"\u{28FF}"),(Some(Color::Rgb(31,18,83)),"\u{28FF}"),(Some(Color::Rgb(35,17,89)),"\u{28FF}"),(Some(Color::Rgb(37,18,95)),"\u{28FF}"),(Some(Color::Rgb(39,22,110)),"\u{28FF}"),(Some(Color::Rgb(39,23,115)),"\u{28FF}"),(Some(Color::Rgb(121,115,172)),"\u{285F}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(130,124,177)),"\u{2808}"),(Some(Color::Rgb(74,60,149)),"\u{283B}"),(Some(Color::Rgb(62,47,156)),"\u{28FF}"),(Some(Color::Rgb(65,75,183)),"\u{28FF}"),(Some(Color::Rgb(80,122,215)),"\u{28FF}"),(Some(Color::Rgb(97,138,229)),"\u{28FF}"),(Some(Color::Rgb(103,150,234)),"\u{28FF}"),(Some(Color::Rgb(94,160,240)),"\u{28FF}"),(Some(Color::Rgb(112,176,245)),"\u{28E6}"),(Some(Color::Rgb(132,178,246)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(172,163,185)),"\u{28A0}"),(Some(Color::Rgb(57,35,97)),"\u{28FF}"),(Some(Color::Rgb(46,14,86)),"\u{28FF}"),(Some(Color::Rgb(48,14,92)),"\u{28FF}"),(Some(Color::Rgb(52,15,100)),"\u{28FF}"),(Some(Color::Rgb(52,16,101)),"\u{28FF}"),(Some(Color::Rgb(81,52,124)),"\u{287F}"),(Some(Color::Rgb(127,107,163)),"\u{280B}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(171,157,208)),"\u{2808}"),(Some(Color::Rgb(124,96,183)),"\u{283B}"),(Some(Color::Rgb(86,53,172)),"\u{28BF}"),(Some(Color::Rgb(70,42,181)),"\u{28FF}"),(Some(Color::Rgb(78,59,204)),"\u{28FF}"),(Some(Color::Rgb(102,93,220)),"\u{28FF}"),(Some(Color::Rgb(94,108,227)),"\u{28FF}"),(Some(Color::Rgb(90,126,235)),"\u{28FF}"),(Some(Color::Rgb(118,146,236)),"\u{28F7}"),(Some(Color::Rgb(139,160,241)),"\u{28E4}"),(Some(Color::Rgb(187,195,249)),"\u{2840}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(107,89,129)),"\u{283E}"),(Some(Color::Rgb(72,44,103)),"\u{283F}"),(Some(Color::Rgb(88,62,119)),"\u{283F}"),(Some(Color::Rgb(92,66,121)),"\u{281F}"),(Some(Color::Rgb(117,94,141)),"\u{281B}"),(Some(Color::Rgb(182,169,193)),"\u{2809}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(Some(Color::Rgb(187,173,220)),"\u{2809}"),(Some(Color::Rgb(136,109,199)),"\u{281B}"),(Some(Color::Rgb(105,75,185)),"\u{283B}"),(Some(Color::Rgb(99,73,189)),"\u{283F}"),(Some(Color::Rgb(83,53,182)),"\u{283F}"),(Some(Color::Rgb(84,55,181)),"\u{283F}"),(Some(Color::Rgb(96,76,189)),"\u{283F}"),(Some(Color::Rgb(106,96,203)),"\u{281F}"),(Some(Color::Rgb(174,170,230)),"\u{2803}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
    (None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),(None,"\u{2800}"),
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
