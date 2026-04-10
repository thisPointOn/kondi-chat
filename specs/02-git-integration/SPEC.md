# 02 — Git Integration

## Product Description

Git Integration adds first-class git awareness to kondi-chat. The agent gains dedicated git tools (status, diff, commit, log, branch, create PR), the TUI shows git status in the status bar, and file edits automatically display diffs. Safety guardrails prevent destructive git operations without explicit user confirmation.

**Why it matters:** Every coding assistant operates in a git context. Having the agent understand and manipulate git state directly — rather than shelling out via `run_command` — enables safer, more structured interactions. The agent can check what changed before committing, avoid pushing to protected branches, and present clean diffs to the user.

**Revised 2026-04-10 (simplification pass):** Deleted the periodic `git_status_update` event and the 5-second poll — `GitContext` refreshes only after git-mutating tools or file writes (within the same turn). Deleted `refreshGitContext` as a separate function; reuse `detectGitRepo(workingDir)` since it's ~five `execSync` calls. `computeUnifiedDiff` moved to Spec 03's `diff.ts` so there is one diff implementation. Effort dropped from 4-5 days to 2 days.

## User Stories

1. **Automatic git awareness:** User opens kondi-chat in a git repo. The status bar shows `main [clean]` or `feature/auth [3 modified]`. The agent's system prompt includes the current branch and dirty file count.

2. **Agent commits changes:** The user says "commit the auth changes with a good message." The agent calls `git_status` to see what's staged, calls `git_commit` with an auto-generated message, and reports the result. The commit tool respects the permission system (tier: `confirm`).

3. **Safe push prevention:** The agent tries to push to `main`. The permission system detects the branch name via an always-confirm pattern and shows a confirmation dialog. The user declines, and the agent suggests creating a PR instead.

4. **PR creation:** The user says "create a PR for this branch." The agent calls `git_create_pr` with a title and body. The tool requires `gh` CLI to be installed and returns the PR URL.

5. **Diff after edit:** The agent edits `src/auth.ts`. Immediately after the edit, the backend computes a unified diff of the change and includes it in the tool result. The TUI renders the diff with color-coded additions and deletions (see Spec 03).

## Clarifications (2026-04-09)

- **Tool schemas (required):** each tool returns a structured payload:
  - `git_status`: `{ branch, upstream?, ahead, behind, staged: File[], unstaged: File[], untracked: File[], submodules?: SubmoduleStatus[], worktrees?: WorktreeStatus[] }`
  - `git_diff`: `{ files: DiffFile[] }` (each file carries path, status, patch/truncated flag, binary?:bool)
  - `git_log`: `{ entries: [{ hash, title, author, date }] }`
  - `git_branch`: when `create`+`switch` absent → list `{ branches: [{ name, current, upstream?, ahead, behind }] }`; when `create` or `switch` set, return `{ switchedTo, created?:bool }`.
  - `git_commit`: `{ hash, summary, files?: string[] }`; unstaged/untracked are *not* auto-added unless `files` provided or `autoStageOnCommit` true.
  - `git_create_pr`: `{ url, number, branch }`; requires branch pushed; uses origin unless `remote` override provided.
- **Staging semantics:** `git_commit` stages only the provided `files`; if `files` omitted and `autoStageOnCommit` is false, commit fails with a clear error. Deletions are included if the path is listed.
- **Worktrees/submodules:** `GitContext/GitInfo` must include worktree/submodule dirty counts; status bar and prompt should reflect them.
- **Diff generation:** diffs are computed against disk pre/post change; include rename/delete/binary markers; truncate patches at 5k chars but always include `truncated: true` when capped.
- **Safety/permissions:** list-mode/read-only tools are `auto-approve`; mutating tools (`git_commit`, `git_branch` create/switch, `git_create_pr`) follow permission tiers. Always-confirm applies to force pushes.
- **Refresh timing:** Git context is refreshed after any mutating tool (git or file-write) and once per turn before prompt assembly; periodic `git_status_update` emits only when state changed and reuses the same schema as `git_status`.
- **Timeouts:** per-command timeouts are configurable; default 15s with partial-result surfacing (`timeout: true` in payload).
## Technical Design

### Architecture

```
┌──────────────────────────────────────┐
│ Git Tools (src/engine/git-tools.ts)  │
│                                      │
│  git_status    git_diff              │
│  git_commit    git_log               │
│  git_branch    git_create_pr         │
│                                      │
│  GitContext (cached repo state)      │
└───────────────┬──────────────────────┘
                │
    ┌───────────┴───────────┐
    │                       │
    v                       v
ToolManager             StatusBar
(registered as          (polls GitContext
 extra tools)            every 5 seconds)
```

### Git Context

On startup, `GitContext` detects whether the working directory is a git repo and caches:
- Current branch name
- Dirty file count (modified + untracked)
- Whether remote tracking branch exists
- Last commit hash and message

This context is refreshed after every git tool call and periodically (every 5 seconds) for the status bar.

## Implementation Details

### New files

**`src/engine/git-tools.ts`**

```typescript
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.ts';

export interface GitContext {
  isGitRepo: boolean;
  branch: string;
  dirtyCount: number;
  untrackedCount: number;
  lastCommitHash: string;
  lastCommitMessage: string;
  hasRemote: boolean;
  remoteUrl?: string;
}

/** Detect git repo and populate context. Called both on startup and after any mutating tool. */
export function detectGitRepo(workingDir: string): GitContext;

/** Format git context for system prompt injection */
export function formatGitContextForPrompt(ctx: GitContext): string;

// `computeUnifiedDiff` lives in `src/engine/diff.ts` (Spec 03). Do not duplicate.

export const GIT_TOOLS: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Show the current git status: branch, modified files, staged files, untracked files.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Show the git diff for staged or unstaged changes. Use path to filter to specific files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to diff (optional, diffs all if omitted)' },
        staged: { type: 'boolean', description: 'Show staged changes only (default: false)' },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Stage files and create a git commit. If no files specified, commits all modified tracked files.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message' },
        files: {
          type: 'array', items: { type: 'string' },
          description: 'Files to stage before committing (optional)',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git log entries.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits to show (default: 10)' },
        oneline: { type: 'boolean', description: 'One-line format (default: true)' },
      },
    },
  },
  {
    name: 'git_branch',
    description: 'List branches or create/switch to a branch.',
    parameters: {
      type: 'object',
      properties: {
        create: { type: 'string', description: 'Create and switch to a new branch with this name' },
        switch: { type: 'string', description: 'Switch to an existing branch' },
      },
    },
  },
  {
    name: 'git_create_pr',
    description: 'Create a GitHub pull request for the current branch. Requires the gh CLI.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR body/description' },
        base: { type: 'string', description: 'Base branch (default: main)' },
        draft: { type: 'boolean', description: 'Create as draft PR (default: false)' },
      },
      required: ['title'],
    },
  },
];

/** Execute a git tool. All git operations go through execSync with cwd=workingDir. */
export async function executeGitTool(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  gitCtx: GitContext,
): Promise<{ content: string; isError?: boolean }>;
```

### Modified files

**`src/cli/backend.ts`**

- Import and initialize `GitContext` on startup:
  ```typescript
  import { detectGitRepo, formatGitContextForPrompt, GIT_TOOLS, executeGitTool } from '../engine/git-tools.ts';
  let gitCtx = detectGitRepo(workingDir);
  ```
- Register each git tool via the existing `toolManager.registerTool(tool, executor)` pattern (same mechanism as `COUNCIL_TOOL`):
  ```typescript
  for (const tool of GIT_TOOLS) {
    toolManager.registerTool(tool, async (args, toolCtx) => {
      const res = await executeGitTool(tool.name, args, workingDir, gitCtx);
      gitCtx = detectGitRepo(workingDir);  // refresh
      return res;
    });
  }
  ```
- Inject `formatGitContextForPrompt(gitCtx)` into system prompt via `ContextManager` (re-invoked each turn; `handleSubmit` refreshes `gitCtx` before assembling if any mutating tool ran since the last turn).
- Emit the current `gitCtx` on `ready` (one-shot, `git_info` field). No periodic poll.

**`src/mcp/tool-manager.ts`**

- Git tools are registered at runtime via `registerTool()` (from backend.ts), not added to the static `AGENT_TOOLS` list. Only the category map needs updating here.
- Add git tools to `BUILTIN_CATEGORIES`:
  ```typescript
  git_status: ['git', 'analysis'],
  git_diff: ['git', 'analysis'],
  git_commit: ['git', 'coding'],
  git_log: ['git', 'analysis'],
  git_branch: ['git', 'coding'],
  git_create_pr: ['git', 'coding'],
  ```

**`src/engine/tools.ts`** — Modify `toolWriteFile()` and `toolEditFile()` to compute and return diffs:

```typescript
// After writing the file:
const diff = computeUnifiedDiff(relPath, originalContent, newContent);
return {
  content: `Updated ${relPath} (${content.length} chars)\n\n${diff}`,
  diff,  // new field on the result
};
```

**`tui/src/app.rs`** — Add `git_branch` and `git_status_text` fields to `App`, update status bar rendering.

**`tui/src/protocol.rs`** — Add a `git_info` field to the `Ready` event:

```rust
#[serde(rename = "ready")]
Ready {
    models: Vec<String>,
    mode: String,
    status: String,
    git_info: Option<GitInfo>,
},

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: String,
    pub dirty_count: u32,
    pub last_commit: String,
}
```

### Permission Integration

Git tool permissions default to:

```json
{
  "git_status": "auto-approve",
  "git_diff": "auto-approve",
  "git_log": "auto-approve",
  "git_commit": "confirm",
  "git_branch": "confirm",
  "git_create_pr": "confirm"
}
```

The always-confirm patterns from Spec 01 already cover `git push --force` and `git push ... main/master` when used via `run_command`.

### Safety Rules (enforced in `executeGitTool`)

1. `git_commit`: Never allow empty commit messages. Validate message is non-empty and under 500 chars for the subject line.
2. `git_create_pr`: Refuse if current branch is `main` or `master`. Suggest creating a branch first.
3. No `git push --force` tool — users must use `run_command` which goes through always-confirm.
4. No `git rebase` tool — too dangerous for automated use. Available via `run_command` with confirmation.
5. If the working directory is not a git repo, all git tools return an error with a helpful message.

## Protocol Changes

### Modified event: `ready`

Add optional `git_info` field (see above).

### No new periodic event

The TUI gets initial state from `ready.git_info`. After that, mutating git tools update `gitCtx` in the backend, and the next `message_update` carries the new state via the existing `stats.git_branch` / `stats.git_dirty` fields (added to `MessageStats`). No separate periodic event. **Revised:** deleted the periodic `git_status_update` event — it duplicated information the TUI already receives per turn, and nothing changed between turns anyway.

## Configuration

Git integration is enabled automatically when the working directory is a git repo. No additional configuration required.

Optional config in `.kondi-chat/config.json`:

```json
{
  "git": {
    "autoStageOnCommit": false,
    "defaultBaseBranch": "main"
  }
}
```

`statusBarRefreshMs` deleted (no periodic refresh). `prTemplate` deleted (no concrete use case — can be added back when needed).

### System prompt injection

The git context string (from `formatGitContextForPrompt()`) is re-injected on **every** agent turn (not just the first) because the working tree can change mid-session. `ContextManager.assemblePrompt()` adds it as a priority-2 section (between session state and repo map). Stale context is prevented by calling `refreshGitContext()` immediately before prompt assembly if any mutating tool ran since the last prompt.

### Worktrees and submodules

- **Git worktrees:** Detected via `git rev-parse --show-toplevel` (working tree root) combined with `git rev-parse --git-common-dir` (shared repo dir — differs from `--git-dir` in a linked worktree). **Revised:** previously claimed `--show-toplevel` alone distinguishes worktrees; it does not — it returns the worktree root in both the main and linked worktrees. The `--git-common-dir` check is what flags a linked worktree.
- **Submodules:** Treated as their own git repos when kondi-chat is launched inside a submodule. If launched in a parent repo that contains submodules, submodule status is shown in parentheses: `main [3 modified, 1 submodule dirty]`.
- **Git worktrees with a different active branch per worktree:** Supported — each kondi-chat instance sees its own worktree's branch.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Not a git repo | `gitCtx.isGitRepo = false`, git tools return "Not a git repository" error, status bar shows no git info |
| `gh` CLI not installed | `git_create_pr` returns error: "gh CLI not found. Install from https://cli.github.com/" |
| Merge conflicts | `git_commit` detects conflicts via `git status`, returns error listing conflicted files |
| Detached HEAD | `gitCtx.branch = "HEAD detached at <hash>"`, commit/branch operations still work |
| Git command timeout | 15-second timeout on all git operations, return error on timeout |
| Large diff output | Truncate diff to 5000 characters, add "(truncated)" note |
| Git state changes externally (user runs git in another terminal) | Context refreshes on next git tool call or every 5s via status bar poll |
| Bare repo (no working tree) | Supported for `git_log`, `git_branch`; write operations return error |
| Git worktree with locked ref | `git_commit` surfaces the lock error verbatim |

## Testing Plan

1. **Unit tests** (`src/engine/git-tools.test.ts`):
   - `detectGitRepo()` correctly identifies git repos and non-repos
   - Each git tool produces correct git commands
   - Safety rules: reject empty commit messages, reject PR from main, etc.
   - `computeUnifiedDiff()` produces correct unified diffs
   - `formatGitContextForPrompt()` produces readable context

2. **Integration tests**:
   - Create a temp git repo, run git tools, verify results
   - Permission integration: git_commit requires confirmation
   - Status bar updates after git operations

3. **E2E tests**:
   - TUI status bar shows branch name
   - Full flow: edit file -> see diff -> commit -> verify commit in log

## Dependencies

- **Depends on:** Spec 01 (Permission System — git tools use permission tiers), Spec 03 (Diff Display — diff rendering in TUI)
- **Depended on by:** Spec 05 (Undo/Checkpoints — uses git stash for checkpoints), Spec 10 (Non-interactive — git operations in CI)
- **External:** `git` CLI (required), `gh` CLI (optional, for PR creation)

## Estimated Effort

**2 days** (revised from 4-5 days)
- Day 1: `src/engine/git-tools.ts` with detectGitRepo, GIT_TOOLS, executeGitTool, safety rules. Register via `toolManager.registerTool` loop in backend.ts.
- Day 2: `ready.git_info` field, TUI status bar rendering, `stats.git_branch`/`git_dirty` on `MessageStats`, smoke tests in a temp repo.
