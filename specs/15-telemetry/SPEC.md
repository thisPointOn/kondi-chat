# 15 — Telemetry

## Product Description

Telemetry is strictly opt-in, clearly disclosed on first run, and collects only anonymized usage metrics — never prompt content, responses, file paths, or API keys. Data stays local by default in `.kondi-chat/analytics.json` (extending the existing `analytics.ts`). An optional remote reporting backend can be enabled for product improvement. Users can export, delete, or disable telemetry at any time (GDPR-compliant).

**Why it matters:** Understanding how users actually use kondi-chat is essential for improving it. But privacy-preserving telemetry is the only acceptable approach — users must trust that their code, prompts, and API keys are never sent anywhere. This spec codifies that trust with strict allowlists and transparent reporting.

**Revised 2026-04-10 (simplification pass):** v1 ships **local-only**. The remote upload path, endpoint config, batching interval, and `installationId` are deferred to v2 — the entire feature value (`/analytics`, schema-enforced privacy, export, delete) lands without any network code. Collapsed `src/telemetry/{events,emitter}.ts` into one file `src/audit/telemetry.ts` (sibling of existing `analytics.ts`). Dropped the `consent_required` event and the full-screen modal — v1 prints a one-line opt-in notice on first run and requires `/telemetry enable` to activate. Dropped `performance` metric kind. Effort dropped from 3 days to 1 day.

## User Stories

1. **First-run consent:** A new user runs kondi-chat. On the first turn, a notice appears: "Anonymous usage metrics help improve kondi-chat. Nothing is sent without your consent. Enable? [y/N/details]". They press `n`. Telemetry stays disabled, tracked only locally (for the existing analytics feature).

2. **Opt-in remote reporting:** A user runs `/telemetry enable`. The system confirms "Remote reporting enabled. Data is sent anonymously to https://telemetry.kondi-chat.example/v1/events once per day. You can disable at any time with /telemetry disable or review with /telemetry status."

3. **Data export:** A user wants to see what's been collected. They run `/telemetry export` and get a JSON file with every metric recorded, with timestamps. They can see it's just counts and category totals — no content.

4. **Data deletion:** A user runs `/telemetry delete`. All locally stored telemetry is wiped, and if remote reporting was enabled, a deletion request is sent to the remote endpoint (referencing their anonymous installation ID).

5. **Verify no content leaked:** A privacy-conscious user runs `/telemetry export` and greps for their latest prompt. Nothing matches. The schema-enforced allowlist guarantees this — only enum values and counters are ever recorded.

## Clarifications (2026-04-10)

- **States:** Three explicit states: `remote-enabled`, `local-only`, `disabled`. `enabled: false` means no local accumulation. Remote opt-in still records locally unless `disabled`.
- **Storage:** Keep config and installation ID in one place (e.g., `~/.kondi-chat/telemetry.json`). Deleting that file resets consent and ID.
- **Schema:** Close the event schema—`modelId`, `phase`, `valueBucket` must be enums; reject unknown fields to uphold privacy claims.
- **Instrumentation:** Add concrete capture points/windowing for p50/p95 latency, cache hit rate, compaction count, router latency; if not implementable, drop them from the spec.
- **Deletion:** `/telemetry delete` must specify remote endpoint, auth via installation ID, retries, and success criteria; queue the request if offline.
- **Precedence:** `KONDI_CHAT_NO_TELEMETRY=1` overrides stored consent and forces `disabled`, also triggers local deletion on startup.
- **Compliance:** Add a retention window (e.g., 30 days remote) and ensure exports/deletes cover both local and remote stores.
## Technical Design

### What IS collected (allowlist)

| Category | Fields |
|----------|--------|
| Feature usage | Counter per feature: commands run, tools used, sub-agents spawned, sessions resumed, checkpoints created, etc. |
| Error types | Enum of error categories (timeout, rate-limit, permission-denied, tool-error) + counts |
| Model distribution | Counter per model: calls, total input tokens, total output tokens (aggregate only) |
| Cost distribution | Daily total cost (aggregate); cost per provider (aggregate) |
| Session shapes | Distribution: number of messages, number of tool calls, total duration, iterations |
| Configuration | Current profile name (enum: balanced/cheap/quality/custom), number of custom profiles, router tiers enabled |
| Performance | p50/p95 LLM latency per provider, context compaction count, cache hit rate |
| Installation | OS (linux/macos/windows), kondi-chat version, Node.js version, Rust TUI version |

### Consent UX

On first run, the backend emits a regular `status` event:

```
Telemetry is disabled by default. Run /telemetry enable to opt in to anonymous local usage metrics. Run /telemetry details to see what's collected.
```

That's it. No modal, no blocking. Users opt in explicitly via `/telemetry enable` before any event is recorded. Non-interactive mode never enables telemetry. **Revised:** full-screen modal + `consent_required` event deleted — a one-line status line carries the same information without a new protocol event.

### What is NEVER collected (denylist, schema-enforced)

- Prompts, user messages, any free-text user input
- Assistant responses, tool call arguments, file paths
- File contents, repository names, git remote URLs
- API keys, tokens, secrets, env var values
- Working directory paths
- Absolute paths of any kind
- User identifiers (email, name, username)
- IP addresses (not sent by client; server would not store)

### Enforcement mechanism

All telemetry events go through a single allowlist-based emitter. The emitter accepts only typed events matching a strict schema. Attempts to include non-allowlisted fields are rejected at compile time (TypeScript enums) and at runtime (schema validation).

```typescript
// Only these types are allowed:
type TelemetryEvent =
  | { kind: 'feature_used'; feature: FeatureId }
  | { kind: 'tool_called'; tool: ToolCategoryId }
  | { kind: 'error_occurred'; category: ErrorCategoryId }
  | { kind: 'session_completed'; messageCountBucket: 'small'|'medium'|'large'; durationBucket: 'fast'|'normal'|'slow'; iterationsBucket: 'one'|'few'|'many' }
  | { kind: 'model_used'; modelId: string; inputTokens: number; outputTokens: number; latencyMs: number };
```

String fields are bounded: `modelId` is matched against the model registry (known IDs only), `feature` is an enum. Anything else is rejected.

### Local-only (v1)

- Events accumulate in `.kondi-chat/analytics.json` (reuses existing Analytics class)
- Never leaves the machine
- Powers `/analytics` command (existing feature)

**Remote upload deferred to v2.** The schema is forward-compatible — when remote ships, it will batch the same events and add an `installationId` and endpoint config. v1 has zero network code.

## Implementation Details

### New file

**`src/audit/telemetry.ts`** (single file, sibling of existing `analytics.ts`) — schema + emitter in one place:

```typescript
export type FeatureId =
  | 'session_started' | 'session_resumed' | 'undo_invoked'
  | 'checkpoint_created' | 'checkpoint_restored'
  | 'sub_agent_spawned' | 'hook_executed' | 'web_search'
  | 'image_uploaded' | 'memory_loaded' | 'memory_updated'
  | 'council_invoked' | 'non_interactive_run' | 'profile_changed';

export type ToolCategoryId =
  | 'filesystem_read' | 'filesystem_write' | 'filesystem_edit'
  | 'search_code' | 'run_command' | 'create_task' | 'update_plan'
  | 'git' | 'web' | 'mcp' | 'council' | 'update_memory' | 'spawn_agent' | 'persist';

export type ErrorCategoryId =
  | 'llm_timeout' | 'llm_rate_limit' | 'llm_auth'
  | 'network' | 'permission_denied' | 'tool_error' | 'config_error'
  | 'provider_fallback' | 'backend_crash' | 'recovery_success';

export type TelemetryEvent =
  | { kind: 'feature_used'; feature: FeatureId; timestamp: string }
  | { kind: 'tool_called'; tool: ToolCategoryId; succeeded: boolean; timestamp: string }
  | { kind: 'error_occurred'; category: ErrorCategoryId; recoverable: boolean; timestamp: string }
  | { kind: 'session_summary'; messageCountBucket: 'small' | 'medium' | 'large'; durationBucket: 'fast' | 'normal' | 'slow'; iterationsBucket: 'one' | 'few' | 'many'; timestamp: string }
  | { kind: 'model_used'; modelId: string; phase: string; inputTokens: number; outputTokens: number; latencyMs: number; timestamp: string };

export function validateEvent(event: unknown): event is TelemetryEvent;
export function bucketMessageCount(n: number): 'small' | 'medium' | 'large';
export function bucketDuration(ms: number): 'fast' | 'normal' | 'slow';
export function bucketIterations(n: number): 'one' | 'few' | 'many';
```

In the same file:

```typescript
export interface TelemetryConfig {
  enabled: boolean;       // false by default (= disabled state)
  consentedAt?: string;
  maxLocalEvents?: number;
}

export class TelemetryEmitter {
  constructor(storageDir: string);
  emit(event: TelemetryEvent): void;
  hasConsentBeenAsked(): boolean;
  setConsent(enabled: boolean): void;
  exportAll(): TelemetryEvent[];
  deleteAll(): { localDeleted: number };
  formatStatus(): string;
}
```

Two states only in v1: `disabled` (no events recorded) and `enabled` (local accumulation). Remote upload, batching, installation IDs all deferred. `KONDI_CHAT_NO_TELEMETRY=1` forces disabled and runs `deleteAll()` on startup.

### Modified files

**`src/audit/analytics.ts`**

Extend the existing `Analytics` class to accept telemetry events as an additional data source. Keep the file structure backward-compatible:

```typescript
export class Analytics {
  // ... existing

  /** NEW: integrate telemetry events */
  addTelemetryEvent(event: TelemetryEvent): void {
    // Map event to daily aggregates
  }
}
```

**`src/cli/backend.ts`** — Initialize and hook into key points:

```typescript
import { TelemetryEmitter } from '../telemetry/emitter.ts';

const telemetry = new TelemetryEmitter(storageDir);

// On first run, show consent prompt as a special status message
if (!telemetry.hasConsentBeenAsked()) {
  emit({ type: 'status', text: telemetry.getConsentPromptText() });
  // User can respond via /telemetry consent yes|no command
}

// Emit events at key points:
telemetry.emit({ kind: 'feature_used', feature: 'session_started', timestamp: new Date().toISOString() });

// On every tool call:
telemetry.emit({
  kind: 'tool_called',
  tool: categorizeTool(tc.name),  // Maps tool name to ToolCategoryId
  succeeded: !result.isError,
  timestamp: new Date().toISOString(),
});

// On every LLM call (from ledger entry):
telemetry.emit({
  kind: 'model_used',
  modelId: response.model,
  phase: phase,
  inputTokens: response.inputTokens,
  outputTokens: response.outputTokens,
  latencyMs: response.latencyMs,
  timestamp: new Date().toISOString(),
});
```

**Commands:**

```typescript
case '/telemetry': {
  const sub = parts[1] || 'status';
  switch (sub) {
    case 'status': return telemetry.formatStatus();
    case 'enable':  telemetry.setConsent(true);  return 'Telemetry enabled (local only)';
    case 'disable': telemetry.setConsent(false); return 'Telemetry disabled';
    case 'export':  return JSON.stringify(telemetry.exportAll(), null, 2);
    case 'delete':  return `Deleted ${telemetry.deleteAll().localDeleted} local events.`;
    case 'details': return TELEMETRY_ALLOWLIST_DOCS;
  }
  return 'Usage: /telemetry [status|enable|disable|export|delete|details]';
}
```

## Protocol Changes

**None.** First-run notice is a regular `status` event. **Revised:** `consent_required` event deleted.

## Configuration

**`.kondi-chat/telemetry.json`**

```json
{
  "enabled": false,
  "consentedAt": null,
  "maxLocalEvents": 100000
}
```

Defaults: telemetry disabled. `enabled: false` means *no telemetry*, including local event accumulation (existing analytics from the ledger is separate).

### Environment opt-out

`KONDI_CHAT_NO_TELEMETRY=1` forces telemetry off regardless of config. This is for CI/CD and privacy-sensitive environments.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Remote endpoint unreachable | Retry next batch; never block operations; log once per day |
| Event fails schema validation | Silently drop, log warning (bug in our code) |
| Local storage full | Rotate oldest events, keep newest up to `maxLocalEvents` |
| Corrupted telemetry file | Reset to empty, log warning |
| User deletes storage dir | Next run re-prompts for consent |
| Config mismatch (e.g., remote enabled but endpoint null) | Treat as disabled, log warning |

## Compliance / Privacy

- **GDPR Right to Access:** `/telemetry export` provides complete local data
- **GDPR Right to Erasure:** `/telemetry delete` wipes local and sends remote delete request
- **GDPR Right to Object:** `/telemetry disable` at any time, no ongoing obligations
- **Data minimization:** Allowlist enforces only aggregate counts
- **Consent:** Opt-in only, clear disclosure before any data collection
- **Transparency:** Full schema documented in `docs/telemetry.md`

## Testing Plan

1. **Unit tests** (`src/telemetry/*.test.ts`):
   - `validateEvent()` rejects non-allowlisted fields
   - Bucket functions produce correct categories
   - Consent state machine: not-asked -> enabled -> disabled
   - Export contains exactly the recorded events
   - Delete clears local data
   - Installation ID generation is unique

2. **Privacy tests:**
   - Inject a mock telemetry event with prompt content in the modelId field; verify validation rejects it
   - Scan the entire telemetry export for any path-like, URL-like, or API-key-like patterns
   - Verify `KONDI_CHAT_NO_TELEMETRY=1` is respected

3. **Integration tests:**
   - First run shows consent prompt
   - Enable remote -> batched flush happens on interval
   - Commands work (/telemetry enable, /telemetry status, etc.)

## Dependencies

- **Depends on:** `src/audit/analytics.ts` (extend existing), `src/cli/backend.ts` (integration points)
- **Depended on by:** None (telemetry is transparent; other features just emit events)

## Estimated Effort

**1 day** (revised from 3 days)
- Morning: `src/audit/telemetry.ts` — schema, validateEvent, bucket helpers, emitter, consent state, export/delete.
- Afternoon: Integration at the obvious emit sites (session start, tool call, model call, error), `/telemetry` command, privacy unit test, first-run status notice.
