# 05 — Undo / Checkpoints

## Product Description

The Undo/Checkpoint system automatically creates restore points before any agent turn that modifies files. Users can revert mistakes with `/undo`, step back multiple turns with `/undo N`, and browse available restore points with `/checkpoints`. Checkpoints use git stash when available (fast, efficient) or file copies as a fallback.

**Why it matters:** AI agents make mistakes. Without a reliable undo mechanism, users must manually revert changes or rely on git, which may not capture intermediate states. Automatic per-turn checkpoints give users confidence to experiment and recover quickly from bad agent suggestions.

**Revised 2026-04-10 (simplification pass):** Deleted `/restore` command (redundant — `/undo <id>` does the same thing). Deleted `CheckpointManager.update()` (unused). Deleted the structured payload on `command_result` (TUI renders plain text; no consumers of the structured version). Collapsed the mutating/non-mutating `run_command` pattern lists into a hard-coded allowlist of safe read-only commands in `checkpoints.ts`. Effort dropped from 4 days to 2 days.

## User Stories

1. **Quick undo:** The agent refactors a function but the user doesn't like the result. They type `/undo` and all changes from the last turn are reverted. The session continues from before the bad change.

2. **Multi-step undo:** The agent has made three changes across multiple turns, each making things worse. The user runs `/undo 3` to revert the last three checkpoints. The TUI shows a summary of what was reverted.

3. **Browse checkpoints:** Before undoing, the user runs `/checkpoints` to see all restore points with timestamps, summaries, and costs. They pick a specific checkpoint ID to restore to: `/undo cp-1712438400`.

4. **Checkpoint retention:** After 25 turns with edits, the user has hit the default retention limit of 20. The oldest checkpoint (#1) is automatically pruned to make room for the new one.

5. **Non-git project:** The user is in a directory that isn't a git repo. Checkpoints fall back to file-copy mode, copying modified files to `.kondi-chat/checkpoints/<id>/`. Undo restores them.

## Clarifications (2026-04-09)

- **/undo parsing:** `/undo` restores latest; `/undo <id|index>` restores the given checkpoint. Reject non-numeric/unknown ids; do not coerce to `1`.
- **Checkpoint timing:** snapshot before the first mutating action. In file mode, copy files immediately from disk; do not depend on `mutatedFiles` after writes.
- **Git mode durability:** use `git stash push` (named) so objects persist; if stash fails, fall back to file mode and warn.
- **Mutation detection:** prefer actual mutating tool invocations (write/edit/run_command with mutation, git commit/branch/pr) over name heuristics; maintain explicit allowlist/denylist.
- **Scope:** checkpoints are per session; aborted turns (`^C`) leave the last checkpoint intact. `/undo` output must state which checkpoint and which turn created it.
- **Restore conflicts:** stash current dirty state before restore, name it, and never delete it automatically. Handle deletes/renames explicitly in file mode.
- **Atomicity:** write checkpoint data and index via temp+rename; pruning must be crash-safe—if pruning fails, keep prior index.
## Technical Design

### Architecture

```
Before agent turn with mutations:
  ┌─────────────────────────────────┐
  │ CheckpointManager.create()      │
  │                                 │
  │  if git repo:                   │
  │    git stash create             │
  │    store stash ref + metadata   │
  │  else:                          │
  │    snapshot modified files      │
  │    store file copies + metadata │
  └─────────────────────────────────┘
              │
              v
  ┌─────────────────────────────────┐
  │ Store in .kondi-chat/           │
  │   checkpoints/                  │
  │     index.json                  │
  │     cp-1712438400/              │
  │       meta.json                 │
  │       [stash-ref or files]      │
  └─────────────────────────────────┘
```

### When checkpoints are created

A checkpoint is created lazily: **just before** the first mutating tool call in a turn. This ensures we only checkpoint when necessary. Mutating tools are defined as:

- `write_file`
- `edit_file`
- `create_task` (task cards apply changes via pipeline)
- `update_memory`
- `git_commit`, `git_branch`, `git_create_pr` (git state changes)
- `run_command` with a command matching a "mutating" pattern (e.g., `npm install`, `cargo build`, anything that modifies filesystem)

For `run_command`, we use a heuristic whitelist of non-mutating commands (`ls`, `cat`, `grep`, `find`, `git status`, etc.) to skip checkpointing.

### Checkpoint storage

**Git mode (preferred):**
- Uses `git stash create` to capture a stash commit without modifying working tree
- Stores the stash hash in `meta.json`
- Very fast, efficient, captures full working tree state
- Restored via `git stash apply <hash>`

**File mode (fallback):**
- Tracks mutations in the current turn via `ToolContext.mutatedFiles` set
- On checkpoint creation, copies each mutated file to `.kondi-chat/checkpoints/<id>/files/<path>`
- Also stores the pre-mutation backup from `.kondi-chat/backups/latest/`
- Restored by copying files back to their original paths

### Checkpoint metadata

```json
{
  "id": "cp-1712438400-abc",
  "turnNumber": 5,
  "timestamp": "2026-04-06T14:00:00Z",
  "mode": "git",
  "stashRef": "stash@{0}",
  "preStashHead": "abc123",
  "filesChanged": ["src/auth.ts", "src/auth.test.ts"],
  "summary": "Refactored token validation",
  "costUsd": 0.0234,
  "userMessage": "refactor the auth to use JWT"
}
```

## Implementation Details

### New files

**`src/engine/checkpoints.ts`**

```typescript
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type CheckpointMode = 'git' | 'file';

export interface Checkpoint {
  id: string;
  turnNumber: number;
  timestamp: string;
  mode: CheckpointMode;
  stashRef?: string;
  preStashHead?: string;
  filesChanged: string[];
  summary: string;
  costUsd: number;
  userMessage: string;
}

export interface CheckpointManagerConfig {
  /** Max checkpoints to retain (default: 20) */
  maxCheckpoints?: number;
  /** Use git stash if available (default: true) */
  preferGit?: boolean;
  /** Storage directory (default: .kondi-chat/checkpoints) */
  storageDir?: string;
}

export class CheckpointManager {
  private workingDir: string;
  private config: Required<CheckpointManagerConfig>;
  private checkpoints: Checkpoint[];
  private indexPath: string;
  private isGitRepo: boolean;

  constructor(workingDir: string, config?: CheckpointManagerConfig);

  /** Create a new checkpoint before mutating operations */
  create(summary: string, userMessage: string, turnNumber: number, costUsd?: number): Checkpoint;

  /** Restore to a specific checkpoint (by id or negative index) */
  restore(target: string | number): {
    restored: Checkpoint;
    filesRestored: string[];
    errors: string[];
  };

  /** List all checkpoints, newest first */
  list(): Checkpoint[];

  /** Get a specific checkpoint by id */
  get(id: string): Checkpoint | undefined;

  /** Delete a checkpoint */
  remove(id: string): void;

  /** Prune old checkpoints beyond maxCheckpoints */
  prune(): number;

  /** Format checkpoints for /checkpoints command output */
  format(): string;

  private createGitCheckpoint(summary: string, userMessage: string, turnNumber: number, cost: number): Checkpoint;
  private createFileCheckpoint(summary: string, userMessage: string, turnNumber: number, cost: number, files: string[]): Checkpoint;
  private restoreGitCheckpoint(cp: Checkpoint): string[];
  private restoreFileCheckpoint(cp: Checkpoint): string[];
  private saveIndex(): void;
  private loadIndex(): Checkpoint[];
}
```

### Modified files

**`src/cli/backend.ts`**

- Initialize `CheckpointManager` on startup
- Track `mutatedFilesThisTurn` set reset at start of each `handleSubmit()`
- Before first mutation in a turn, call `checkpointManager.create()`
- Add `/undo`, `/checkpoints`, `/restore` commands in `handleCommand()`

```typescript
// In handleSubmit, at the start:
const turnNumber = session.messages.filter(m => m.role === 'user').length + 1;
let checkpointCreated: Checkpoint | undefined;

// Wrap tool execution with mutation detection:
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'create_task', 'update_memory', 'git_commit', 'git_branch']);

// Before executing a mutating tool:
if (MUTATING_TOOLS.has(tc.name) && !checkpointCreated) {
  checkpointCreated = checkpointManager.create(
    `Turn ${turnNumber}: ${input.slice(0, 60)}`,
    input,
    turnNumber,
    totalCost,
  );
}
```

**`src/cli/backend.ts`** — Add commands:

```typescript
case '/undo': {
  const arg = parts[1];
  if (!arg) {
    const result = checkpointManager.restore(-1);
    return `Reverted checkpoint ${result.restored.id} (turn ${result.restored.turnNumber}). Files restored: ${result.filesRestored.length}`;
  }
  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    const result = checkpointManager.restore(-n);
    return `Reverted ${n} checkpoint(s). Files restored: ${result.filesRestored.length}`;
  }
  // Treat as checkpoint ID
  const cp = checkpointManager.get(arg);
  if (!cp) return `Unknown checkpoint id: ${arg}. Run /checkpoints to list.`;
  const result = checkpointManager.restore(arg);
  return `Restored ${result.restored.id}. Files: ${result.filesRestored.join(', ')}`;
}
```

**Revised:** previously used `parseInt(parts[1]) || 1` which coerces any non-numeric id to `1`. Now strict integer regex guards the numeric branch, else ID branch. `/restore` command removed — use `/undo <id>` for the same effect.

case '/checkpoints': return checkpointManager.format();
```

**`src/engine/tools.ts`** — Add `mutatedFiles` tracking to `ToolContext`:

```typescript
export interface ToolContext {
  workingDir: string;
  session: Session;
  ledger: Ledger;
  pipelineConfig: PipelineConfig;
  memoryManager?: MemoryManager;
  mutatedFiles?: Set<string>;  // NEW: populated by write_file, edit_file
  checkpointManager?: CheckpointManager;  // NEW: for checkpoint updates
}
```

In `toolWriteFile()` and `toolEditFile()`:

```typescript
ctx.mutatedFiles?.add(relPath);
```

### Session scoping

Checkpoints are per-session. Storage layout:

```
.kondi-chat/checkpoints/
  <session-id>/
    index.json                 (per-session checkpoint index)
    cp-<timestamp>-<hash>/
      meta.json
      files/  (file mode only)
```

**Revised:** previous draft also mentioned a top-level `.kondi-chat/checkpoints/index.json` in the layout diagram, which would collide with per-session indexes. There is a single per-session `index.json` under `checkpoints/<session-id>/`; no top-level index. `CheckpointManager` is constructed with `{ storageDir: resolve(workingDir, '.kondi-chat/checkpoints', session.id) }`, aligned with CONVENTIONS.md § Checkpoints + Session Resume.

When a session is resumed (Spec 06), its checkpoints load automatically. When a session is archived or deleted, its checkpoint directory is archived/deleted with it.

### Undo mid-turn

If the user hits `^C` during an agent turn and then runs `/undo`, the checkpoint for that (partial) turn is restored. The partial turn's tool calls are reverted, and the agent's in-progress state is discarded. The session message history reflects that the turn was aborted.

If there's no checkpoint yet for the current turn (no mutation happened), `/undo` reverts the previous turn's checkpoint instead.

### Re-checkpoint after restore

After a successful `/undo`, the system does **not** create a new checkpoint on the restoration itself (the restoration is symbolic, not a new forward state). However, the next mutating tool call in a new turn will create a fresh checkpoint normally.

## Protocol Changes

**None.** `/checkpoints` returns plain text via the existing `command_result` event. **Revised:** dropped the `structured` payload — no consumers.

## Configuration

```json
{
  "checkpoints": {
    "maxCheckpoints": 20
  }
}
```

Read-only `run_command` patterns (no checkpoint created) are a hard-coded allowlist in `checkpoints.ts` — `ls`, `cat`, `grep`, `find`, `echo`, `pwd`, `which`, `git status|log|diff`, `npm test`, `npm run test`, `npx vitest`, `cargo check|test|fmt`. Anything not matching is treated as mutating. **Revised:** two configurable pattern lists collapsed into one hard-coded allowlist — nobody will tune these.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Git stash fails (e.g., no changes to stash) | Fall back to file mode for this checkpoint |
| File copy fails (disk full) | Abort the turn, inform the user, don't execute the tool |
| Restore target doesn't exist | Return error with list of available checkpoint IDs |
| Git stash hash no longer exists (external git gc) | Mark checkpoint as corrupt, skip it, warn user |
| Restore conflicts with current working tree | Stash current changes first, warn the user |
| Checkpoint directory corrupted | Rebuild index from subdirectory listing |
| User runs /undo with no checkpoints | "No checkpoints available" |

## Testing Plan

1. **Unit tests** (`src/engine/checkpoints.test.ts`):
   - Create checkpoint in git mode, verify stash ref exists
   - Create checkpoint in file mode, verify files copied
   - Restore git checkpoint, verify working tree matches
   - Restore file checkpoint, verify files restored
   - Prune exceeds maxCheckpoints, oldest removed
   - Index persistence: save and load

2. **Integration tests**:
   - Full turn with edit -> checkpoint created -> /undo reverts edit
   - Multi-turn: 3 checkpoints -> /undo 2 -> correct state
   - Mixed mode: starts in git repo, git is removed mid-session
   - Run_command pattern detection for mutating vs non-mutating

3. **E2E tests**:
   - /checkpoints lists correctly
   - /undo reverts visible state
   - /restore <id> works

## Dependencies

- **Depends on:** Spec 02 (Git Integration — uses git stash), `src/engine/tools.ts` (mutation detection)
- **Depended on by:** Spec 06 (Session Resume — checkpoints are part of session state), Spec 08 (Persistent Loop — each iteration creates a checkpoint)
- **External:** `git` CLI (for git mode, optional)

## Estimated Effort

**2 days** (revised from 4 days)
- Day 1: CheckpointManager (git + file modes), persistence, pruning, index load/save.
- Day 2: Backend integration, mutation detection, `/undo` + `/checkpoints` commands, happy-path tests for both modes.
