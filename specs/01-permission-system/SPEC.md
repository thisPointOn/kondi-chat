# 01 — Permission System

## Product Description

The Permission System controls which tools the agent can execute automatically and which require explicit user confirmation. This is a critical safety layer that prevents the agent from making destructive changes (deleting files, force-pushing to git, running dangerous commands) without the user's awareness and approval.

**Why it matters:** AI coding assistants can cause irreversible damage if they execute destructive operations unchecked. Users need granular control over what the agent can do automatically versus what requires a human in the loop. This is table-stakes for any production coding tool.

**Revised 2026-04-10 (simplification pass):** Collapsed the new `src/permissions/` directory into a single `src/engine/permissions.ts` file. Deleted `PermissionRule` (unused), `formatToolSummary` (inline a one-liner), and the notion of "MCP server-wide match" (falls out of exact name + defaultTier). Kept the two protocol events — they are the whole feature. Effort dropped from 3-4 days to ~1.5 days.

## User Stories

1. **Default safe behavior:** A new user runs kondi-chat for the first time. The agent reads files and searches code without any prompts, but when it tries to write a file, the TUI shows a confirmation dialog with the file path and a preview. The user presses `y` to approve.

2. **Power user workflow:** An experienced user adds `"write_file": "auto-approve"` to their permissions config. Now write operations execute without confirmation, but `run_command` still requires approval because they want to review shell commands before execution.

3. **CI/CD automation:** A CI pipeline runs kondi-chat with `--dangerously-skip-permissions`. All tools execute without confirmation since the pipeline is already sandboxed and there is no human to confirm.

4. **Dangerous operation blocked:** The agent attempts to run `rm -rf /tmp/build`. The permission system classifies this as `always-confirm` tier. Even if the user has set `run_command` to `auto-approve`, the regex pattern match on `rm` forces a confirmation prompt.

5. **Session-level trust:** A user approves `run_command` once during a session, then selects "approve all for this session" from the confirmation dialog. Subsequent `run_command` calls in the same session auto-approve, but the setting resets on the next session.

## Clarifications (2026-04-09)

- **Decision payload (TUI ↔ backend):** single schema `{ id: string, decision: 'approved' | 'denied' | 'approved-session' }`. TUI must always send one of these values; backend rejects anything else.
- **Scope of `approved-session`:** applies to the exact tool *and* args fingerprint (JSON-stable-stringified), not global. Sub-agents inherit approvals from the parent session.
- **Non-interactive/CI:** if `--dangerously-skip-permissions` is *not* set and stdin is non-TTY, all `confirm`/`always-confirm` requests fail fast with a clear error; no silent auto-approve.
- **Pattern matching for `run_command`:** match against the raw command string after trimming whitespace; before matching, expand env vars *off* (literal match), normalize repeated whitespace to single spaces, and block if the command contains shell control operators (`|`, `;`, `&&`, `||`, subshells) unless explicitly whitelisted by config. Documented escape hatches must be deliberate.
- **Always-confirm list expansion:** include `git push --force-with-lease`, `sudo -E`, destructive redirections (`>* /dev/`), and `chmod 000/777`. Patterns are anchored after whitespace normalization.
- **Unknown tools:** default to `confirm` tier; registry must list whether a tool is mutating or read-only. New mutating tools must be added to the table before release.
- **sessionOverrides in config:** documented shape: `sessionOverrides: { "<toolName>": "auto-approve" | "confirm" | "always-confirm" }`, highest precedence for the current session only; not persisted across sessions.
- **Pending request lifecycle:** backend must expire unresolved requests after 5 minutes, mark them as denied, and surface a `permission_timeout` event. Duplicate responses for the same id are ignored after resolution.
## Technical Design

### Architecture

```
Tool execution request
        |
        v
  PermissionManager.check(toolName, args)
        |
        v
  ┌─────────────┐     ┌──────────────────┐
  │ Pattern      │ --> │ Tool-level        │
  │ Matcher      │     │ Permission        │
  │ (always-     │     │ (auto/confirm/    │
  │  confirm     │     │  always-confirm)  │
  │  patterns)   │     │                   │
  └─────────────┘     └──────────────────┘
        |                      |
        v                      v
  ┌─────────────────────────────────┐
  │ Decision: auto-approve | confirm │
  └─────────────────────────────────┘
        |
        v (if confirm)
  Backend sends "permission_request" event to TUI
  TUI shows confirmation dialog
  TUI sends "permission_response" command back
  Backend resumes or aborts tool execution
```

### Data Flow

1. `ToolManager.execute()` calls `PermissionManager.check(toolName, args)` before dispatching.
2. `PermissionManager` evaluates: (a) always-confirm patterns first, (b) per-tool override, (c) tier default.
3. If the decision is `confirm`, the backend emits a `permission_request` event via JSON-RPC.
4. The backend creates a `Promise` and stores a resolver keyed by a request ID.
5. The TUI renders the confirmation dialog and waits for user input.
6. The TUI sends a `permission_response` command with `{ id, approved: bool }`.
7. The backend resolves the promise and either continues or returns an error to the agent.

### Permission Tiers

| Tier | Default tools | Behavior |
|------|---------------|----------|
| `auto-approve` | `read_file`, `list_files`, `search_code`, `update_plan` | Execute immediately, no prompt |
| `confirm` | `write_file`, `edit_file`, `run_command`, `create_task` | Show confirmation, wait for user |
| `always-confirm` | (none by default; pattern-matched) | Always confirm, cannot be overridden to auto-approve |

### Always-Confirm Patterns

These regex patterns on `run_command` arguments force `always-confirm` regardless of the tool-level permission:

```json
[
  "rm\\s+(-[rfR]+\\s+|--recursive)",
  "git\\s+push\\s+(-f|--force)",
  "git\\s+push\\s+.*\\b(main|master)\\b",
  "git\\s+reset\\s+--hard",
  "chmod\\s+777",
  "sudo\\s+",
  "curl.*\\|\\s*(sh|bash)",
  "dd\\s+",
  "> /dev/"
]
```

## Implementation Details

### New file

**`src/engine/permissions.ts`** — single file, no new directory. One class, one config type, one decision type.

```typescript
export type PermissionTier = 'auto-approve' | 'confirm' | 'always-confirm';
export type PermissionDecision = 'approved' | 'denied' | 'approved-session';

export interface PermissionConfig {
  defaultTier: PermissionTier;
  tools: Record<string, PermissionTier>;
  alwaysConfirmPatterns: string[];
}

export class PermissionManager {
  constructor(configPath: string, skipPermissions?: boolean);
  check(tool: string, args: Record<string, unknown>): PermissionTier;
  requestPermission(tool: string, args: Record<string, unknown>, emit: (e: any) => void): Promise<PermissionDecision>;
  handleResponse(id: string, decision: PermissionDecision): void;
}
```

Tool summary for the dialog is a two-line switch inline in `requestPermission` (`run_command` → command; `write_file`/`edit_file` → path; fallback → JSON.stringify). No `formatToolSummary` method.

**Default permission tiers (built into `PermissionManager`):**

```typescript
const DEFAULT_TOOL_TIERS: Record<string, PermissionTier> = {
  read_file: 'auto-approve',
  list_files: 'auto-approve',
  search_code: 'auto-approve',
  update_plan: 'auto-approve',
  write_file: 'confirm',
  edit_file: 'confirm',
  run_command: 'confirm',
  create_task: 'confirm',
};
```

### Modified files

**`src/mcp/tool-manager.ts`** — Insert permission check before tool execution:

**Revised:** previously assigned `permissionManager` to `ToolManager` as a field and read `toolCtx.emit`, but the current `ToolManager` constructor takes only `McpClientManager`, and `ToolContext` has no `emit` / `permissionManager` fields. The manager and emit function must flow through `ToolContext` (as CONVENTIONS.md already declares), not `this`. Also, hook execution must precede permissions per CONVENTIONS.md § Permissions + Hooks — the snippet below shows only the permission wedge; see Spec 12 for the outer hook wrapping.

```typescript
// In ToolManager.execute(name, args, toolCtx):
const pm = toolCtx.permissionManager;
if (pm) {
  const tier = pm.check(name, args);
  if (tier !== 'auto-approve') {
    const decision = await pm.requestPermission(name, args, toolCtx.emit!);
    if (decision === 'denied') {
      return { content: `Permission denied for ${name}. User declined.`, isError: true };
    }
  }
}
// ... existing dispatch logic (extraExecutors, MCP __ split, executeTool)
```

Note: `toolCtx.emit` is added by CONVENTIONS.md; `backend.ts` must populate it with the top-level `emit` closure when building `toolCtx`. Existing `extraExecutors` (e.g. council) and MCP `__`-separated names must also pass through the permission wedge — do not branch permission checks only on built-in tools.

**`src/cli/backend.ts`** — Add permission manager initialization and response handler:

```typescript
// In main():
const permissionManager = new PermissionManager(
  join(storageDir, 'permissions.json'),
  process.argv.includes('--dangerously-skip-permissions'),
);

// In command handler:
if (cmd.type === 'permission_response') {
  permissionManager.handleResponse(cmd.id, cmd.decision);
  return;
}
```

**`tui/src/protocol.rs`** — Add new event and command types:

```rust
// In BackendEvent:
#[serde(rename = "permission_request")]
PermissionRequest {
    id: String,
    tool: String,
    args: String,
    summary: String,
    tier: String,
},

// In TuiCommand:
#[serde(rename = "permission_response")]
PermissionResponse {
    id: String,
    decision: String, // "approved", "denied", "approved-session"
},
```

**`tui/src/app.rs`** — Add permission dialog state and rendering:

```rust
pub struct App {
    // ... existing fields
    pub pending_permission: Option<PermissionDialog>,
}

pub struct PermissionDialog {
    pub id: String,
    pub tool: String,
    pub args: String,
    pub summary: String,
    pub tier: String,
}
```

### Config file

**`.kondi-chat/permissions.json`**

```json
{
  "defaultTier": "confirm",
  "tools": {
    "read_file": "auto-approve",
    "list_files": "auto-approve",
    "search_code": "auto-approve",
    "update_plan": "auto-approve",
    "write_file": "confirm",
    "edit_file": "confirm",
    "run_command": "confirm",
    "create_task": "confirm"
  },
  "alwaysConfirmPatterns": [
    "rm\\s+(-[rfR]+\\s+|--recursive)",
    "git\\s+push\\s+(-f|--force)",
    "git\\s+push\\s+.*\\b(main|master)\\b",
    "git\\s+reset\\s+--hard",
    "sudo\\s+"
  ]
}
```

## Protocol Changes

### New Backend -> TUI event: `permission_request`

```json
{
  "type": "permission_request",
  "id": "perm-1712438400000-0",
  "tool": "run_command",
  "args": "{\"command\": \"npm test\"}",
  "summary": "Run shell command: npm test",
  "tier": "confirm"
}
```

### New TUI -> Backend command: `permission_response`

```json
{
  "type": "permission_response",
  "id": "perm-1712438400000-0",
  "decision": "approved"
}
```

Decision values: `"approved"`, `"denied"`, `"approved-session"` (approve all future calls to this tool in this session).

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultTier` | `PermissionTier` | `"confirm"` | Default for tools not listed in `tools` |
| `tools` | `Record<string, PermissionTier>` | See above | Per-tool overrides |
| `alwaysConfirmPatterns` | `string[]` | See above | Regex patterns that force always-confirm on run_command args |

### CLI flags

| Flag | Effect |
|------|--------|
| `--dangerously-skip-permissions` | All tools auto-approve. Intended for CI/CD only. Prints a warning to stderr. |

### MCP tool handling

MCP tool names include a `__` separator (e.g., `brave-search__web_search`). Permissions for MCP tools are matched by:

1. Exact name match in `config.tools`
2. Server-wide match: `mcp:<serverName>` (e.g., `"mcp:brave-search": "confirm"`)
3. Fallback to `defaultTier`

The MCP server name is extracted from the part before `__`.

**Revised:** current `ToolManager.execute()` routes via three branches (`extraExecutors` for registered tools like council, MCP `__`-split, built-in `executeTool`). The permission wedge must sit above all three, otherwise extra-registered and MCP tools bypass permissions.

### Session approval scope

When a user chooses "approve-session", the approval is scoped by `tool + args-fingerprint`, not just tool name. The fingerprint is a hash of the tool arguments normalized for stability (e.g., for `run_command`, the fingerprint is the command string minus whitespace). This prevents "approve run_command once" from approving all future run_commands.

Exception: for `read_file`/`list_files`/`search_code` (auto-approve by default), session approval is tool-wide since they're read-only.

### Iterations during pending permission

Pending permission requests are not counted by `LoopGuard` (see Spec 08) — `recordIteration` is called after tool execution completes, so a pending request naturally pauses iteration accounting. Wall-clock time still counts against the 5-minute permission timeout.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Permission request timeout (user doesn't respond within 5 minutes) | Deny the request, return error to agent |
| Corrupted permissions.json | Fall back to built-in defaults, log warning |
| Unknown tool name in config | Ignore the entry, use defaultTier |
| TUI disconnects while permission pending | All pending requests are denied |
| `always-confirm` pattern match on non-run_command tool | Patterns only apply to `run_command` args; other tools use their tier directly |
| MCP tool with unknown server | Use defaultTier; log warning on first call |
| Permission request while agent is in sub-agent loop | Request includes `subAgentId` field so TUI shows which child is asking |
| Concurrent permission requests (from parallel sub-agents) | Each gets a unique request ID; TUI queues them in a visual stack |
| Session approval stored but user restarts | Session approvals don't persist across restarts (security); user re-approves on next session |

## Testing Plan

1. **Unit tests** (`src/permissions/manager.test.ts`):
   - `check()` returns correct tier for each built-in tool
   - Per-tool overrides in config take precedence over defaults
   - Always-confirm patterns match dangerous commands
   - Session approvals work after `approved-session` decision
   - `--dangerously-skip-permissions` bypasses all checks
   - Corrupted config falls back to defaults

2. **Integration tests**:
   - Full flow: tool call -> permission request event -> response command -> tool execution
   - Timeout handling: no response within 5 minutes -> denial
   - Multiple concurrent permission requests (from sub-agents)

3. **E2E tests**:
   - TUI renders permission dialog correctly
   - Keyboard shortcuts work (y/n/a for approve/deny/approve-session)
   - Dialog dismisses after response

## Dependencies

- **Depends on:** `src/mcp/tool-manager.ts` (integration point), `src/engine/tools.ts` (tool names), `tui/src/protocol.rs` (protocol types)
- **Depended on by:** Spec 02 (Git Integration — git tools need permission checks), Spec 07 (Sub-agents — child agents inherit parent permissions), Spec 10 (Non-interactive mode — must handle no-TTY), Spec 12 (Hooks — hook execution respects permissions)

## Estimated Effort

**1.5 days** (revised from 3-4 days)
- Morning: `src/engine/permissions.ts` — manager, config load, tier + pattern matching, pending-request map with timeout.
- Afternoon: Wire `permissionManager` + `emit` into `ToolContext`; add permission wedge at top of `ToolManager.execute`; add `permission_response` command branch in backend.ts.
- Day 2 morning: TUI dialog (protocol event types, app state, render, y/n/a keybinds), a handful of unit tests for tier resolution and pattern matching.
