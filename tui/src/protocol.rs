/// JSON-RPC protocol between the Rust TUI and the Node.js backend.
/// Backend sends events, TUI sends commands.
use serde::{Deserialize, Serialize};

// ── Backend → TUI events ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum BackendEvent {
    #[serde(rename = "ready")]
    Ready {
        models: Vec<String>,
        mode: String,
        status: String,
        #[serde(default)]
        git_info: Option<GitInfo>,
    },

    #[serde(rename = "message")]
    Message { id: String, role: String, content: String, model_label: Option<String> },

    #[serde(rename = "message_update")]
    MessageUpdate {
        id: String,
        content: Option<String>,
        model_label: Option<String>,
        tool_calls: Option<Vec<ToolCallInfo>>,
        stats: Option<MessageStats>,
    },

    #[serde(rename = "tool_call")]
    ToolCall { name: String, args: String, is_error: bool },

    #[serde(rename = "status")]
    Status { text: String },

    #[serde(rename = "activity")]
    Activity { text: String, activity_type: String },

    #[serde(rename = "error")]
    Error { message: String },

    #[serde(rename = "command_result")]
    CommandResult { output: String },

    /// Spec 01 — ask the user to approve a tool call.
    #[serde(rename = "permission_request")]
    PermissionRequest {
        id: String,
        tool: String,
        args: String,
        summary: String,
        tier: String,
    },

    /// Spec 01 — backend gave up waiting on a pending permission.
    #[serde(rename = "permission_timeout")]
    PermissionTimeout { id: String, tool: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallInfo {
    pub name: String,
    pub args: String,
    #[serde(default)]
    pub result: Option<String>,
    pub is_error: bool,
    /// Spec 03 — unified diff produced by write_file / edit_file.
    #[serde(default)]
    pub diff: Option<String>,
}

/// Spec 02 — git snapshot the backend sends on `ready`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: String,
    pub dirty_count: u32,
    pub last_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStats {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub models: Vec<String>,
    pub provider: Option<String>,
    pub route_reason: Option<String>,
    pub iterations: u32,
}

// ── TUI → Backend commands ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TuiCommand {
    #[serde(rename = "submit")]
    Submit { text: String },

    #[serde(rename = "command")]
    Command { text: String },

    #[serde(rename = "quit")]
    Quit,

    /// Spec 01 — user decision on a pending permission request.
    #[serde(rename = "permission_response")]
    PermissionResponse { id: String, decision: String },
}
