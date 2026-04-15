# JSON-RPC Protocol

The Rust TUI and the Node backend exchange newline-delimited JSON over stdio.
A custom frontend can speak the same protocol.

## Backend → frontend events

```json
{ "type": "ready", "models": ["claude","gpt-5.4","gemini","glm","flash"],
  "mode": "zai", "status": "14 models | mode: zai",
  "git_info": {"branch":"main","dirty_count":0,"last_commit":"abc1234"},
  "resumed": false, "resumed_session_id": null, "resumed_message_count": null }

{ "type": "message", "id": "msg-1", "role": "assistant", "content": "",
  "model_label": "glm", "reasoning_content": null }

{ "type": "message_update", "id": "msg-1", "content": "...", "model_label": "glm",
  "tool_calls": [{"name":"read_file","args":"src/a.ts","result":"...","is_error":false,"diff":"..."}],
  "reasoning_content": "...hidden chain-of-thought from glm-5.1, o-series, R1, or Anthropic extended thinking...",
  "stats": {"input_tokens":1234,"output_tokens":567,"cost_usd":0.012,
             "models":["glm-4.6"],"provider":"zai","route_reason":"intent: coding","iterations":2} }

{ "type": "tool_call", "name": "write_file", "args": "a.ts", "is_error": false }
{ "type": "status", "text": "...", "git_info": null }
{ "type": "activity", "text": "context: 23,000 → 18,500 tokens (4,500 chars pruned)", "activity_type": "step" }
{ "type": "error", "message": "..." }
{ "type": "command_result", "output": "..." }

{ "type": "model_override", "label": "gemini" }

{ "type": "permission_request", "id": "perm-1", "tool": "run_command",
  "args": "{\"command\":\"npm test\"}", "summary": "Run shell command: npm test", "tier": "confirm" }
{ "type": "permission_timeout", "id": "perm-1", "tool": "run_command" }
```

### Event reference

| Event | Purpose |
|---|---|
| `ready` | Startup handshake. `models` is the list of enabled model aliases. `mode` is the active profile name. `status` is the status-line text. `git_info` is the repo snapshot. `resumed*` fields populate when `--resume` was used. |
| `message` | Creates a new assistant-message placeholder. `content` is usually empty and filled via `message_update`. `model_label` may be `null` until the router picks. `reasoning_content` is populated only for reasoning models (GLM-5.x, OpenAI o-series, DeepSeek-R1, Anthropic extended thinking). |
| `message_update` | Patches an in-flight message. Any field can be null; non-null fields overwrite. When `stats` arrives, the message is final — the TUI should flush it to scrollback. `reasoning_content` is appended here too if streamed separately. |
| `tool_call` | Announces a tool invocation in real time. `args` is a stringified JSON summary. `is_error` true if the tool returned an error result. |
| `status` | Transient status-line text (e.g. "glm thinking..."). `git_info` may carry a refreshed snapshot when git state changes. |
| `activity` | Inline dim-yellow line shown in the current turn's preview. `activity_type` is `step`, `tool`, or `sub_agent`. Used for router decisions, context compaction notices, compaction stats, loop continuation markers, etc. |
| `error` | Surfaced as a system note in scrollback. Does not clear processing state. |
| `command_result` | Result of a slash command (`/mode`, `/cost`, `/routing`, etc.). The TUI renders it as a system note and clears processing state. |
| `model_override` | Signals that the router override (or profile) changed so the bottom-of-viewport model indicator can update without waiting for the next turn. `label` is what to show — a model alias like `"gemini"` or a profile name like `"zai"`. Emitted from `/use` and `/mode` handlers. |
| `permission_request` | Pops the permission overlay in the TUI. `tier` is one of `auto-approve`, `confirm`, `always-confirm`. The TUI collects the user's decision and sends it back as `permission_response`. |
| `permission_timeout` | Backend gave up waiting on a pending permission after 5 minutes and treated it as denied. |

## Frontend → backend commands

```json
{ "type": "submit", "text": "...", "images": [{"mimeType":"image/png","base64":"...","sizeBytes":1234,"originalPath":"./s.png"}] }
{ "type": "command", "text": "/status" }
{ "type": "permission_response", "id": "perm-1", "decision": "approved" }
{ "type": "quit" }
```

### Command reference

| Command | Purpose |
|---|---|
| `submit` | Dispatch a user message to `handleSubmit` (agent loop). `images` are queued for multimodal dispatch. |
| `command` | Dispatch a slash command to `handleCommand`. Special-case: `/loop <goal>` is routed to `handleSubmit` with `opts.loop=true` instead of `handleCommand`, so its tool-call / activity / message events stream exactly like a regular submit. |
| `permission_response` | Decision on a pending `permission_request`. Possible values: `"approved"` (this call only), `"denied"`, `"approved-session"` (fingerprint-matched for rest of session), `"approved-turn"` (yolo all confirm-tier calls for the rest of the current turn; cleared automatically when the turn ends; does not bypass `always-confirm` tier). |
| `quit` | Graceful shutdown. Flushes session state before exit. |

## Exit codes

See `docs/non-interactive.md`. Short version: `0` success, `1` error,
`2` max iterations, `3` max cost, `5` permission denied.
