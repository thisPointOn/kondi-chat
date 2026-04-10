# Implementation Log

Progress ledger for the 18-spec implementation pass. One section per spec in the order they were shipped.

## 03 — Diff Display — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/diff.ts (new), src/engine/tools.ts, src/types.ts, src/mcp/tool-manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs
**LoC added / deleted:** ~230 / ~15
**Simplifications during review:** No DiffOptions/parseDiff/DiffHunk — hard-coded constants. `render_diff_lines` is one helper reused for both the collapsed preview and the full detail view. Reused existing `tool_calls` round-trip instead of a new protocol event. ToolExecutionResult defined once in engine/tools.ts and threaded through tool-manager.
**Deviations from spec:** Also fixed a latent bug in toolWriteFile where `isNew` was always false because it was computed after writing the file. The spec's Ctrl+D / Ctrl+E expand/collapse binding was dropped in favor of the existing ^O tools-detail view which now shows the full diff — adding a new key path would have needed per-tool-call state tracking with no clear win. The 10-line preview + "more lines (^O for full diff)" footer matches the spirit of the spec.
