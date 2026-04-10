# 03 — Diff Display

## Product Description

Diff Display automatically shows unified diffs after every `write_file` or `edit_file` operation. Diffs are color-coded in the TUI (green for additions, red for deletions), collapsible in the chat view, and expandable to a full detail view. This gives users immediate visual feedback on what the agent changed without needing to manually inspect files.

**Why it matters:** Users need to verify agent-made changes before trusting them. Showing diffs inline in the conversation provides immediate transparency. Without this, users must leave the tool to check file changes, breaking their flow.

**Revised 2026-04-10 (simplification pass):** Dropped `parseDiff` + `DiffHunk`/`DiffLine` structured types — TUI colors by line-prefix directly (`+` green, `-` red, `@@` cyan). Dropped `formatDiffForToolResult` wrapper (inline one line). `DiffOptions` collapsed to hard-coded constants (contextLines=3, maxLines=200). Effort 3 days -> 1.5 days.

## User Stories

1. **Inline diff after edit:** The agent calls `edit_file` on `src/auth.ts`. The tool result includes a unified diff showing exactly what changed. The TUI renders it with red/green coloring directly in the chat message, collapsed by default to the first 10 lines.

2. **Full diff view:** After seeing a collapsed diff, the user presses `^D` (Ctrl+D) to expand the full diff in the detail panel on the right side of the TUI. They can scroll through the entire diff.

3. **New file creation:** The agent calls `write_file` to create a new file. The diff shows the entire file as additions (all lines prefixed with `+`). The header shows `--- /dev/null` and `+++ b/path/to/new/file`.

4. **Multiple edits in one turn:** The agent edits three files in one turn. Each edit shows its own diff. The message groups all diffs at the bottom under a "Changes" section. The user can collapse/expand each diff independently.

5. **Diff in non-interactive mode:** In `--pipe` or `--json` mode (Spec 10), diffs are included in the structured output as plain text unified diff format without ANSI colors.

## Clarifications (2026-04-09)

- **Authoritative payload:** the tool result’s `diff` field is the source of truth; `message_update.tool_calls[*].diff` must mirror it byte-for-byte. If both are present and differ, treat as an error.
- **Large files:** if original or updated file exceeds 200 KB or 5,000 lines, skip LCS and return `{ truncated: true, reason: 'file-too-large' }` (no patch).
- **File ops covered:** add/modify/delete/rename/binary. For rename include `oldPath`; for binary set `binary: true` and omit patch.
- **Whitespace/no-op:** if diff is empty or whitespace-only, return `{ empty: true }` and do not render an empty patch block.
- **Collapse rules:** preview shows whole hunks up to 10 lines per hunk; never cut inside hunk headers. Key diffs by `filePath + toolCallId` so rerenders stay stable.
- **Keybindings:** keep Ctrl+D but also support Ctrl+E to expand/collapse (fallback when ^D is intercepted as EOF).
- **JSON/pipe schema:** `{ files: DiffFile[], truncated?: bool }` where `DiffFile` is `{ path, status, patch?, binary?, truncated?, oldPath? }`. Patch text is UTF-8 and JSON-escaped when structured.
- **Failure handling:** if write/edit fails, return an error and no diff. When tools pass `original/updated/oldString/newString`, backend must diff on-disk pre/post contents; do not trust caller-supplied strings.
## Technical Design

### Architecture

```
write_file / edit_file tool
        |
        v
  Read original content (before write)
  Write new content
  Compute unified diff (src/engine/diff.ts)
        |
        v
  Return diff in tool result
        |
        v
  Backend includes diff in message_update event
        |
        v
  TUI parses diff lines
  Renders with color coding
  Supports collapse/expand
```

### Diff Computation

Diffs are computed using a line-by-line longest common subsequence (LCS) algorithm, producing standard unified diff format. No external dependency required — the implementation is self-contained at ~150 lines.

### Diff Format

Standard unified diff:

```
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -12,7 +12,9 @@ function validateToken(token: string) {
   const decoded = jwt.verify(token, SECRET);
-  if (!decoded) {
-    throw new Error('Invalid token');
+  if (!decoded || typeof decoded !== 'object') {
+    const err = new AuthError('Invalid token');
+    err.code = 'TOKEN_INVALID';
+    throw err;
   }
   return decoded;
```

## Implementation Details

### New files

**`src/engine/diff.ts`**

```typescript
const CONTEXT_LINES = 3;
const MAX_LINES = 200;

export interface DiffResult {
  diff: string;       // unified diff string (with --- / +++ headers)
  linesAdded: number;
  linesRemoved: number;
  truncated: boolean;
}

/**
 * Compute a unified diff between two strings. For new files, oldContent = ''.
 * For deleted files, newContent = ''.
 */
export function computeUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): DiffResult;
```

No `parseDiff`, `DiffHunk`, or `DiffLine`. The TUI colors diff lines by first-character: `+` green, `-` red, `@@` cyan, else default. `formatDiffForToolResult` is inlined at the two call sites in `tools.ts` as a single template literal.

### Modified files

**`src/engine/tools.ts`** — Modify `toolWriteFile()` and `toolEditFile()`:

**Revised:** `computeUnifiedDiff` is declared in both Spec 02 and Spec 03 SPEC drafts. Spec 03 owns it (`src/engine/diff.ts`); Spec 02's git-tools must import from `./diff.ts`, not re-declare. `formatGitContextForPrompt` stays in `git-tools.ts`; only the diff algorithm is shared.

```typescript
import { computeUnifiedDiff } from './diff.ts';

function toolWriteFile(args, ctx) {
  // ... path safety, capture originalContent (or ''), backup, write ...
  const d = computeUnifiedDiff(relPath, originalContent, newContent);
  return {
    content: `${originalContent ? 'Updated' : 'Created'} ${relPath} (+${d.linesAdded}/-${d.linesRemoved})`,
    diff: d.diff,
  };
}
// toolEditFile follows the same pattern.
```

**`tui/src/protocol.rs`** — Add `diff` field to `ToolCallInfo`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallInfo {
    pub name: String,
    pub args: String,
    pub result: Option<String>,
    pub is_error: bool,
    pub diff: Option<String>,  // NEW: unified diff if tool produced one
}
```

**`tui/src/ui.rs`** — Add diff rendering with color coding:

```rust
/// Render a unified diff with color coding.
/// Lines starting with '+' are green, '-' are red, '@@' are cyan.
fn render_diff(diff: &str, area: Rect, buf: &mut Buffer, collapsed: bool) {
    // If collapsed, show first 10 lines + "... N more lines (^D to expand)"
    // Color coding:
    //   '+' lines -> Style::default().fg(Color::Green)
    //   '-' lines -> Style::default().fg(Color::Red)
    //   '@@ ... @@' lines -> Style::default().fg(Color::Cyan)
    //   context lines -> Style::default()
}
```

**`tui/src/app.rs`** — Add diff collapse state tracking:

```rust
pub struct App {
    // ... existing fields
    /// Collapsed state per tool call (keyed by tool call index within message)
    pub collapsed_diffs: HashMap<String, bool>,
}

impl App {
    pub fn toggle_diff_collapse(&mut self, diff_key: &str) {
        let entry = self.collapsed_diffs.entry(diff_key.to_string()).or_insert(true);
        *entry = !*entry;
    }
}
```

### Backend message format

When a tool produces a diff, the backend includes it in the `message_update` event's `tool_calls` array:

```json
{
  "type": "message_update",
  "id": "msg-123",
  "tool_calls": [
    {
      "name": "edit_file",
      "args": "src/auth.ts",
      "result": "Edited src/auth.ts: replaced 45 chars with 120 chars (+4/-2)",
      "is_error": false,
      "diff": "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -12,7 +12,9 @@..."
    }
  ]
}
```

## Protocol Changes

### Modified: `ToolCallInfo` struct

Add optional `diff` field (string, unified diff format). This field is only populated for `write_file` and `edit_file` tool calls.

### New keyboard shortcut: `^D`

Toggles the detail view to show the full diff for the most recent tool call that produced a diff. If the detail view is already showing a diff, `^D` cycles through diffs in the current message.

## Configuration

No configuration. All values are constants in `src/engine/diff.ts` (`CONTEXT_LINES=3`, `MAX_LINES=200`, collapsed preview = 10 lines, collapsed by default). **Revised:** removed the config block — nobody tunes diff context lines, and it saved code to delete the plumbing.

### Tool-result plumbing in backend.ts

**Revised:** the current `handleSubmit` builds `allToolCalls.push({ name, args, result: capped.slice(0, 300), is_error })` — it drops everything except a 300-char `result` preview, and has no `diff` slot. To land this spec:

1. Extend `ToolResult` in `src/types.ts` with `diff?: string` (CONVENTIONS.md already does this).
2. Tool executors return `{ content, isError, diff }` where applicable.
3. In `handleSubmit`, push `{ name, args, result: capped.slice(0, 300), is_error, diff: result.diff }` into `allToolCalls`.
4. The `message_update.tool_calls` array already round-trips to the TUI; no new event is needed.

### Interaction with the 3000-char tool result cap

The backend in `src/cli/backend.ts` currently caps tool result content at 3000 characters before sending to the LLM. Diffs are preserved separately so the LLM sees a truncated result summary, but the TUI receives the full diff. The implementation:

1. Tool returns `{ content, diff }` (both full-size)
2. Backend sends full diff to the TUI in the `ToolCallInfo.diff` field
3. Backend truncates `content` to 3000 chars for the LLM message history (existing behavior)
4. If `diff` is large, the LLM sees only the summary ("Edited src/auth.ts +4/-2") — this is usually enough for the agent to know what it did

This separation ensures diffs never get truncated mid-hunk in the UI while keeping LLM input bounded.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Binary file diff | Detect binary content (null bytes), show "Binary file changed" instead of diff |
| Very large diff (>200 lines) | Truncate with `... (N more lines)` message, full diff available via `^D` |
| File encoding issues | Fall back to raw byte length comparison, no line-level diff |
| Diff computation fails | Return tool result without diff, log warning to stderr |
| New file with >1000 lines | Show first 50 lines as additions + truncation notice |
| Diff for non-UTF8 file | Treat as binary |
| Multi-file operations (create_task) | Each modified file gets its own diff in a list |

## Testing Plan

1. **Unit tests** (`src/engine/diff.test.ts`):
   - Simple single-line edit produces correct unified diff
   - Multi-hunk edit (changes in multiple locations) produces correct hunks
   - New file diff: oldContent='' produces all-additions diff
   - File deletion diff: newContent='' produces all-deletions diff
   - Context lines parameter works correctly
   - Truncation at maxLines works
   - Binary detection works
   - `parseDiff()` correctly parses unified diff into hunks

2. **Integration tests**:
   - `toolWriteFile` returns diff in result
   - `toolEditFile` returns diff in result
   - Backend includes diff in message_update event

3. **TUI tests**:
   - Diff renders with correct colors
   - Collapse/expand toggle works
   - `^D` opens detail view with full diff
   - Scroll works in diff detail view

## Dependencies

- **Depends on:** `src/engine/tools.ts` (integration point for write/edit tools)
- **Depended on by:** Spec 02 (Git Integration — git_diff tool reuses diff rendering), Spec 05 (Undo/Checkpoints — shows diff of what undo reverted)
- **External:** None (self-contained diff algorithm)

## Estimated Effort

**1.5 days** (revised from 3 days)
- Morning: `diff.ts` — LCS unified diff (one function, one DiffResult type).
- Afternoon: Tool integration, add `diff` field to `ToolCallInfo` protocol, plumb through `handleSubmit`.
- Day 2 morning: TUI prefix-based coloring, `^D` detail view, smoke tests.
