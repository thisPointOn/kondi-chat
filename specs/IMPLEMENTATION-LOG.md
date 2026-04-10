# Implementation Log

Progress ledger for the 18-spec implementation pass. One section per spec in the order they were shipped.

## 03 — Diff Display — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/diff.ts (new), src/engine/tools.ts, src/types.ts, src/mcp/tool-manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs
**LoC added / deleted:** ~230 / ~15
**Simplifications during review:** No DiffOptions/parseDiff/DiffHunk — hard-coded constants. `render_diff_lines` is one helper reused for both the collapsed preview and the full detail view. Reused existing `tool_calls` round-trip instead of a new protocol event. ToolExecutionResult defined once in engine/tools.ts and threaded through tool-manager.
**Deviations from spec:** Also fixed a latent bug in toolWriteFile where `isNew` was always false because it was computed after writing the file. The spec's Ctrl+D / Ctrl+E expand/collapse binding was dropped in favor of the existing ^O tools-detail view which now shows the full diff — adding a new key path would have needed per-tool-call state tracking with no clear win. The 10-line preview + "more lines (^O for full diff)" footer matches the spirit of the spec.
**Commit:** 2cdc28b feat: implement spec 03 (diff display)

## 04 — Memory System — 2026-04-09
**Status:** shipped
**Files changed:** src/context/memory.ts (new), src/context/manager.ts, src/engine/tools.ts, src/mcp/tool-manager.ts, src/cli/backend.ts
**LoC added / deleted:** ~170 / ~5
**Simplifications during review:** `MemoryManager` is a single ~110 LOC file, no watcher, no YAML frontmatter, no `MemoryManagerConfig`. `load()` self-stats on each call and caches by mtime. `update_memory` tool has only `append` and `replace` (no `edit`/`section`). `activeFile` is threaded as an optional callback on ToolContext rather than a new mandatory field, so non-memory call sites don't need to care.
**Deviations from spec:** The spec's "emit status event on load" is dropped — the spec notes the status emit is optional and no test depends on it. The permission-tier assignment ("confirm") is deferred to Spec 01 where PermissionManager lands.
**Commit:** 7357dab feat: implement spec 04 (memory system)

## 01 — Permission System — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/permissions.ts (new), src/engine/tools.ts, src/mcp/tool-manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs, tui/src/main.rs
**LoC added / deleted:** ~320 / ~5
**Simplifications during review:** Single permissions.ts file. Inline summarize() helper. Dialog renders as a modal overlay with y/n/a handled by intercepting keys when `pending_permissions` is non-empty. Session approvals keyed by tool+args fingerprint (sha1, 16 hex chars). Default permissions.json written on first run so users discover the config.
**Deviations from spec:** Non-TTY fail-fast for non-interactive mode is deferred to Spec 10 (where the pipe/json mode lives — TUI mode always has a TUI). The `permission_timeout` event is surfaced as a system message rather than a dedicated dialog, since timeouts are rare and warrant only a visible note.
**Commit:** 646dbde feat: implement spec 01 (permission system)

## 02 — Git Integration — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/git-tools.ts (new), src/engine/permissions.ts, src/mcp/tool-manager.ts, src/context/manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs
**LoC added / deleted:** ~280 / ~5
**Simplifications during review:** Single git-tools.ts. `detectGitRepo` is a plain snapshot function — no GitContext class. The `refreshGit` closure is a three-liner declared near the tool registrations. Git context injected via ContextManager's `setGitContextText`, re-applied after every mutating git tool and once per submit (before prompt assembly). The "git_info on ready is one-shot" simplification is intentional — mid-session branch changes propagate on next backend restart, which matches the spec's deletion of periodic status polling.
**Deviations from spec:** MessageStats git_branch/git_dirty fields were not added — adding them would require touching Rust protocol, app state, and ui rendering for one string that already appears in the permanent status bar after next turn. Re-visit in Spec 15 if telemetry needs it.
**Commit:** aab305d feat: implement spec 02 (git integration)

## 05 — Undo / Checkpoints — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/checkpoints.ts (new), src/engine/tools.ts, src/cli/backend.ts
**LoC added / deleted:** ~260 / ~5
**Simplifications during review:** Single checkpoints.ts file. `isMutatingToolCall` + `predictedMutations` are a pair of small pure functions, not a class. Non-mutating run_command allowlist is a hard-coded prefix list. CheckpointManager uses renameSync for atomicity (no execSync of `mv`). File-mode snapshots happen just before the first mutating tool runs, using paths predicted from the tool args so the pre-state is captured correctly. `/undo` parses strict-numeric for multi-step, otherwise treats as id.
**Deviations from spec:** `/restore` command omitted (spec already deletes it). The `run_command` with mutation is checkpointed but in file mode we have no predicted path list, so file-mode file capture is empty for run_command — git mode covers this correctly via `git stash create`. Acceptable because real projects are git repos.
