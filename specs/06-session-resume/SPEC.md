# 06 — Session Resume

## Product Description

Session Resume lets users quit kondi-chat and come back to exactly where they left off — full message history, session state, active model, profile, and checkpoints. Sessions persist automatically on exit and periodically during use. Users can list past sessions, resume the most recent one, or jump to a specific session by ID.

**Why it matters:** Long coding sessions get interrupted. Without persistence, users lose all context — the agent forgets what it was working on, the plan, the recent failures. Session resume is table-stakes for any serious dev tool. It also enables reviewing past conversations, learning from past work, and handing off sessions between machines.

**Revised 2026-04-10 (simplification pass):** Dropped the `session_resumed` event — folded into `ready.resumed` + `ready.session_summary`. Dropped the `initBackend/runBackend` refactor (handled lazily in Spec 10). Dropped the archive subdirectory — cleanup simply deletes. Dropped config block in favor of two constants (`AUTO_SAVE_MS=30000`, `MAX_AGE_DAYS=30`). Effort dropped from 3 days to 1.5 days.

## User Stories

1. **Quit and resume:** A user is mid-debugging when they need to switch tasks. They quit kondi-chat. Later they run `kondi-chat --resume` and continue exactly where they were — the agent remembers the failing test, the files it read, and the plan.

2. **Resume specific session:** The user has three sessions from yesterday. They run `kondi-chat --sessions` to see the list, pick session `f3a1b2c3`, and run `kondi-chat --resume f3a1b2c3` to load that specific session.

3. **Crash recovery:** The backend crashes unexpectedly. The user restarts kondi-chat, and the TUI detects an unfinished session and offers to resume it. The last saved state (from the periodic save, up to 30 seconds old) is loaded.

4. **Session browsing:** Inside the TUI, the user runs `/sessions` to see recent sessions with timestamps, message counts, and costs. They can use `/resume <id>` to switch to a different session without quitting.

5. **Auto-cleanup:** The user has 100 old sessions from the past year. On startup, sessions older than 30 days (configurable) are automatically archived or deleted based on config.

## Clarifications (2026-04-09)

- **Resume UX:** For v1, `/resume <id>` prints the exact restart command (`kondi-chat --resume <id>`) and does not hot-swap; if hot-swap ships later, the spec must be updated and the UI must label it.
- **Storage scope:** default is repo-scoped (`<repo>/.kondi-chat/sessions/`). If `persistAcrossWorkingDirs=true`, also store in `~/.kondi-chat/sessions/` and search both; document precedence.
- **Crash safety:** all session writes use temp+rename; hold a per-session lock file to prevent concurrent writers; never rewrite `index.json` without atomic swap.
- **Lifecycle markers:** sessions carry `state: active | closed | abandoned`. Clean exits mark `closed`; on startup, mark stale `active` older than `maxAgeMinutes` as `abandoned` but keep data.
- **Cleanup:** apply `autoDeleteAfterDays` and `maxSessions` in order; delete or archive whole-session bundles (state + ledger + checkpoints) atomically, not piecemeal.
- **ID lookup:** allow prefix matching of ≥8 chars; if ambiguous, require full id. Store both full and short forms in the index.
## Technical Design

### Architecture

```
Session lifecycle:
  Start
    │
    ├─ --resume or --resume <id>: Load existing session
    │     OR
    ├─ New: createSession()
    │
    v
  Active session (in-memory)
    │
    ├─ Periodic save every 30s (or N turns)
    ├─ Save on every checkpoint
    ├─ Save on exit
    │
    v
  Storage: .kondi-chat/sessions/<id>.json
  Index:   .kondi-chat/sessions/index.json
```

### Storage layout

```
.kondi-chat/
  sessions/
    index.json              # Session metadata list
    active.json             # Pointer to currently/last-active session
    <session-id>.json       # Full session state (messages, state, tasks)
  <session-id>-ledger.json  # Existing: flat at storageDir root, NOT under sessions/
  checkpoints/
    <session-id>/
      cp-*                  # Checkpoints scoped per session
```

**Revised:** the existing `Ledger` constructor writes `<sessionId>-ledger.json` directly under `storageDir` (see `src/audit/ledger.ts`), not under a `sessions/` subdirectory. Do not move ledger files — existing sessions on disk would break. Either leave ledger location flat (recommended) or perform a one-time migration in `SessionStore` constructor. Also note: the current code already persists `<session-id>-session.json` flat in `storageDir` from `/quit` in `main.tsx`. SessionStore must either read both locations or migrate on first save.

### Session index

`sessions/index.json`:

```json
{
  "sessions": [
    {
      "id": "f3a1b2c3-...",
      "createdAt": "2026-04-05T10:00:00Z",
      "updatedAt": "2026-04-05T12:34:00Z",
      "workingDirectory": "/home/user/proj",
      "messageCount": 15,
      "totalCostUsd": 0.3421,
      "activeModel": "claude-sonnet-4-5-20250929",
      "profile": "balanced",
      "summary": "Refactored auth module to use JWT",
      "archived": false
    }
  ]
}
```

### Persistence format

Each session is stored as a single JSON file containing the entire `Session` struct plus a few extra fields:

```typescript
interface PersistedSession {
  version: 1;  // Schema version for future migrations
  session: Session;  // from src/types.ts
  activeProfile: string;
  overrideModel?: string;  // from /use command
  lastSavedAt: string;
  workingDirectory: string;
}
```

### Save triggers

1. **Every 30 seconds** (configurable) via a `setInterval` in the backend
2. **After every turn completes** (at end of `handleSubmit`)
3. **After every checkpoint creation**
4. **On graceful exit** (`rl.on('close')`, `quit` command, SIGTERM)
5. **Crash recovery:** The periodic save ensures at most 30 seconds of state is lost on crash

## Implementation Details

### New files

**`src/session/store.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../types.ts';

export interface PersistedSession {
  version: 1;
  session: Session;
  activeProfile: string;
  overrideModel?: string;
  lastSavedAt: string;
  workingDirectory: string;
}

export interface SessionIndexEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  messageCount: number;
  totalCostUsd: number;
  activeModel?: string;
  profile: string;
  summary: string;
  archived: boolean;
}

export class SessionStore {
  private storageDir: string;
  private sessionsDir: string;
  private indexPath: string;
  private activePath: string;
  private index: SessionIndexEntry[];

  constructor(storageDir: string);

  /** Save a session to disk */
  save(session: Session, profile: string, overrideModel?: string): void;

  /** Load a session by id */
  load(id: string): PersistedSession | null;

  /** Load the most recently updated session for a given working directory */
  loadLatest(workingDirectory?: string): PersistedSession | null;

  /** Get all sessions sorted by updatedAt descending */
  list(workingDirectory?: string): SessionIndexEntry[];

  /** Delete a session (file and index entry) */
  delete(id: string): void;

  /** Archive sessions older than N days */
  cleanup(maxAgeDays: number): { archived: number; deleted: number };

  /** Mark a session as active */
  setActive(id: string): void;

  /** Get the currently active session id */
  getActive(): string | null;

  /** Format sessions list for /sessions command */
  format(workingDirectory?: string): string;

  private updateIndex(entry: SessionIndexEntry): void;
  private loadIndex(): SessionIndexEntry[];
  private saveIndex(): void;
  private computeSummary(session: Session): string;
}
```

### Modified files

**`src/cli/backend.ts`**

```typescript
import { SessionStore } from '../session/store.ts';

async function main() {
  loadEnv();
  const workingDir = process.cwd();
  const storageDir = resolve(workingDir, '.kondi-chat');
  mkdirSync(storageDir, { recursive: true });

  const sessionStore = new SessionStore(storageDir);

  // Parse --resume flag
  const resumeIdx = process.argv.indexOf('--resume');
  let session: Session;
  let restoredProfile: string | undefined;

  if (resumeIdx >= 0) {
    const id = process.argv[resumeIdx + 1];
    const persisted = id && !id.startsWith('--')
      ? sessionStore.load(id)
      : sessionStore.loadLatest(workingDir);
    if (persisted) {
      session = persisted.session;
      restoredProfile = persisted.activeProfile;
      emit({ type: 'status', text: `Resumed session ${session.id.slice(0, 8)} (${session.messages.length} messages)` });
    } else {
      session = createSession('openai', undefined, workingDir);
      emit({ type: 'status', text: 'No session to resume, starting new' });
    }
  } else {
    session = createSession('openai', undefined, workingDir);
  }

  // ... existing init ...

  // Periodic save
  const saveInterval = setInterval(() => {
    sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id);
  }, 30_000);

  // Save on exit
  process.on('SIGTERM', () => {
    sessionStore.save(session, profiles.getActive().name);
    clearInterval(saveInterval);
    process.exit(0);
  });
  // ... similar for SIGINT, quit command ...
}
```

**`src/cli/backend.ts`** — Add commands:

```typescript
case '/sessions': return sessionStore.format(workingDir);
case '/resume': {
  if (!parts[1]) return 'Usage: /resume <session-id>';
  const persisted = sessionStore.load(parts[1]);
  if (!persisted) return `Session not found: ${parts[1]}`;
  // Hot swap session state — note: must reset context manager, ledger, etc.
  // For safety, this command exits the current process and respawns with --resume
  return `To resume ${parts[1]}, restart kondi-chat with --resume ${parts[1]}`;
}
```

Hot-swapping sessions in-process is complex because `Ledger`, `ContextManager`, and `CheckpointManager` all hold session-specific state. For v1, `/resume` inside the TUI prints the restart instruction. In-process swap is a stretch goal.

**`src/cli/main.tsx`** (or wherever the CLI entry point spawns the backend)

- Pass `--resume` and `--resume <id>` through to the backend process
- Parse `--sessions` as a non-interactive mode: list sessions and exit

### CLI flags

| Flag | Behavior |
|------|----------|
| `--resume` | Resume the most recent session for the current working directory |
| `--resume <id>` | Resume a specific session by id |
| `--sessions` | List all sessions and exit (non-interactive) |
| `--new` | Force a new session even if `--resume` is the default behavior |

### Cleanup policy

On startup, sessions older than `MAX_AGE_DAYS` (constant, default 30) are deleted (file + index entry + checkpoint directory). The ledger file stays — it is the audit trail. No "archive" subdirectory.

### Ledger and checkpoint scoping

When a session is resumed, the backend constructs its `Ledger(sessionId, storageDir)` with the resumed session's ID. The existing `Ledger` constructor (see `src/audit/ledger.ts`) calls `loadFromDisk()` in its constructor and pre-populates `entries` from `<storageDir>/<sessionId>-ledger.json`, so the entire audit history is automatically restored — no extra plumbing needed.

Similarly, `CheckpointManager` is constructed with `{ storageDir: resolve(workingDir, '.kondi-chat/checkpoints', sessionId) }` so the session's checkpoint index loads with it.

The `Analytics` class is not session-scoped — it aggregates across all sessions. Its state is loaded normally.

### Backend init changes

`main()` in `src/cli/backend.ts` gets an `--resume`-handling block at the top (shown above) that replaces the default `createSession(...)` line. No `initBackend`/`runBackend` split is introduced by this spec — that can happen later under Spec 10 if it turns out to be needed. **Revised:** removed the refactor; the resume path is ~15 lines inline.

## Protocol Changes

### Modified `Ready` event

Add three optional fields: `resumed: bool`, `resumed_session_id?: string`, `resumed_message_count?: u32`. The TUI renders a one-line banner when `resumed == true`. **Revised:** dropped the separate `session_resumed` event — everything it carried now rides on `ready`, which the TUI already has to handle.

## Configuration

No config. Constants in `store.ts`: `AUTO_SAVE_MS=30000`, `MAX_AGE_DAYS=30`. `persistAcrossWorkingDirs` defaults to `true` (implicit — `loadLatest(workingDir)` filters; raw `load(id)` does not). **Revised:** four knobs collapsed to two constants.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Corrupted session JSON | Log warning, skip the session, remove from index |
| Version mismatch (future schema) | Attempt migration, fall back to new session if fails |
| Session file too large (>10MB) | Warn user, offer to archive and start fresh |
| Concurrent access (two kondi-chats in same dir) | File lock via `.kondi-chat/sessions/<id>.lock`; second instance runs read-only or refuses to load same session |
| Disk full during save | Retain in-memory state, emit error event, don't exit |
| `--resume` but no sessions exist | Silent fallback to new session, log info message |

## Testing Plan

1. **Unit tests** (`src/session/store.test.ts`):
   - Save and load round-trip preserves all session data
   - Index updates correctly on save
   - `loadLatest()` returns most recently updated for given directory
   - Cleanup archives old sessions, keeps recent ones
   - Corrupted file handling

2. **Integration tests**:
   - Full session: run turns, quit, resume, continue — verify message history intact
   - Crash recovery: kill backend, verify periodic save captures state
   - Multiple working directories: `loadLatest()` filters correctly
   - Concurrent access: lock prevents double load

3. **E2E tests**:
   - `--resume` with no arg loads latest
   - `--resume <id>` loads specific
   - `--sessions` lists and exits
   - `/sessions` command shows list in TUI

## Dependencies

- **Depends on:** `src/types.ts` (Session type), `src/audit/ledger.ts` (ledger persistence is already per-session)
- **Depended on by:** Spec 13 (Error Recovery — crash recovery uses periodic session saves), Spec 10 (Non-interactive mode — supports `--sessions` flag)

## Estimated Effort

**1.5 days** (revised from 3 days)
- Day 1: `SessionStore` (save/load/list/delete/cleanup), index persistence with temp+rename, backend `--resume` block, periodic save + graceful shutdown save.
- Day 2 morning: `/sessions` + `/resume` commands, smoke tests for round-trip.
