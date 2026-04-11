use crate::protocol::{BackendEvent, GitInfo, MessageStats, ToolCallInfo};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub role: String, // "user", "assistant", "system"
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
    pub messages: Vec<ChatMessage>,
    pub input: String,
    pub status: String,
    pub model: String,
    pub is_processing: bool,
    pub chat_scroll: usize,
    /// Set by draw_chat each frame: (chat_area_y, chat_area_height, max_scroll).
    /// Lets the mouse handler in main.rs translate a click on the scrollbar
    /// column into a chat_scroll value.
    pub chat_scroll_meta: (u16, u16, usize),
    /// Bash-style input history. None = not recalling. Some(i) = walking back
    /// through past user messages (0 = most recent). history_draft preserves
    /// whatever the user was typing before they started recalling.
    pub history_idx: Option<usize>,
    pub history_draft: String,
    pub detail_scroll: usize,
    pub detail_view: Option<String>, // "tools", "stats", "message"
    pub show_activity: bool,
    pub activity: Vec<(String, String)>, // (type, text)
    /// ID of the message currently being built by the backend
    pub working_id: Option<String>,
    /// For spinner animation
    pub start_time: Instant,
    /// Total session cost
    pub session_cost: f64,
    /// Spec 01 — queue of pending permission prompts (oldest at front).
    pub pending_permissions: Vec<PermissionDialog>,
    /// Spec 02 — current git snapshot (None when not a git repo).
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
        Self {
            messages: vec![],
            input: String::new(),
            status: "Starting...".to_string(),
            model: "auto".to_string(),
            is_processing: false,
            chat_scroll: 0,
            chat_scroll_meta: (0, 0, 0),
            history_idx: None,
            history_draft: String::new(),
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

    /// Past user messages, newest first. Owned strings to avoid borrow
    /// conflicts when callers also need &mut self.
    fn user_history(&self) -> Vec<String> {
        self.messages.iter().rev()
            .filter(|m| m.role == "user")
            .map(|m| m.content.clone())
            .collect()
    }

    /// Bash-style: walk backwards through user history. On first press,
    /// stash whatever was being typed so Down can restore it.
    pub fn history_prev(&mut self) {
        let hist = self.user_history();
        if hist.is_empty() { return; }
        let next = match self.history_idx {
            None => {
                self.history_draft = self.input.clone();
                0
            }
            Some(i) => (i + 1).min(hist.len() - 1),
        };
        self.history_idx = Some(next);
        self.input = hist[next].clone();
    }

    /// Bash-style: walk forward. Past the most recent entry, restore the draft.
    pub fn history_next(&mut self) {
        let hist = self.user_history();
        if hist.is_empty() { return; }
        match self.history_idx {
            None => {}
            Some(0) => {
                self.history_idx = None;
                self.input = std::mem::take(&mut self.history_draft);
            }
            Some(i) => {
                let next = i - 1;
                self.history_idx = Some(next);
                self.input = hist[next].clone();
            }
        }
    }

    pub fn add_user_message(&mut self, text: &str) {
        self.messages.push(ChatMessage {
            id: format!("user-{}", self.messages.len()),
            role: "user".to_string(),
            content: text.to_string(),
            model_label: None,
            tool_calls: vec![],
            stats: None,
        });
        self.chat_scroll = 0;
        self.is_processing = true;
        self.activity.clear();
        self.status = "thinking...".to_string();
        self.start_time = Instant::now();
        // Reset history walk on send.
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

    pub fn handle_backend_event(&mut self, event: BackendEvent) {
        match event {
            BackendEvent::Ready { mode, status, git_info, resumed, resumed_session_id, resumed_message_count, .. } => {
                self.status = status;
                self.model = mode;
                self.git_info = git_info;
                if resumed {
                    let id = resumed_session_id.unwrap_or_default();
                    let count = resumed_message_count.unwrap_or(0);
                    self.messages.push(ChatMessage {
                        id: format!("sys-resume-{}", self.messages.len()),
                        role: "system".to_string(),
                        content: format!("Resumed session {} ({} messages).", id.chars().take(8).collect::<String>(), count),
                        model_label: None,
                        tool_calls: vec![],
                        stats: None,
                    });
                }
            }
            BackendEvent::Message { id, role, content, model_label } => {
                self.messages.push(ChatMessage {
                    id: id.clone(),
                    role,
                    content,
                    model_label: model_label.clone(),
                    tool_calls: vec![],
                    stats: None,
                });
                if model_label.is_some() {
                    self.working_id = Some(id);
                }
                self.chat_scroll = 0;
            }
            BackendEvent::MessageUpdate { id, content, model_label, tool_calls, stats } => {
                if let Some(msg) = self.messages.iter_mut().find(|m| m.id == id) {
                    if let Some(c) = content { msg.content = c; }
                    if let Some(l) = model_label { msg.model_label = Some(l); }
                    if let Some(tc) = tool_calls { msg.tool_calls = tc; }
                    if let Some(s) = stats {
                        self.session_cost += s.cost_usd;
                        msg.stats = Some(s);
                        // Message complete — update model label
                        if let Some(ref label) = msg.model_label {
                            self.model = label.clone();
                        }
                        self.is_processing = false;
                        self.working_id = None;
                        self.status = String::new();
                    }
                }
                self.chat_scroll = 0;
            }
            BackendEvent::ToolCall { name, args, is_error } => {
                // Add to working message's tool calls
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
                self.messages.push(ChatMessage {
                    id: format!("err-{}", self.messages.len()),
                    role: "system".to_string(),
                    content: format!("Error: {message}"),
                    model_label: None,
                    tool_calls: vec![],
                    stats: None,
                });
                self.is_processing = false;
                self.status = String::new();
            }
            BackendEvent::PermissionRequest { id, tool, args: _, summary, tier } => {
                self.pending_permissions.push(PermissionDialog { id, tool, summary, tier });
            }
            BackendEvent::PermissionTimeout { id, tool } => {
                self.pending_permissions.retain(|p| p.id != id);
                self.messages.push(ChatMessage {
                    id: format!("perm-timeout-{}", self.messages.len()),
                    role: "system".to_string(),
                    content: format!("Permission request for {tool} timed out and was denied"),
                    model_label: None,
                    tool_calls: vec![],
                    stats: None,
                });
            }
            BackendEvent::CommandResult { output } => {
                self.messages.push(ChatMessage {
                    id: format!("cmd-{}", self.messages.len()),
                    role: "system".to_string(),
                    content: output,
                    model_label: None,
                    tool_calls: vec![],
                    stats: None,
                });
            }
        }
    }
}
