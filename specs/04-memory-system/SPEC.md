# 04 — Memory System

## Product Description

The Memory System gives kondi-chat persistent knowledge about projects and user preferences. It reads `KONDI.md` files from multiple locations (user home, project root, subdirectories) and injects them into the agent's system prompt. The agent can update memory files via an `update_memory` tool, enabling it to learn and record conventions over time.

**Why it matters:** Coding assistants forget everything between sessions. Memory files let users and agents record conventions (code style, test patterns, architectural decisions) once and have them apply to every session. This dramatically reduces repetitive instructions and makes the agent a better collaborator over time.

**Revised 2026-04-10 (simplification pass):** Dropped `fs.watch` file watching (re-read with mtime check on each `assemblePrompt` — cheap, correct, no platform issues). Dropped YAML frontmatter parsing (nothing consumes it). Dropped the `edit` operation on `update_memory` — `append` + `replace` covers the user stories. Dropped separate `memory` config block and `MemoryManagerConfig` — constants inline. Effort 3 days -> 1 day.

## User Stories

1. **Project conventions:** A user creates `KONDI.md` at their project root with: "Use Vitest for testing, Prettier for formatting, always use named exports." Every future session in this directory injects these conventions into the system prompt. The agent follows them without being told.

2. **User global memory:** A user adds `~/.kondi-chat/KONDI.md` with their global preferences: "I prefer explicit types in TypeScript. Always use 2-space indentation." These apply across all projects.

3. **Subdirectory memory:** A monorepo has `packages/api/KONDI.md` noting "This package uses Fastify, not Express. All routes must have Zod schemas." When the agent is working on a file in `packages/api/`, this memory is loaded on top of the project root memory.

4. **Agent updates memory:** After learning that the project uses Jest (not Vitest as the user originally said), the agent calls `update_memory` to correct the project `KONDI.md`. The user sees the change in a diff and the next session reflects the correction.

5. **Memory conflicts:** A user has `~/.kondi-chat/KONDI.md` saying "Use tabs" but project `KONDI.md` says "Use 2-space indentation." The project-level memory wins (higher priority). The hierarchy is user < project < subdirectory, with later loads overriding earlier ones.

## Clarifications (2026-04-09)

- **Trust model:** Load `KONDI.md` only from user home and within the current repo tree. Ignore vendored directories/submodules unless explicitly allowlisted. Repo memory is advisory and must not override safety/system prompts.
- **Active path routing:** `assemblePrompt()` must pass active file path(s) into `memory.load(activePath)` so nearest-ancestor selection works; default to repo root when no file context.
- **Frontmatter:** support basic YAML (scalars/arrays/maps). On malformed frontmatter, drop metadata but keep body as plain text. Do not fail the load.
- **Overflow handling:** if user memory alone exceeds `maxTokens`, emit an error and skip truncation; otherwise truncate at paragraph boundaries, honoring priority order (subdir > project > user).
- **File watching:** debounce ≥200ms, coalesce duplicate events, stop on exit. Disable watching by default for repos with >50k files unless explicitly enabled.
- **Undo/checkpoints:** `update_memory` writes participate in the checkpoint system (Spec 05). `/undo` may roll back a memory change only if created in the current turn; otherwise leave durable memory intact and show a warning.
- **Prompt structure:** render memory in a dedicated, delimited section with explicit priority markers to reduce LLM drift.
## Technical Design

### Architecture

```
MemoryManager (src/context/memory.ts)
        │
        ├─ Scan user memory (~/.kondi-chat/KONDI.md)
        ├─ Scan project memory ($workingDir/KONDI.md)
        ├─ Scan subdirectory memory (nearest ancestor KONDI.md from current file)
        │
        v
  Merged memory string
        │
        v
  ContextManager.assemblePrompt() — inject as high-priority section
        │
        v
  System prompt sent to LLM
```

### Hierarchy

Lower priority wins first, higher priority overrides:

1. **User memory** (`~/.kondi-chat/KONDI.md`) — global defaults
2. **Project memory** (`$workingDir/KONDI.md`) — project-specific
3. **Subdirectory memory** (nearest ancestor `KONDI.md` walking up from active files) — contextual

Memory is concatenated (not merged semantically), with each section tagged by its source:

```
## Memory: User (~/.kondi-chat/KONDI.md)
I prefer explicit types in TypeScript...

## Memory: Project (/home/user/proj/KONDI.md)
Use Vitest for testing...

## Memory: Subdirectory (/home/user/proj/packages/api/KONDI.md)
This package uses Fastify...
```

The LLM handles conflict resolution by reading top-down and letting later instructions override earlier ones (matching the priority order).

### Memory File Format

Markdown with optional YAML frontmatter:

```markdown
---
version: 1
scope: project
tags: [typescript, react]
---

# Project Conventions

## Testing
- Use Vitest (not Jest)
- Tests live alongside source: `foo.ts` -> `foo.test.ts`
- Aim for 80% coverage on core modules

## Code Style
- Named exports only, no default exports
- 2-space indentation
- Prettier config in `.prettierrc`
```

Frontmatter is optional. If present, it's parsed and available to the memory manager for filtering/tagging. The markdown body is always injected into the prompt.

## Implementation Details

### New files

**`src/context/memory.ts`**

```typescript
const MAX_MEMORY_TOKENS = 8000;
const MAX_SUBDIR_DEPTH = 5;
const MEMORY_FILENAME = 'KONDI.md';

export interface MemoryEntry {
  source: 'user' | 'project' | 'subdirectory';
  path: string;
  content: string;   // markdown body, as-is
}

export class MemoryManager {
  constructor(workingDir: string);

  /** Read applicable memory files. Uses mtime cache; re-reads only changed files. */
  load(activeFile?: string): MemoryEntry[];

  /** Format entries for injection into system prompt (delimited sections, priority markers) */
  formatForPrompt(entries: MemoryEntry[]): string;

  /** Append or replace a memory file (used by update_memory tool) */
  updateMemory(scope: 'user' | 'project', operation: 'append' | 'replace', content: string): { path: string };
}
```

No frontmatter parsing, no file watching, no `MemoryManagerConfig` object, no `hasChanges`/`reload` — `load()` self-checks mtime per call. The nearest-ancestor walk is inlined in `load()`.

### Update memory tool

Add to `src/engine/tools.ts`:

```typescript
{
  name: 'update_memory',
  description: 'Update a KONDI.md memory file to record project conventions, decisions, or preferences.',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['project', 'user'] },
      operation: { type: 'string', enum: ['append', 'replace'] },
      content: { type: 'string' },
    },
    required: ['scope', 'operation', 'content'],
  },
}
```

No `edit` operation, no `section` arg. If you want to rewrite a specific section, replace the whole file.

The `update_memory` tool goes through the permission system (tier: `confirm`).

### Modified files

**`src/context/manager.ts`**

- Add `memoryManager?: MemoryManager` field to `ContextManager` (set via constructor options, not a mutable setter).
- In `assemblePrompt()`, add a new high-priority section above session state. Note: existing code uses priority 1 for session state, 2 for repo-map, 3 for recent, 4 for compact-summary, 5 for grounding. Memory gets priority 0 (highest), non-compressible:

```typescript
// Priority 0: Memory (highest priority, always included)
if (this.memoryManager) {
  // Activefile may be unknown during assemblePrompt; pass last-read file if tracked,
  // otherwise use workingDir root as the anchor for subdir memory lookup.
  const entries = this.memoryManager.load(/* activeFile */);
  const memoryText = this.memoryManager.formatForPrompt(entries);
  if (memoryText) {
    budget.add('memory', memoryText, 0, false);
  }
}
```

**Revised:** the clarification requires `memory.load(activePath)` to honor nearest-ancestor selection, but `assemblePrompt()` has no signal for the active file because the agent's current focus isn't stored in `ContextManager`. Options: (a) track last file touched by `read_file`/`edit_file` on `ToolContext.mutatedFiles` — but that set is checkpoint-scoped, not focus-scoped; (b) add `ContextManager.setActiveFile(path)` called by tools on read/edit; (c) fall back to working-dir root. Pick (b) + (c) fallback; document that subdir memory is only loaded when a tool has set active file at least once this turn.

**`src/cli/backend.ts`**

- Initialize `MemoryManager(workingDir)` on startup
- Pass to `ContextManager` constructor
- Register `update_memory` tool with `ToolManager`
- Emit `status` event if memory files change during a session (via file watcher)

**`src/engine/tools.ts`** — Add `toolUpdateMemory()`:

```typescript
async function toolUpdateMemory(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const scope = args.scope as 'project' | 'user';
  const operation = args.operation as 'append' | 'replace' | 'edit';
  const content = args.content as string;
  const section = args.section as string | undefined;

  const memoryManager = ctx.memoryManager;
  if (!memoryManager) {
    return { content: 'Memory manager not available', isError: true };
  }

  // ... implement append/replace/edit logic ...
  const result = memoryManager.updateMemory(scope, newContent);
  return { content: `Memory updated: ${result.path}` };
}
```

**`src/engine/tools.ts`** — `ToolContext` type now includes `memoryManager`:

```typescript
export interface ToolContext {
  workingDir: string;
  session: Session;
  ledger: Ledger;
  pipelineConfig: PipelineConfig;
  memoryManager?: MemoryManager;  // NEW
}
```

## Protocol Changes

None directly. Memory is transparent to the TUI — it shows up in the system prompt like any other context. However, a new `status` event type can be used to inform the user when memory is loaded:

```json
{
  "type": "status",
  "text": "Memory loaded: 2 files, 1.2k tokens"
}
```

This is emitted once on startup and again whenever memory changes.

## Configuration

No configuration. Constants live in `memory.ts`: `MAX_MEMORY_TOKENS=8000`, `MAX_SUBDIR_DEPTH=5`, filename fixed to `KONDI.md` (also accepts `kondi.md` case-insensitively).

### Change detection

`load()` stats each tracked KONDI.md and re-reads only if mtime changed since last load. This runs once per `assemblePrompt` — a handful of `statSync` calls per turn. No file watcher, no polling loop, no `status` event.

### Interaction with checkpoints

`update_memory` tool calls count as file mutations. They're added to `ToolContext.mutatedFiles` and trigger checkpoint creation like any other write. When the user runs `/undo`, memory file changes are reverted along with code changes.

## Error Handling

| Scenario | Handling |
|----------|----------|
| KONDI.md not found | Silent, memory is optional |
| YAML frontmatter malformed | Parse only the body, log warning |
| Memory exceeds maxTokens | Truncate subdirectory memory first, then project, never truncate user |
| Memory file has binary content | Skip the file, log warning |
| `update_memory` on user scope but `~/.kondi-chat/` doesn't exist | Create the directory and file |
| Circular symlinks in subdirectory walk | Use real paths, track visited |
| KONDI.md with >50k characters | Read only first 50k, add "(truncated)" marker |

## Testing Plan

1. **Unit tests** (`src/context/memory.test.ts`):
   - Load user, project, subdirectory memory separately
   - Hierarchy order is correct (user -> project -> subdirectory)
   - Frontmatter parsing handles valid and malformed YAML
   - Token budget enforcement: subdirectory truncated first
   - `findSubdirMemory()` walks up correctly
   - Change detection via mtimes
   - `updateMemory()` append, replace, edit modes

2. **Integration tests**:
   - Full prompt assembly with memory injected
   - Memory changes mid-session propagate on next turn
   - `update_memory` tool creates files that persist

3. **E2E tests**:
   - Create KONDI.md, start kondi-chat, verify memory appears in system prompt
   - Agent follows memory-defined conventions in test scenarios

## Dependencies

- **Depends on:** `src/context/manager.ts` (integration point), `src/engine/tools.ts` (update_memory tool)
- **Depended on by:** Spec 17 (Documentation — docs will describe memory format)
- **External:** None (no YAML library required; implement minimal frontmatter parser inline)

## Estimated Effort

**1 day** (revised from 3 days)
- Morning: `memory.ts` — `load()`, `formatForPrompt()`, `updateMemory()`, mtime cache.
- Afternoon: Wire into `ContextManager.assemblePrompt` as priority-0 section, register `update_memory` tool, smoke tests.
