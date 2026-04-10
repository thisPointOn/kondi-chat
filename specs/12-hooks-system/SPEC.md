# 12 — Hooks System

## Product Description

The Hooks System lets users run shell commands or tool calls before and after any agent tool. Hooks are configured in `.kondi-chat/hooks.json`. Common use cases: auto-format after write, auto-lint after edit, run tests after changes, block destructive operations. Hook failures can abort the tool, warn and continue, or be ignored based on config.

**Why it matters:** Every project has conventions that the agent should respect: formatting, linting, testing, file naming. Rather than relying on the agent to remember to run Prettier after every edit, hooks automate these policies at the tool level. This guarantees consistency without bloating the agent's context with reminders.

**Revised 2026-04-10 (simplification pass):** Moved from new `src/hooks/` dir into `src/engine/hooks.ts` (single file). Dropped `before_any` / `after_any` / `on_error_<tool>` special keys. Dropped `HookCondition` (glob/regex filtering) — keyed by exact tool name is enough. Dropped `hook_executed` protocol event — reuse the existing `activity` event with `activity_type: 'hook'`. Dropped `builtin.autoLint` / `autoTest` — built-ins cover auto-format only. Dropped `reload()` (restart the backend). Effort dropped from 4 days to 1.5 days.

## User Stories

1. **Auto-format:** A user adds `"after_write_file": "npx prettier --write {path}"`. After the agent writes any file, Prettier runs automatically. The agent doesn't need to know about formatting — it just writes code.

2. **Auto-test after edit:** `"after_edit_file": "npm test -- --related {path}"` runs tests related to the edited file. If tests fail, the hook surfaces the failure to the agent in the tool result, and the agent fixes the issue.

3. **Block dangerous writes:** `"before_write_file"` runs a custom script that checks if the path is under `node_modules/`. If so, the hook exits non-zero with `"on_failure": "block"`, aborting the write.

4. **Built-in hooks:** The user enables `builtin.autoFormat = true` in config. kondi-chat detects Prettier/Black/gofmt based on project files and wires up format hooks automatically without manual config.

5. **Tool chain hook:** `"after_git_commit"` is set to `"tool: git_log"` — after every commit, the agent calls `git_log` to confirm the commit landed. This chains multiple tools automatically.

## Clarifications (2026-04-10)

- **Permission boundary:** Hook-invoked tools must still go through permission checks; `executeWithoutHooks()` must not bypass permissions—only hook recursion.
- **Repo trust:** Hooks from the repo (`.kondi-chat/hooks.json`) are untrusted by default; require explicit user opt-in (prompt or flag) before executing any `before_*` or `after_*` shell/tool hook.
- **Failure ordering:** If the base tool fails, run `on_error_<tool>` first, then `after_any`; skip `after_<tool>` unless explicitly allowed. Define this order in the spec.
- **Schema naming:** Normalize to camelCase (e.g., `onFailure`, `defaultFailureMode`) and document exact field names; reject unknown variants to avoid silent misparse.
- **Shell interpolation:** Define placeholder expansion before shell quoting; placeholders outside quotes are shell-escaped; inside single quotes are replaced verbatim and then re-quoted. Document this precisely to avoid injection/command breakage.
- **Built-in formatter:** Fix rustfmt hook to `cargo fmt` (no per-file arg). For per-file formatting, use `rustfmt {path}` instead.
## Technical Design

### Architecture

```
Tool call from agent
        │
        v
ToolManager.execute(name, args)
        │
        v
HookRunner.runBefore(name, args) ───> abort if block
        │
        v
Actual tool execution
        │
        v
HookRunner.runAfter(name, args, result) ──> augments result
        │
        v
Return combined result to agent
```

### Hook types

| Type | Syntax | Execution |
|------|--------|-----------|
| `shell` | `"npm test -- {path}"` | `execSync` with substitution |
| `tool` | `"tool: git_log"` or `{ "tool": "git_log", "args": {...} }` | Calls another tool |
| `script` | `"./scripts/my-hook.sh {path}"` | Same as shell, but relative paths |

### Hook keys

Hooks are keyed by `<phase>_<tool_name>`:

- `before_<tool>` — runs before the tool; can block execution
- `after_<tool>` — runs after the tool; augments the result

No `before_any` / `after_any` / `on_error_<tool>` in v1. `after_<tool>` always runs, and receives the tool result (success or error) via variable substitution. **Revised:** special keys deleted.

### Variable substitution

Hooks can reference tool arguments using `{key}` syntax:

- `{path}` — the `path` argument to the tool
- `{command}` — the `command` argument (for `run_command`)
- `{content}` — file content (for `write_file`)
- `{result}` — the tool's result content (in `after_` hooks only)
- `{cwd}` — current working directory

Unknown keys expand to empty string. Arguments containing shell-unsafe characters are quoted automatically.

### Hook failure modes

Each hook declares `on_failure`:

| Mode | Behavior |
|------|----------|
| `block` | In `before_` hooks: abort tool. In `after_` hooks: mark tool result as error. |
| `warn` | Continue execution, surface warning in tool result |
| `ignore` | Continue execution, log but don't surface |

### Built-in hooks (auto-format only)

Detected automatically if `builtin.autoFormat = true`:

- **Prettier**: `.prettierrc` -> `npx prettier --write {path}`
- **Black**: `pyproject.toml` with `[tool.black]` -> `black {path}`
- **gofmt**: any `*.go` file in repo root -> `gofmt -w {path}`
- **Rustfmt**: `Cargo.toml` -> `rustfmt {path}` (per-file; no `cargo fmt` wrap)

Only `after_write_file` / `after_edit_file` are installed. Lint and test auto-detection deferred.

## Implementation Details

### New files

**`src/engine/hooks.ts`** (single file; not a directory)

```typescript
export type HookFailureMode = 'block' | 'warn' | 'ignore';

export type HookDefinition =
  | string   // shorthand: shell command
  | {
      type: 'shell' | 'tool';
      command?: string;              // for shell
      tool?: string;                 // for tool
      args?: Record<string, unknown>; // for tool
      onFailure?: HookFailureMode;
      timeoutMs?: number;
    };

export interface HooksConfig {
  hooks: Record<string, HookDefinition | HookDefinition[]>;
  builtin?: { autoFormat?: boolean };
  defaultFailureMode?: HookFailureMode;
  defaultTimeoutMs?: number;
}

export class HookRunner {
  constructor(configPath: string, workingDir: string);
  setToolExecutor(fn: (name: string, args: any, ctx: ToolContext) => Promise<{ content: string; isError?: boolean }>): void;
  async runBefore(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ blocked: boolean; messages: string[] }>;
  async runAfter(tool: string, args: Record<string, unknown>, result: { content: string; isError?: boolean }, ctx: ToolContext): Promise<{ content: string; isError?: boolean }>;
}
```

Built-in auto-format hooks are detected in the constructor. No `HookCondition`, no `script` type (shell covers it), no `reload()`, no `HookResult` export (internal only).

### Modified files

**`src/mcp/tool-manager.ts`**

```typescript
import { HookRunner } from '../hooks/runner.ts';

export class ToolManager {
  private hookRunner?: HookRunner;

  setHookRunner(runner: HookRunner): void {
    this.hookRunner = runner;
    // Wire back the tool executor so hooks of type 'tool' can call back into ToolManager
    runner.setToolExecutor((name, args, ctx) => this.executeWithoutHooks(name, args, ctx));
  }

  async execute(name, args, toolCtx) {
    // NEW: Before hooks
    if (this.hookRunner) {
      const before = await this.hookRunner.runBefore(name, args, toolCtx);
      if (before.blocked) {
        return {
          content: `Tool blocked by hook: ${before.messages.join('; ')}`,
          isError: true,
        };
      }
    }

    // NEW: Permission check (from Spec 01, runs AFTER before hooks)
    // ... existing permission logic ...

    // Actual tool execution
    const result = await this.executeWithoutHooks(name, args, toolCtx);

    // NEW: After hooks
    if (this.hookRunner) {
      return this.hookRunner.runAfter(name, args, result, toolCtx);
    }

    return result;
  }

  /** Same as execute() but without hooks, used by hook-type hooks to avoid recursion.
   *  Must remain package-private (not truly #private) so HookRunner can invoke it
   *  via the callback registered in setToolExecutor(). Permission checks STILL run
   *  on hook-invoked tool calls — see CONVENTIONS.md § Permission boundary. */
  async executeWithoutHooks(name, args, toolCtx) {
    // Runs: permission check → extraExecutors/MCP/built-in dispatch → return.
    // No before/after hooks. This is how 'tool'-type hooks loop back in.
  }
}
```

### Execution order

For a tool call, the order is:

1. **Hooks: before_<tool>**
2. **Permissions check** (Spec 01)
3. **Tool execution**
4. **Hooks: after_<tool>** (runs regardless of tool success — check `{result}` expansion or `isError`)

Hooks within the same key run sequentially.

### Recursion prevention

A hook of type `tool` calls `ToolManager.executeWithoutHooks()` (not `execute()`), so hooks don't trigger on hook-invoked tools. This prevents infinite recursion and keeps the execution model simple.

Maximum hook chain depth: 3 (a hook calling a tool that triggers another hook is allowed up to 3 levels; deeper attempts error).

## Protocol Changes

**None.** Hook execution emits a regular `activity` event with `activity_type: 'hook'`:

```json
{ "type": "activity", "text": "after_write_file: prettier (34ms)", "activity_type": "hook" }
```

**Revised:** `hook_executed` event deleted — `activity` already carries this information.

## Configuration

**`.kondi-chat/hooks.json`**

```json
{
  "hooks": {
    "after_write_file": "npx prettier --write {path}",
    "after_edit_file": [
      "npx prettier --write {path}",
      "npx eslint --fix {path}"
    ],
    "before_write_file": {
      "type": "script",
      "command": "./scripts/check-path.sh {path}",
      "onFailure": "block"
    },
    "after_git_commit": {
      "type": "tool",
      "tool": "git_log",
      "args": { "count": 1 }
    },
    "before_run_command": {
      "type": "shell",
      "command": "echo 'Running: {command}' >> .kondi-chat/command.log",
      "onFailure": "ignore"
    }
  },
  "builtin": {
    "autoFormat": true
  },
  "defaultFailureMode": "warn",
  "defaultTimeoutMs": 15000
}
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| Hook command not found | `on_failure` behavior applies; default warn |
| Hook times out | Kill process, treat as failure |
| Variable substitution error (unknown key) | Empty string substituted, log debug |
| Hook tries to call a non-existent tool | Error: "Unknown tool in hook: <name>" |
| Infinite hook recursion | Depth limit of 3, then error |
| Shell injection in args | All substituted values are single-quoted; literal single quotes escaped |
| Config file malformed | Load empty config, log warning, continue |
| Hook writes to stdout (pollutes JSON-RPC) | Hooks run with stdout redirected to stderr for backend process |

## Testing Plan

1. **Unit tests** (`src/hooks/runner.test.ts`):
   - Variable substitution with all supported keys
   - Shell command execution with success/failure
   - Tool-type hooks call tool executor
   - Conditions filter correctly (pathMatches, commandMatches)
   - Failure modes: block, warn, ignore
   - Built-in hook detection for each project type

2. **Integration tests**:
   - Full tool call with before/after hooks
   - Hook blocks tool execution
   - Hook chain: after_edit_file -> after_write_file (no recursion)
   - Multiple hooks for same key run in order

3. **E2E tests**:
   - Real Prettier hook formats a file
   - Real failing hook surfaces error in tool result

## Dependencies

- **Depends on:** `src/mcp/tool-manager.ts` (integration point), Spec 01 (Permission System — hooks run in order with permissions)
- **Depended on by:** Spec 15 (Telemetry — hook usage tracked as feature metric), Spec 17 (Documentation — hooks are documented)

## Interaction with other features

- **Permissions (Spec 01):** Before hooks run *before* permission checks, so a `before_` hook can block a destructive operation without a permission dialog. After-hooks run *after* the tool executes.
- **Checkpoints (Spec 05):** Hook-invoked tools that modify files also trigger checkpoint creation. Hook execution itself does not create a checkpoint, but a hook that runs `git_commit` would.
- **Sub-agents (Spec 07):** Hooks run on sub-agent tool calls too, using the sub-agent's ToolContext.

## Estimated Effort

**1.5 days** (revised from 4 days)
- Day 1: `src/engine/hooks.ts` — HookRunner, shell + tool dispatch, variable substitution with shell escaping, built-in auto-format detection, failure modes.
- Day 2 morning: ToolManager wedge (before hooks → permission → execute → after hooks), a handful of tests.
