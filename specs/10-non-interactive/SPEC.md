# 10 — Non-interactive Mode

## Product Description

Non-interactive mode lets kondi-chat run as a scriptable CLI. `--prompt "do X"` runs a single turn and exits. `--pipe` reads from stdin and writes to stdout. `--json` emits structured JSON for machine consumption. Exit codes signal success, error, or iteration cap. This makes kondi-chat usable in CI/CD pipelines, shell scripts, and editor integrations.

**Why it matters:** The interactive TUI is the primary interface, but many use cases don't have a TTY: CI pipelines, git hooks, editor integrations, batch processing, cron jobs. A first-class non-interactive mode unlocks these workflows without needing a separate binary or API.

**Revised 2026-04-10 (simplification pass):** Collapsed `AgentLoopProgress` struct (5 variants) into a simple `onActivity(text: string)` callback. Dropped auto-CI permission-skip behavior (explicit flag only). Dropped `--no-verify` flag (not grounded). `parseFlags`, `formatText`, `formatJson` are inlined in `runNonInteractive` — no separate exports. Effort dropped from 4 days to 2 days. The `runAgentLoop` extraction stays — it's load-bearing for Spec 07.

## User Stories

1. **CI commit message:** A pre-commit hook runs `kondi-chat --prompt "write a commit message for the staged changes" --pipe > COMMIT_EDITMSG`. The agent reads `git diff --cached`, writes a message, and exits. The hook uses the output.

2. **Batch refactor:** A script loops over 50 files and runs `kondi-chat --prompt "add TypeScript types to this file" --cwd ./src/legacy/$file --json`. The JSON output is parsed to track success/failure per file.

3. **Editor integration:** A Neovim plugin shells out to `kondi-chat --pipe --json` and sends a prompt via stdin. The JSON response is parsed and rendered as a floating window.

4. **Pipeline in a shell script:**
   ```bash
   git diff | kondi-chat --pipe --prompt "review this diff" > review.md
   ```

5. **Exit code-driven automation:** A CI job runs `kondi-chat --prompt "fix the failing tests" --max-iterations 10`. If the agent hits the iteration cap without success, exit code is 2 and the job marks the build as flaky. Success returns 0.

## Clarifications (2026-04-10)

- **Mode selection precedence:** Interactive TUI unless `--json` or `--pipe` is provided *and* `force-tui` is false. Redirected stdout alone must not auto-switch to non-interactive; require an explicit flag to avoid surprising users.
- **`--prompt` vs `--pipe`:** If both are provided, stdin content is ignored and `--prompt` wins (or vice-versa—pick one). Empty stdin without `--prompt` should error clearly (“no prompt provided”).
- **Exit codes:** define precedence when multiple conditions fire: SIGINT → 130; permission denied → 5; cost cap → 3; iteration cap → 2; generic error → 1; success → 0.
- **Sessions/resume:** In non-interactive mode, `--resume`/`--sessions` use the same repo/global store as interactive; serialization format is identical to the TUI. Document the storage path so automation can rely on it.
- **JSON output:** define failure schema `{ ok: false, error: { code, message }, costUsd?, iterations? }`. `--json` suppresses human-readable progress on stdout; progress/errors go to stderr.
## Technical Design

### Architecture

```
kondi-chat [flags]
    │
    v
Parse flags: interactive vs non-interactive
    │
    ├─ Interactive (default): spawn TUI -> backend via pipes
    │
    └─ Non-interactive: run backend inline (no TUI)
         │
         ├─ --prompt: use as input
         ├─ --pipe: read stdin
         │
         v
       Single-turn or bounded loop
         │
         v
       Print result to stdout (text or JSON)
         │
         v
       Exit with code
```

### Flags

| Flag | Behavior |
|------|----------|
| `--prompt <text>` | Run a single turn with the given prompt |
| `--pipe` | Read prompt from stdin (useful for piping) |
| `--json` | Emit structured JSON instead of plain text |
| `--max-iterations <N>` | Override the default iteration cap for this invocation |
| `--max-cost <USD>` | Override the cost cap for this invocation |
| `--mode <profile>` | Select a budget profile (balanced, cheap, quality, or custom) |
| `--use <alias>` | Override model selection |
| `--cwd <path>` | Working directory (defaults to cwd) |
| `--no-verify` | Skip automatic verification |
| `--image <path>` | Attach an image (repeatable) |
| `--sessions` | List sessions and exit |
| `--resume [id]` | Resume a session (works in non-interactive too) |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success — agent completed without errors |
| 1 | Error — unrecoverable error (API failure, bad config) |
| 2 | Max iterations — hit iteration cap before completing |
| 3 | Max cost — hit cost cap before completing |
| 4 | User abort — SIGINT received |
| 5 | Permission denied — a required tool was denied |
| 130 | Interrupted (standard SIGINT convention) |

### Output modes

**Text mode (default):**

The agent's final message is printed to stdout. Tool calls and intermediate steps go to stderr (unless `--quiet`). Stderr output includes:

```
[turn 1] claude-sonnet-4-5 — balanced
  read_file(src/auth.ts)
  edit_file(src/auth.ts) +4/-2
[turn 2] claude-sonnet-4-5
  run_command(npm test)
Done: 2 iterations, $0.0234
```

**JSON mode (`--json`):**

Single JSON object on stdout:

```json
{
  "success": true,
  "exitCode": 0,
  "finalMessage": "Fixed the null check in src/auth.ts and verified tests pass.",
  "iterations": 2,
  "toolCalls": [
    { "name": "read_file", "args": { "path": "src/auth.ts" }, "isError": false },
    { "name": "edit_file", "args": { "path": "src/auth.ts" }, "isError": false, "diff": "..." },
    { "name": "run_command", "args": { "command": "npm test" }, "isError": false }
  ],
  "stats": {
    "inputTokens": 4523,
    "outputTokens": 892,
    "costUsd": 0.0234,
    "modelsUsed": ["claude-sonnet-4-5-20250929"],
    "durationMs": 12340
  },
  "session": {
    "id": "f3a1b2c3-...",
    "messageCount": 2
  },
  "filesModified": ["src/auth.ts"]
}
```

## Implementation Details

### New files

**`src/cli/non-interactive.ts`**

```typescript
import type { Session } from '../types.ts';

export interface NonInteractiveOptions {
  prompt?: string;
  pipe?: boolean;
  json?: boolean;
  quiet?: boolean;
  maxIterations?: number;
  maxCostUsd?: number;
  mode?: string;
  use?: string;
  cwd?: string;
  images?: string[];
  resume?: string | true;
  skipPermissions?: boolean;
  autoApprove?: string[];
}

/** Run a single non-interactive turn, print result to stdout/stderr, return exit code. */
export async function runNonInteractive(argv: string[]): Promise<number>;
```

Flag parsing, stdin reading, text/JSON formatting, and progress printing are all inlined in `runNonInteractive`. One exported function; ~200 lines total.

### Modified files

**`src/cli/main.tsx`** — Detect non-interactive mode:

```typescript
import { runNonInteractive } from './non-interactive.ts';

const argv = process.argv.slice(2);

const isNonInteractive =
  argv.includes('--prompt') ||
  argv.includes('--pipe') ||
  argv.includes('--json') ||
  argv.includes('--sessions');

if (isNonInteractive) {
  process.exit(await runNonInteractive(argv));
}

// Otherwise, launch interactive TUI
// ... existing code
```

### Reuse of backend logic

The core agent loop from `src/cli/backend.ts` `handleSubmit()` is extracted into a reusable function:

**`src/engine/agent-loop.ts`** (new):

```typescript
export interface AgentLoopConfig {
  session: Session;
  contextManager: ContextManager;
  ledger: Ledger;
  router: Router;
  toolManager: ToolManager;
  toolCtx: ToolContext;
  profiles: ProfileManager;
  loopGuard: LoopGuard;
  images?: ImageAttachment[];
  /** Called for every emitted event (iteration start, tool call, final). Interactive mode maps this to JSON-RPC emits; non-interactive mode writes to stderr. */
  onEvent?: (event: { type: string; [k: string]: any }) => void;
}

export interface AgentLoopResult {
  finalContent: string;
  iterations: number;
  toolCalls: Array<{ name: string; args: string; isError: boolean; diff?: string }>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelsUsed: string[];
  filesModified: string[];
  stoppedReason: 'done' | 'max-iterations' | 'max-cost' | 'error' | 'user-abort' | 'permission-denied';
}

export async function runAgentLoop(input: string, config: AgentLoopConfig): Promise<AgentLoopResult>;
```

Both `handleSubmit()` (interactive) and `runNonInteractive()` call `runAgentLoop`. Interactive mode's `onEvent` re-emits the same JSON over stdout (matching existing events). Non-interactive writes human-readable progress to stderr. **Revised:** the `AgentLoopProgress` type was collapsed into a plain object passed to `onEvent`, matching the shape already used for JSON-RPC events — no translation layer.

### Permission handling in non-interactive mode

Since there is no TTY, permission requests cannot wait for user input. Non-interactive mode requires one of:

1. **`--dangerously-skip-permissions`** — auto-approve all (for CI)
2. **`--auto-approve <tool1,tool2,...>`** — approve specific tools
3. **No flag** — `confirm`-tier tools fail with exit code 5

A helpful error message is printed when a permission request would block:

```
Error: Tool 'write_file' requires confirmation but no TTY is available.
       Use --dangerously-skip-permissions or --auto-approve write_file to allow.
Exit code: 5
```

## Protocol Changes

None — non-interactive mode bypasses the TUI protocol entirely by invoking the backend logic directly in-process.

## Configuration

Non-interactive mode respects the same configuration files as interactive mode. CLI flags override config values. No auto-CI detection — `--dangerously-skip-permissions` is always explicit. **Revised:** dropped `autoSkipPermissionsInCI` — implicit permission relaxing in a CI is a footgun.

## Error Handling

| Scenario | Exit code | Behavior |
|----------|-----------|----------|
| Missing `--prompt` and stdin is a TTY | 1 | Error: "No prompt provided. Use --prompt, --pipe, or interactive mode." |
| Unknown flag | 1 | Print usage, exit |
| Max iterations hit | 2 | Emit partial result, include `stoppedReason` |
| Max cost hit | 3 | Emit partial result, include `stoppedReason` |
| SIGINT during run | 4 | Clean shutdown, emit partial state |
| Permission blocked | 5 | Clear error message directing user to flags |
| API error (no retry) | 1 | Print error, emit partial state in JSON |
| Config load failed | 1 | Print error, exit |
| Working directory doesn't exist | 1 | Print error, exit |

## Testing Plan

1. **Unit tests** (`src/cli/non-interactive.test.ts`):
   - Flag parsing for each combination
   - Exit code mapping
   - JSON output format validity
   - Text output format

2. **Integration tests**:
   - Mock LLM provider, run full non-interactive turn
   - Verify stdout contains only final message in text mode
   - Verify stdout contains valid JSON in JSON mode
   - Verify stderr contains progress in non-quiet mode
   - Permission denial exits with code 5

3. **E2E tests** (in CI):
   - `kondi-chat --prompt "echo test" --pipe` works
   - `kondi-chat --json < input.txt` works
   - Stdin pipe works
   - `--sessions` lists and exits

## Dependencies

- **Depends on:** `src/cli/backend.ts` (refactor shared logic), `src/engine/agent-loop.ts` (new extraction), Spec 01 (Permission System — non-interactive bypass flags), Spec 06 (Session Resume — `--resume` support)
- **Depended on by:** Spec 16 (Packaging — CI installations rely on non-interactive), Spec 18 (Testing — E2E tests use non-interactive)

## Estimated Effort

**2 days** (revised from 4 days)
- Day 1: Extract `runAgentLoop` from `handleSubmit`, refactor `handleSubmit` to call it with an `onEvent` that forwards to the existing `emit` function. Smoke-test interactive mode for no regression.
- Day 2: `non-interactive.ts` — inline flag parsing, stdin read, runs `runAgentLoop`, prints text or JSON. Exit-code mapping. A few E2E tests using a mock LLM.
