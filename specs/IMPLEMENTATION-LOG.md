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
