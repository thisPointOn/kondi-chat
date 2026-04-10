# Cross-Spec Conventions

This document captures naming conventions, shared types, file layout rules, and cross-feature interaction rules that apply across all specs. Changes here apply everywhere.

## File layout

All new code follows existing module boundaries:

```
src/
  audit/              # Ledger, analytics, telemetry aggregation
    ledger.ts                (existing)
    analytics.ts             (existing)
    telemetry.ts             (Spec 15, new — single file, not a directory)
  cli/                # CLI entry, backend, TUI bridge
    backend.ts               (existing, will be refactored)
    main.tsx                 (existing)
    non-interactive.ts       (Spec 10, new)
    wizard.ts                (Spec 16, new)
    help.ts                  (Spec 17, new)
  context/
    manager.ts               (existing, will be extended)
    bootstrap.ts             (existing)
    memory.ts                (Spec 04, new)
  engine/
    tools.ts                 (existing, will be extended)
    pipeline.ts              (existing)
    apply.ts                 (existing)
    verify.ts                (existing)
    task-card.ts             (existing)
    loop-guard.ts            (existing)
    diff.ts                  (Spec 03, new)
    git-tools.ts             (Spec 02, new)
    checkpoints.ts           (Spec 05, new)
    sub-agents.ts            (Spec 07, new)
    agent-loop.ts            (Spec 10, new — extracted from backend.ts)
    images.ts                (Spec 09, new)
    permissions.ts           (Spec 01, new — single file, not a directory)
    hooks.ts                 (Spec 12, new — single file, not a directory)
  providers/
    llm-caller.ts            (existing, will be extended — Spec 13 retry inlined here)
    rate-limiter.ts          (Spec 14, new)
  session/
    store.ts                 (Spec 06, new)
  web/
    manager.ts               (Spec 11, new)
    extractor.ts             (Spec 11, new)
    (rate-limiter reused from providers/rate-limiter.ts — Spec 14)
  test-utils/
    mock-llm.ts              (Spec 18, new)
    fixture-repo.ts          (Spec 18, new)
```

## Shared types (additions to `src/types.ts`)

```typescript
// Content parts (Spec 09 — images)
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string };

export interface LLMMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  parts?: ContentPart[];  // for multimodal
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface LLMResponse {
  // ... existing
  responseHeaders?: Record<string, string>;  // Spec 14 — rate limit headers
  wasFallback?: boolean;
  requestedModel?: string;
}

// Tool results support diff (Spec 03)
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  diff?: string;            // Spec 03 — unified diff
  hookResults?: Array<{ key: string; success: boolean }>;  // Spec 12
}

// Ledger extension (Spec 07 — sub-agent tagging)
export interface LedgerEntry {
  // ... existing
  subAgentId?: string;
  subAgentType?: 'research' | 'worker' | 'planner';
}

// Image attachment (Spec 09)
export interface ImageAttachment {
  mimeType: string;
  base64: string;
  originalPath?: string;
  sizeBytes: number;
}
```

## Extended `ToolContext`

All specs that add tool-context state converge on this shape in `src/engine/tools.ts`:

```typescript
export interface ToolContext {
  // Existing
  workingDir: string;
  session: Session;
  ledger: Ledger;
  pipelineConfig: PipelineConfig;

  // Spec 04 — Memory
  memoryManager?: MemoryManager;

  // Spec 05 — Checkpoints
  mutatedFiles?: Set<string>;
  checkpointManager?: CheckpointManager;
  currentCheckpointId?: string;

  // Spec 07 — Sub-agents
  subAgentManager?: SubAgentManager;
  toolManager?: ToolManager;
  emit?: (event: any) => void;
  parentSubAgentId?: string;  // undefined for root agent

  // Spec 08 — Persistent loop
  loopGuard?: LoopGuard;

  // Spec 01 — Permissions
  permissionManager?: PermissionManager;

  // Spec 12 — Hooks
  hookRunner?: HookRunner;

  // Spec 15 — Telemetry
  telemetry?: TelemetryEmitter;
}
```

## Config file layout

All config files live in `.kondi-chat/` (project-local) or `~/.kondi-chat/` (user-global). User config is loaded first, project overrides.

```
.kondi-chat/
  config.json                # General settings (Spec 16)
  permissions.json           # Spec 01
  hooks.json                 # Spec 12
  rate-limits.json           # Spec 14
  recovery.json              # Spec 13
  telemetry.json             # Spec 15
  web.json                   # Spec 11
  models.yml                 # Existing (registry)
  profiles/                  # Existing (budget profiles)
  sessions/                  # Spec 06
    index.json
    active.json
    <id>.json
  checkpoints/               # Spec 05
    index.json
    <session-id>/
      <checkpoint-id>/
  backups/                   # Existing
  web-cache/                 # Spec 11
  recovery/                  # Spec 13
    <session-id>-partial.json
  analytics.json             # Existing + Spec 15 extensions
  <session-id>-ledger.json   # Existing — FLAT at storageDir root, not under sessions/
  <session-id>-session.json  # Existing — written on /quit by main.tsx, flat
```

**Note:** the two existing flat files above pre-date Spec 06's `sessions/<session-id>.json` layout. Specs 06 and 13 must treat these as authoritative on-disk shape: `Ledger` loads `<sessionId>-ledger.json` from `storageDir` root in its constructor, and `main.tsx` writes `<sessionId>-session.json` flat on exit. Do not move these files; either leave ledger flat and put new session state under `sessions/`, or migrate on first boot inside SessionStore. See Spec 06 "Revised" block for the full rationale.

## Naming conventions

### Commands (slash commands)

- Lowercase, single word preferred: `/help`, `/cost`, `/undo`, `/sessions`
- Multi-word with hyphen: `/rate-limits`
- Subcommands: `/telemetry enable`, `/council run`
- All commands respond to `/help <cmd>` with usage

### Config keys

- camelCase in JSON files: `maxIterations`, `contextBudget`, `loopCostCap`
- Consistent nesting by feature: `{ "permissions": { ... }, "hooks": { ... } }` in `config.json`, OR per-feature files

### Tool names

- snake_case: `read_file`, `write_file`, `spawn_agent`, `update_memory`
- Git tools prefixed `git_`: `git_status`, `git_commit`
- Web tools prefixed `web_`: `web_search`, `web_fetch`

### Event and command types (JSON-RPC)

- snake_case: `permission_request`, `message_update`, `sub_agent_started`
- Backend -> TUI events always past-tense or noun: `ready`, `error`, `tool_call`, `sub_agent_completed`
- TUI -> Backend commands always imperative: `submit`, `command`, `quit`, `permission_response`

### Type names

- PascalCase: `PermissionManager`, `CheckpointManager`, `GitContext`
- Interfaces end in noun: `PermissionConfig`, `CheckpointOptions`, `HookResult`
- Enums in PascalCase string literals: `'auto-approve' | 'confirm' | 'always-confirm'`

## Cross-feature interaction rules

### Permissions + Hooks (Specs 01, 12)

**Execution order for a tool call:**

1. `hookRunner.runBefore(tool, args)` — before hooks first
2. If before hooks blocked: abort, return error
3. `permissionManager.check(tool, args)` — then permission check
4. If permission required and denied: abort, return error
5. Actual tool execution
6. `hookRunner.runAfter(tool, args, result)` — after hooks
7. Return augmented result

**Rationale:** Hooks run first so policies like "block writes to node_modules/" apply even before the permission dialog. Permission check is second so user confirmation still applies to tools that pass hooks.

### Permissions + Sub-agents (Specs 01, 07)

Sub-agents inherit parent `PermissionManager`. Permission requests from sub-agents include `subAgentId` and `subAgentType` fields so the TUI can show "sub-agent 'research' wants to run: ...".

Session-level approvals (approve-all-for-session) are shared between parent and all sub-agents in the same session.

### Permissions + Non-interactive (Specs 01, 10)

Non-interactive mode has no TTY for confirmation prompts. Must use one of:
- `--dangerously-skip-permissions` — auto-approve all
- `--auto-approve <tool1,tool2>` — auto-approve specific tools
- Default: `confirm`-tier tools fail with exit code 5

### Checkpoints + Git (Specs 05, 02)

In git mode, checkpoints use `git stash create` to capture state. The stash hash is stored in the checkpoint metadata. This is separate from the git history — stashes are unreferenced commits that are only reachable via the checkpoint metadata. A `git gc` can collect them; therefore checkpoints are best-effort, and users should commit important work.

`git_commit` tool calls trigger a checkpoint before the commit (so `/undo` can revert the commit via `git reset --soft HEAD~1`).

### Checkpoints + Session Resume (Specs 05, 06)

Checkpoints are session-scoped. Storage: `.kondi-chat/checkpoints/<session-id>/`. When a session is resumed, its checkpoints are loaded. When a session is deleted or archived, its checkpoints are deleted or archived with it.

### Checkpoints + Hooks (Specs 05, 12)

Hook-invoked tools (via `tool:` hook type) do **not** create a new checkpoint. The checkpoint for the turn is created before the first mutation and covers all subsequent mutations, including hook-triggered ones.

### Error Recovery + Session Resume (Specs 13, 06)

Recovery uses periodic session saves from Spec 06 as its persistence mechanism. RecoveryManager adds partial-message saves on top, stored in `.kondi-chat/recovery/<session-id>-partial.json`. On TUI-triggered backend restart, the new backend calls `--resume <session-id>` and also checks for a partial file, integrating it as the last message.

### Error Recovery + Rate Limiting (Specs 13, 14)

When the rate limiter's queue overflows (`RateLimitOverflowError`), Spec 13's retry layer catches it and triggers the fallback provider path. When a provider returns 429, both the rate limiter (to pause the bucket) and the retry layer (to handle the error) see the event. Rate limiter pauses, retry layer tries the next provider.

### Memory + Checkpoints (Specs 04, 05)

`update_memory` tool calls are tracked in `mutatedFiles` and counted as a mutation that triggers checkpoint creation. The memory file paths (KONDI.md) are part of the checkpoint just like any other file. `/undo` after `update_memory` reverts the memory file.

### Sub-agents + Rate Limiting (Specs 07, 14)

Sub-agents share the parent's `globalRateLimiter`. All LLM calls (parent and children) consume the same per-provider rate limit buckets. This means spawning 3 sub-agents won't triple your effective rate — it just uses the existing budget more densely.

### Sub-agents + Telemetry (Specs 07, 15)

Sub-agent spawning emits a `feature_used: 'sub_agent_spawned'` event. Individual tool calls inside sub-agents emit normal `tool_called` events (with the same category) — telemetry doesn't differentiate parent vs sub-agent at the event level (too specific, not useful aggregated).

### Images + Router (Specs 09, 14)

The router's `select()` accepts a new `hasImages` parameter. When `true`, the router filters to models with the `vision` capability (string literal in `ModelEntry.capabilities`). Built-in vision-capable models have this capability pre-tagged in the default `models.yml`.

### Web tools + Permissions (Specs 11, 01)

Web tools default to `confirm` tier because they make external network calls. Users can set `"web_search": "auto-approve"` if they trust the backend. `web_fetch` defaults to `confirm` because the fetched URL is agent-chosen and could be surprising.

## Environment variables (global)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `OPENAI_API_KEY` | OpenAI provider |
| `DEEPSEEK_API_KEY` | DeepSeek provider |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini |
| `XAI_API_KEY` | xAI Grok |
| `OLLAMA_BASE_URL` | Ollama local server |
| `BRAVE_SEARCH_API_KEY` | Spec 11 — Brave Search backend |
| `SERPAPI_API_KEY` | Spec 11 — SerpAPI backend |
| `KONDI_CONFIG_DIR` | Override config location |
| `KONDI_NO_UPDATE_CHECK` | Spec 16 — disable auto-update check |
| `KONDI_CHAT_NO_TELEMETRY` | Spec 15 — hard-disable telemetry |
| `KONDI_BACKEND` | Spec 16 — override backend binary path |

## JSON-RPC protocol additions summary

New backend → TUI events:

| Event | Introduced by |
|-------|---------------|
| `permission_request` | Spec 01 |
| `sub_agent_event` | Spec 07 |

New TUI → backend commands:

| Command | Introduced by |
|---------|---------------|
| `permission_response` | Spec 01 |
| (extended `submit` with `images`) | Spec 09 |

Modified events:

| Event | Change | Introduced by |
|-------|--------|---------------|
| `ready` | Add `git_info`, `resumed`, `resumed_session_id`, `resumed_message_count` fields | Specs 02, 06 |
| `ToolCallInfo` | Add `diff` field | Spec 03 |
| `message_update` stats | Add `persist_iterations` | Spec 08 |

## Implementation order suggestion

Recommended order for minimum risk and maximum early value:

1. **Spec 03 (Diff Display)** — small, isolated, improves immediate UX
2. **Spec 04 (Memory)** — isolated, immediate value
3. **Spec 01 (Permissions)** — foundational for safety, blocks later specs
4. **Spec 02 (Git Integration)** — builds on Spec 01
5. **Spec 05 (Checkpoints)** — builds on Spec 02
6. **Spec 06 (Session Resume)** — builds on Spec 05
7. **Spec 13 (Error Recovery)** — builds on Spec 06
8. **Spec 14 (Rate Limiting)** — infrastructure, benefits all later work
9. **Spec 12 (Hooks)** — builds on Spec 01
10. **Spec 10 (Non-interactive)** — builds on Spec 01 (requires refactor of backend)
11. **Spec 18 (Testing)** — ongoing, but CI setup should land here
12. **Spec 07 (Sub-agents)** — builds on Specs 01, 14
13. **Spec 08 (Persistent Loop)** — builds on existing LoopGuard
14. **Spec 11 (Web Tools)** — builds on Spec 01, 14
15. **Spec 09 (Images)** — provider changes, mostly isolated
16. **Spec 15 (Telemetry)** — after major features land so metrics are meaningful
17. **Spec 16 (Packaging)** — near the end, ships what's been built
18. **Spec 17 (Documentation)** — latest, after surface area is stable
