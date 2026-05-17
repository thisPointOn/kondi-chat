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
        #[serde(default)]
        resumed: bool,
        #[serde(default)]
        resumed_session_id: Option<String>,
        #[serde(default)]
        resumed_message_count: Option<u32>,
    },

    #[serde(rename = "message")]
    Message {
        id: String,
        role: String,
        content: String,
        model_label: Option<String>,
        #[serde(default)]
        reasoning_content: Option<String>,
    },

    #[serde(rename = "message_update")]
    MessageUpdate {
        id: String,
        content: Option<String>,
        model_label: Option<String>,
        tool_calls: Option<Vec<ToolCallInfo>>,
        stats: Option<MessageStats>,
        #[serde(default)]
        reasoning_content: Option<String>,
    },

    #[serde(rename = "tool_call")]
    ToolCall { name: String, args: String, is_error: bool },

    #[serde(rename = "status")]
    Status { text: String, git_info: Option<GitInfo> },

    #[serde(rename = "activity")]
    Activity { text: String, activity_type: String },

    #[serde(rename = "error")]
    Error { message: String },

    #[serde(rename = "command_result")]
    CommandResult { output: String },

    /// Backend tells the TUI the routing state changed so the bottom
    /// indicator can update without waiting for the next turn. `label`
    /// is what to display — a model alias when pinned, or a profile
    /// name when the router is doing its job. `pinned` tells the TUI
    /// which label style to use: "routing disabled → @<alias>" vs.
    /// "routing: <profile>".
    #[serde(rename = "model_override")]
    ModelOverride {
        label: String,
        #[serde(default)]
        pinned: bool,
    },

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

    /// Key-setup wizard — ask the user to pick from a list (`step: "select"`)
    /// or type a value (`step: "input"`, optionally `masked`).
    #[serde(rename = "wizard_prompt")]
    WizardPrompt {
        id: String,
        step: String,
        title: String,
        #[serde(default)]
        options: Vec<String>,
        #[serde(default)]
        masked: bool,
        #[serde(default)]
        hint: String,
    },

    /// Key-setup wizard finished — dismiss the modal, show a closing note.
    #[serde(rename = "wizard_done")]
    WizardDone { message: String },
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

    /// User response to a wizard_prompt. For a "select" step `value` is the
    /// zero-based option index; for "input" it's the typed text.
    #[serde(rename = "wizard_response")]
    WizardResponse {
        id: String,
        value: String,
        #[serde(default)]
        cancelled: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Struct roundtrips ──────────────────────────────────────────

    #[test]
    fn tool_call_info_roundtrip() {
        let t = ToolCallInfo {
            name: "write_file".into(),
            args: r#"{"path":"x"}"#.into(),
            result: Some("ok".into()),
            is_error: false,
            diff: Some("@@ -1 +1 @@".into()),
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: ToolCallInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "write_file");
        assert_eq!(back.args, r#"{"path":"x"}"#);
        assert_eq!(back.result.as_deref(), Some("ok"));
        assert!(!back.is_error);
        assert_eq!(back.diff.as_deref(), Some("@@ -1 +1 @@"));
    }

    #[test]
    fn tool_call_info_defaults() {
        let json = r#"{"name":"ls","args":"-la","is_error":false}"#;
        let t: ToolCallInfo = serde_json::from_str(json).unwrap();
        assert_eq!(t.name, "ls");
        assert_eq!(t.args, "-la");
        assert!(t.result.is_none());
        assert!(t.diff.is_none());
    }

    #[test]
    fn git_info_roundtrip() {
        let g = GitInfo {
            branch: "main".into(),
            dirty_count: 3,
            last_commit: "abc123".into(),
        };
        let json = serde_json::to_string(&g).unwrap();
        let back: GitInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.branch, "main");
        assert_eq!(back.dirty_count, 3);
        assert_eq!(back.last_commit, "abc123");
    }

    #[test]
    fn message_stats_roundtrip() {
        let s = MessageStats {
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.003,
            models: vec!["opus".into()],
            provider: Some("anthropic".into()),
            route_reason: Some("quality".into()),
            iterations: 1,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: MessageStats = serde_json::from_str(&json).unwrap();
        assert_eq!(back.input_tokens, 100);
        assert_eq!(back.output_tokens, 50);
        assert!((back.cost_usd - 0.003).abs() < 1e-10);
        assert_eq!(back.models, vec!["opus"]);
        assert_eq!(back.provider.as_deref(), Some("anthropic"));
        assert_eq!(back.route_reason.as_deref(), Some("quality"));
        assert_eq!(back.iterations, 1);
    }

    // ── BackendEvent roundtrips ────────────────────────────────────

    #[test]
    fn backend_event_ready_roundtrip() {
        let ev = BackendEvent::Ready {
            models: vec!["opus".into()],
            mode: "quality".into(),
            status: "idle".into(),
            git_info: None,
            resumed: false,
            resumed_session_id: None,
            resumed_message_count: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::Ready { .. }));
        if let BackendEvent::Ready { models, mode, status, resumed, .. } = back {
            assert_eq!(models, vec!["opus"]);
            assert_eq!(mode, "quality");
            assert_eq!(status, "idle");
            assert!(!resumed);
        }
    }

    #[test]
    fn backend_event_ready_resumed_roundtrip() {
        let ev = BackendEvent::Ready {
            models: vec![],
            mode: "cheap".into(),
            status: "idle".into(),
            git_info: Some(GitInfo { branch: "main".into(), dirty_count: 0, last_commit: "def".into() }),
            resumed: true,
            resumed_session_id: Some("sess-123".into()),
            resumed_message_count: Some(5),
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        if let BackendEvent::Ready { resumed, resumed_session_id, resumed_message_count, git_info, .. } = back {
            assert!(resumed);
            assert_eq!(resumed_session_id.as_deref(), Some("sess-123"));
            assert_eq!(resumed_message_count, Some(5));
            assert!(git_info.is_some());
        } else {
            panic!("expected Ready");
        }
    }

    #[test]
    fn backend_event_message_roundtrip() {
        let ev = BackendEvent::Message {
            id: "msg-1".into(),
            role: "assistant".into(),
            content: "Hello".into(),
            model_label: Some("opus".into()),
            reasoning_content: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        if let BackendEvent::Message { id, role, content, model_label, .. } = back {
            assert_eq!(id, "msg-1");
            assert_eq!(role, "assistant");
            assert_eq!(content, "Hello");
            assert_eq!(model_label.as_deref(), Some("opus"));
        } else {
            panic!("expected Message");
        }
    }

    #[test]
    fn backend_event_message_update_roundtrip() {
        let ev = BackendEvent::MessageUpdate {
            id: "msg-1".into(),
            content: Some("streaming…".into()),
            model_label: None,
            tool_calls: Some(vec![ToolCallInfo {
                name: "read_file".into(),
                args: "{}".into(),
                result: None,
                is_error: false,
                diff: None,
            }]),
            stats: None,
            reasoning_content: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        if let BackendEvent::MessageUpdate { id, content, tool_calls, .. } = back {
            assert_eq!(id, "msg-1");
            assert_eq!(content.as_deref(), Some("streaming…"));
            assert_eq!(tool_calls.unwrap().len(), 1);
        } else {
            panic!("expected MessageUpdate");
        }
    }

    #[test]
    fn backend_event_tool_call_roundtrip() {
        let ev = BackendEvent::ToolCall { name: "ls".into(), args: "-la".into(), is_error: true };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::ToolCall { .. }));
    }

    #[test]
    fn backend_event_status_roundtrip() {
        let ev = BackendEvent::Status { text: "done".into(), git_info: None };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        if let BackendEvent::Status { text, .. } = back {
            assert_eq!(text, "done");
        } else {
            panic!("expected Status");
        }
    }

    #[test]
    fn backend_event_activity_roundtrip() {
        let ev = BackendEvent::Activity { text: "reading file".into(), activity_type: "tool".into() };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::Activity { .. }));
    }

    #[test]
    fn backend_event_error_roundtrip() {
        let ev = BackendEvent::Error { message: "something broke".into() };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::Error { .. }));
    }

    #[test]
    fn backend_event_command_result_roundtrip() {
        let ev = BackendEvent::CommandResult { output: "ls: done".into() };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::CommandResult { .. }));
    }

    #[test]
    fn backend_event_model_override_roundtrip() {
        let ev = BackendEvent::ModelOverride { label: "@opus".into(), pinned: true };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        if let BackendEvent::ModelOverride { label, pinned } = back {
            assert_eq!(label, "@opus");
            assert!(pinned);
        } else {
            panic!("expected ModelOverride");
        }
    }

    #[test]
    fn backend_event_permission_request_roundtrip() {
        let ev = BackendEvent::PermissionRequest {
            id: "perm-1".into(),
            tool: "delete_file".into(),
            args: r#"{"path":"/tmp/x"}"#.into(),
            summary: "Delete /tmp/x?".into(),
            tier: "danger".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::PermissionRequest { .. }));
    }

    #[test]
    fn backend_event_permission_timeout_roundtrip() {
        let ev = BackendEvent::PermissionTimeout { id: "perm-1".into(), tool: "delete_file".into() };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::PermissionTimeout { .. }));
    }

    #[test]
    fn backend_event_wizard_prompt_roundtrip() {
        let ev = BackendEvent::WizardPrompt {
            id: "wiz-1".into(),
            step: "select".into(),
            title: "Pick a provider".into(),
            options: vec!["Anthropic".into(), "OpenAI".into()],
            masked: false,
            hint: String::new(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        if let BackendEvent::WizardPrompt { step, options, .. } = back {
            assert_eq!(step, "select");
            assert_eq!(options.len(), 2);
        } else {
            panic!("expected WizardPrompt");
        }
    }

    #[test]
    fn backend_event_wizard_prompt_defaults() {
        // `options`, `masked`, `hint` are all optional on the wire.
        let json = r#"{"type":"wizard_prompt","id":"w","step":"input","title":"Key"}"#;
        let ev: BackendEvent = serde_json::from_str(json).unwrap();
        if let BackendEvent::WizardPrompt { options, masked, hint, .. } = ev {
            assert!(options.is_empty());
            assert!(!masked);
            assert_eq!(hint, "");
        } else {
            panic!("expected WizardPrompt");
        }
    }

    #[test]
    fn backend_event_wizard_done_roundtrip() {
        let ev = BackendEvent::WizardDone { message: "saved".into() };
        let json = serde_json::to_string(&ev).unwrap();
        let back: BackendEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BackendEvent::WizardDone { .. }));
    }

    #[test]
    fn tui_command_wizard_response_roundtrip() {
        let cmd = TuiCommand::WizardResponse { id: "wiz-1".into(), value: "2".into(), cancelled: false };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: TuiCommand = serde_json::from_str(&json).unwrap();
        if let TuiCommand::WizardResponse { id, value, cancelled } = back {
            assert_eq!(id, "wiz-1");
            assert_eq!(value, "2");
            assert!(!cancelled);
        } else {
            panic!("expected WizardResponse");
        }
    }

    #[test]
    fn tui_command_wizard_response_cancelled_default() {
        let json = r#"{"type":"wizard_response","id":"w","value":""}"#;
        let cmd: TuiCommand = serde_json::from_str(json).unwrap();
        if let TuiCommand::WizardResponse { cancelled, .. } = cmd {
            assert!(!cancelled);
        } else {
            panic!("expected WizardResponse");
        }
    }

    // ── TuiCommand roundtrips ──────────────────────────────────────

    #[test]
    fn tui_command_submit_roundtrip() {
        let cmd = TuiCommand::Submit { text: "hello".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: TuiCommand = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, TuiCommand::Submit { .. }));
        if let TuiCommand::Submit { text } = back {
            assert_eq!(text, "hello");
        }
    }

    #[test]
    fn tui_command_command_roundtrip() {
        let cmd = TuiCommand::Command { text: "/help".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: TuiCommand = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, TuiCommand::Command { .. }));
    }

    #[test]
    fn tui_command_quit_roundtrip() {
        let cmd = TuiCommand::Quit;
        let json = serde_json::to_string(&cmd).unwrap();
        let back: TuiCommand = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, TuiCommand::Quit));
    }

    #[test]
    fn tui_command_permission_response_roundtrip() {
        let cmd = TuiCommand::PermissionResponse { id: "perm-1".into(), decision: "allow".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: TuiCommand = serde_json::from_str(&json).unwrap();
        if let TuiCommand::PermissionResponse { id, decision } = back {
            assert_eq!(id, "perm-1");
            assert_eq!(decision, "allow");
        } else {
            panic!("expected PermissionResponse");
        }
    }

    // ── Tagged enum deserialization ────────────────────────────────

    #[test]
    fn deserialize_backend_event_from_json_with_type_field() {
        // Real JSON as the Node backend sends it.
        let json = r#"{"type":"status","text":"Ready.","git_info":null}"#;
        let ev: BackendEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(ev, BackendEvent::Status { .. }));

        let json2 = r#"{"type":"error","message":"ratelimit"}"#;
        let ev2: BackendEvent = serde_json::from_str(json2).unwrap();
        assert!(matches!(ev2, BackendEvent::Error { .. }));

        let json3 = r#"{"type":"ready","models":[],"mode":"auto","status":"ok","git_info":null,"resumed":false}"#;
        let ev3: BackendEvent = serde_json::from_str(json3).unwrap();
        assert!(matches!(ev3, BackendEvent::Ready { .. }));
    }

    #[test]
    fn deserialize_tui_command_from_json_with_type_field() {
        let json = r#"{"type":"submit","text":"hi"}"#;
        let cmd: TuiCommand = serde_json::from_str(json).unwrap();
        assert!(matches!(cmd, TuiCommand::Submit { .. }));

        let json2 = r#"{"type":"quit"}"#;
        let cmd2: TuiCommand = serde_json::from_str(json2).unwrap();
        assert!(matches!(cmd2, TuiCommand::Quit));
    }
}
