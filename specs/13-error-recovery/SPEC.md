# 13 — Error Recovery

## Product Description

Error Recovery makes kondi-chat resilient to transient failures: backend crashes, LLM timeouts, network failures, partial streams, router failures. The TUI auto-restarts the backend, the backend retries with exponential backoff, partial streams are saved, and fallback models kick in when providers fail. State persists frequently so crashes lose at most a few seconds of work.

**Why it matters:** In production, things break. Networks drop, APIs time out, processes crash. A tool that loses your work when anything fails is frustrating and untrustworthy. First-class error recovery is what separates a demo from a product.

**Revised 2026-04-10 (simplification pass):** Deleted `src/providers/retry.ts` — retry logic is inlined into the existing `callLLM` wrapper in `llm-caller.ts` (rename raw impl to `callProviderRaw`, wrap with timeout + backoff + fallback). Deleted `src/recovery/` directory — `RecoveryManager`'s two methods (periodic save, partial save) become methods on `SessionStore` from Spec 06. Deleted `recovery.json` config and the per-provider timeout table — one `LLM_TIMEOUT_MS=120000` constant. Deleted the new `recovery` event — TUI learns about restarts from the `ready.resumed` banner, and about fallbacks via a one-line `activity` event. Effort dropped from 5 days to 2 days.

## User Stories

1. **Backend crash recovery:** The Node backend process dies unexpectedly during an agent turn. The TUI detects the process exit within 1 second, shows "Backend crashed, restarting..." then spawns a new backend with `--resume`. The user's session history is intact (up to 30 seconds ago, from the last periodic save).

2. **LLM timeout with fallback:** The user's Claude API call hangs past 60 seconds. The backend cancels the request, retries once, fails again. It falls back to the next capability-matched model (GPT-4o) and completes the turn. The user sees a notice: "Switched to gpt-4o due to anthropic timeout."

3. **Partial stream recovery:** The agent is streaming a long response. The connection drops after 200 tokens out of 1500. The backend saves the partial content as an assistant message with a `[response truncated]` marker. The user can ask the agent to continue from where it left off.

4. **Rate limit retry:** Anthropic returns 429 with `Retry-After: 12`. The backend waits 12 seconds and retries automatically. If still rate-limited, it falls back to another provider. This is invisible to the user except for a longer status indicator.

5. **Router failure:** The NN router crashes on a bad embedding. The error is caught, logged, and the system falls back to the rule-based router. The user never sees the failure — the agent turn completes normally.

## Clarifications (2026-04-10)

- **Partial stream persistence:** save partial assistant text with an idempotent marker; on resume, de-dup by message ID and append only missing tokens. Never double-append. If both partial and full exist, keep the longest.
- **Fatal handler writes:** `uncaughtException`/`unhandledRejection` handlers must flush state synchronously (write+fsync or temp+rename) before exit; otherwise skip the promise of “saved before exit.”
- **Intentional vs crash exits:** distinguish exit codes for normal quit/upgrade vs crash; the TUI should only auto-restart on crash-class codes to avoid respawn loops.
- **Turn budget:** impose a wall-clock cap per turn across retries/fallbacks (e.g., 90s) and fail with a clear error when exceeded. `pickFallback` must return a definitive “no compatible fallback” instead of looping.
- **Session resume interplay:** backend restart with `--resume` must honor Spec 06 semantics; do not auto-override the user’s active session if `--resume` wasn’t requested.
## Technical Design

### Recovery layers

```
┌────────────────────────────────────────────┐
│ Layer 1: TUI Process Manager                │
│   - Detects backend exit                    │
│   - Restarts backend with --resume          │
│   - Displays "reconnecting" state           │
└────────────────────────────────────────────┘
                  │
┌────────────────────────────────────────────┐
│ Layer 2: Backend Global Handler             │
│   - Catches uncaughtException/unhandledReject│
│   - Saves state before exit                 │
│   - Emits error event to TUI                │
└────────────────────────────────────────────┘
                  │
┌────────────────────────────────────────────┐
│ Layer 3: LLM Call Retries                   │
│   - Timeout enforcement                     │
│   - Exponential backoff                     │
│   - Retry-After header support              │
│   - Provider fallback                       │
└────────────────────────────────────────────┘
                  │
┌────────────────────────────────────────────┐
│ Layer 4: Component-level Isolation          │
│   - Router failures -> rule router          │
│   - MCP tool failures -> tool result error  │
│   - Memory load failures -> skip memory     │
│   - Checkpoint failures -> log and continue │
└────────────────────────────────────────────┘
```

### Interaction with checkpoints (Spec 05)

When the backend crashes mid-turn and restarts with `--resume`, the resumed session contains messages only up to the last periodic save. The restart does **not** automatically re-run the failed turn or re-trigger `persist` loops. The user sees the last successful state and decides whether to retry.

Critically, any files that were mutated during the failed turn are **not** rolled back by the recovery system. If the user wants to discard those changes, they can run `/undo` after restart, which restores the last checkpoint (which was created before the mutations).

This means: crash recovery preserves conversation; `/undo` rolls back mutations. Use both together to fully recover from bad turns.

### Periodic state save

In addition to session save from Spec 06, the backend saves critical state every 5 seconds:
- Current session to `.kondi-chat/sessions/<id>.json`
- In-progress message (the partial assistant response currently being streamed) to `.kondi-chat/recovery/<session-id>-partial.json`

On restart, if a partial file exists, the backend loads it and appends to the session with a `[recovered from crash]` marker.

### Timeout strategy

Single `LLM_TIMEOUT_MS = 120000` applied to every provider. A turn-wall-clock budget of 300s caps the total retry+fallback chain. **Revised:** per-provider timeout table dropped — one value is simpler and good enough; tune per-provider later if traffic patterns demand it.

## Implementation Details

### New files

### No new files

Everything lands in existing files:

- **`src/providers/llm-caller.ts`** gains a retry/timeout/fallback wrapper around `callProviderRaw`, plus `isRetryableError` and `parseRetryAfter` as file-scope helpers. Constants: `LLM_TIMEOUT_MS=120000`, `RETRY_BACKOFF_MS=[1000, 3000, 10000]`, `MAX_RETRIES=3`.
- **`src/session/store.ts`** (from Spec 06) gains `savePartialMessage(sessionId, content)` and `checkForRecovery(sessionId)`, writing to `.kondi-chat/recovery/<session-id>-partial.json`. Periodic save is a single `setInterval` in `backend.ts`'s `main()` — no separate manager class.
- **`src/cli/backend.ts`** gains `uncaughtException` / `unhandledRejection` handlers that synchronously flush session + partial state, emit an `error` event, and exit.

Picking a fallback model is a single `pickFallback(failedProvider, phase, registry)` function inside `llm-caller.ts` — returns `null` (no compatible fallback) rather than looping.

### Modified files

**`src/providers/llm-caller.ts`**

- Wrap each provider call with a timeout using `AbortController`:

```typescript
export async function callLLM(request: LLMRequest): Promise<LLMResponse> {
  const timeoutMs = getProviderTimeout(request.provider);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await callProvider(request, controller.signal);
    return response;
  } catch (e) {
    if (controller.signal.aborted) {
      throw new TimeoutError(`Provider ${request.provider} timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
```

- **Revised:** previously said "use `callLLMWithRetry` in all call sites instead of `callLLM`" — this requires touching every caller (backend.ts, context/manager.ts, pipeline.ts, intent-router.ts, council/tool.ts). Simpler and safer: keep `callLLM` as the single public entry point and internalize retry + rate-limit + timeout inside it. Rename the current raw implementation to `callProviderRaw` and wrap it. Then no call site changes are required, and retry/rate-limit behave consistently across every consumer (including the context-manager compaction path and the router's intent classifier).

**`src/cli/backend.ts`**

- Wrap the entire `main()` in a try/catch and add global handlers:

```typescript
process.on('uncaughtException', (err) => {
  emit({ type: 'error', message: `Uncaught: ${err.message}` });
  try { sessionStore.save(session, profiles.getActive().name); } catch {}
  try { recoveryManager.savePartialMessage(session.id, partialContent); } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  emit({ type: 'error', message: `Unhandled rejection: ${String(reason)}` });
  try { sessionStore.save(session, profiles.getActive().name); } catch {}
  process.exit(1);
});
```

- Start `recoveryManager.startPeriodicSave()` in `main()`.
- Track `partialContent` during streams and pass it via callback.
- On startup, check for recovery data and integrate it into the session.

**TUI: `tui/src/main.rs`**

**Revised:** the current `tui/src/main.rs` spawns the backend once at the top of `main()` (line ~36, `TokioCommand::new("npx")... .spawn()`) and never checks the child process status — it drains stdout in the event loop until EOF. Adding supervision requires moving the spawn+event-loop into an inner function and wrapping it in an outer restart loop. The TUI's terminal state (`enable_raw_mode`, `EnterAlternateScreen`) must persist across restarts, so the restart loop runs *inside* the raw-mode block, not around it. The `App` struct also needs to preserve state across restarts (chat history, pending input) — currently `App::new()` starts fresh every spawn.

- Spawn backend as a subprocess via `tokio::process::Command`.
- Monitor the subprocess; if it exits unexpectedly:
  - Display "Backend crashed, restarting..." message
  - Restart with `--resume <current-session-id>`
  - On 3 restart failures in 30 seconds, give up and show an error
- Buffer user input during restart so it's not lost.

```rust
async fn run_backend_with_supervision(session_id: &str) -> Result<()> {
    let mut restart_count = 0;
    let mut last_restart = Instant::now();

    loop {
        let child = spawn_backend(session_id).await?;
        let status = child.wait().await?;

        if status.success() { return Ok(()); }

        // Reset counter if last restart was >30s ago
        if last_restart.elapsed().as_secs() > 30 {
            restart_count = 0;
        }

        restart_count += 1;
        last_restart = Instant::now();

        if restart_count >= 3 {
            return Err("Backend crashed 3 times in 30 seconds, giving up".into());
        }

        display_message("Backend crashed, restarting...");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
```

### Router resilience

Wrap each router tier call in try/catch:

```typescript
// In Router.select():
try {
  if (this.nn.isAvailable()) {
    const nnResult = this.nn.predict(...);
    if (nnResult) return nnResult;
  }
} catch (e) {
  process.stderr.write(`[router] NN failed, falling through: ${e.message}\n`);
}

try {
  if (this.useIntent) {
    const intentResult = await this.intent.classify(...);
    if (intentResult) return intentResult;
  }
} catch (e) {
  process.stderr.write(`[router] Intent failed, falling through: ${e.message}\n`);
}

// Rules always succeed
return this.rules.select(...);
```

### Context manager resilience

Memory and grounding context loading wrapped:

```typescript
// In ContextManager.assemblePrompt():
try {
  if (this.memoryManager) {
    const entries = this.memoryManager.load();
    // ...
  }
} catch (e) {
  process.stderr.write(`[context] Memory load failed: ${e.message}\n`);
}
```

## Protocol Changes

### Modified `error` event

Add two optional fields:

```json
{ "type": "error", "message": "Anthropic timeout", "recoverable": true, "retry_in_ms": 3000 }
```

### No new `recovery` event

Backend restarts are communicated via the `ready.resumed` banner (Spec 06). Provider fallbacks emit a one-line `activity`:

```json
{ "type": "activity", "text": "fallback: anthropic timeout → openai", "activity_type": "fallback" }
```

**Revised:** separate `recovery` event deleted.

## Configuration

No configuration file. Constants in `llm-caller.ts` (`LLM_TIMEOUT_MS`, `MAX_RETRIES`, `RETRY_BACKOFF_MS`, `TURN_WALL_CLOCK_MS`) and in `backend.ts` (periodic save interval `5000`, TUI supervision: max 3 crashes per 30s window). **Revised:** `recovery.json` deleted — no knobs survived the simplification pass.

## Error Handling

| Error class | Response |
|-------------|----------|
| Network timeout | Retry with backoff, fallback if exhausted |
| 429 rate limit | Honor Retry-After, fallback if exhausted |
| 500/502/503/504 | Retry once, fallback |
| 401/403 | No retry; surface as fatal (bad API key) |
| 400 | No retry; surface as agent error (bad request) |
| Stream cut mid-response | Save partial, mark as truncated, continue session |
| Process crash | Save state, emit error, let TUI restart |
| Config load fail | Use in-code defaults, warn |
| Session save fail | Emit warning but don't crash; try again on next interval |
| Permanent provider outage | User-visible message after 3 fallback attempts |

## Testing Plan

1. **Unit tests**:
   - `isRetryableError()` classifies correctly for each error type
   - `parseRetryAfter()` handles seconds and HTTP-date
   - `pickFallback()` excludes failed provider, picks capability match
   - Exponential backoff math

2. **Integration tests** (with mocked provider):
   - Timeout triggers retry and eventual fallback
   - Rate limit honors Retry-After
   - Periodic save captures state during simulated work
   - Partial message recovery on restart
   - Router tier fallthrough on exceptions

3. **Chaos tests**:
   - Kill backend mid-turn, verify TUI recovers
   - Drop network mid-stream, verify retry
   - 503 from anthropic + fallback to openai

## Dependencies

- **Depends on:** `src/providers/llm-caller.ts` (retry wrapping), `src/router/index.ts` (router try/catch), Spec 06 (Session Resume — periodic save)
- **Depended on by:** All features indirectly benefit; no direct dependents

## Estimated Effort

**2 days** (revised from 5 days)
- Day 1: Retry/timeout/fallback wrapper in `llm-caller.ts`, try/catch around router tier calls, global process handlers in backend.ts, `SessionStore.savePartialMessage` / `checkForRecovery`.
- Day 2: TUI `run_backend_with_supervision` loop (3 crashes / 30s budget), smoke tests for timeout + fallback + restart.
