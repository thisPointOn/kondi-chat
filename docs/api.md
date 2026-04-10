# JSON-RPC Protocol

The Rust TUI and the Node backend exchange newline-delimited JSON over stdio.
A custom frontend can speak the same protocol.

## Backend → frontend events

```json
{ "type": "ready", "models": ["claude","gpt-5.4"], "mode": "balanced",
  "status": "...", "git_info": {"branch":"main","dirty_count":0,"last_commit":"abc1234"},
  "resumed": false, "resumed_session_id": null, "resumed_message_count": null }

{ "type": "message", "id": "msg-1", "role": "assistant", "content": "",
  "model_label": "..." }

{ "type": "message_update", "id": "msg-1", "content": "...", "model_label": "claude",
  "tool_calls": [{"name":"read_file","args":"src/a.ts","result":"...","is_error":false,"diff":"..."}],
  "stats": {"input_tokens":1234,"output_tokens":567,"cost_usd":0.012,
             "models":["claude-sonnet-4-5"],"provider":"anthropic","route_reason":"nn","iterations":2} }

{ "type": "tool_call", "name": "write_file", "args": "a.ts", "is_error": false }
{ "type": "status", "text": "..." }
{ "type": "activity", "text": "...", "activity_type": "tool" }
{ "type": "error", "message": "..." }
{ "type": "command_result", "output": "..." }

{ "type": "permission_request", "id": "perm-1", "tool": "run_command",
  "args": "{\"command\":\"npm test\"}", "summary": "Run shell command: npm test", "tier": "confirm" }
{ "type": "permission_timeout", "id": "perm-1", "tool": "run_command" }
```

## Frontend → backend commands

```json
{ "type": "submit", "text": "...", "images": [{"mimeType":"image/png","base64":"...","sizeBytes":1234,"originalPath":"./s.png"}] }
{ "type": "command", "text": "/status" }
{ "type": "permission_response", "id": "perm-1", "decision": "approved" }
{ "type": "quit" }
```

`decision` is one of `"approved"`, `"denied"`, `"approved-session"`.

## Exit codes

See `docs/non-interactive.md`. Short version: `0` success, `1` error,
`2` max iterations, `3` max cost, `5` permission denied.
