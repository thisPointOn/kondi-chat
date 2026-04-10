# 14 — Rate Limiting

## Product Description

Rate Limiting tracks per-provider request and token quotas (RPM, TPM), queues requests when at the limit instead of failing, and auto-throttles based on provider response headers (`Retry-After`, `X-RateLimit-Remaining`). Sub-agents share the same rate limit pool as the parent. A `/rate-limits` command shows current usage versus configured limits.

**Why it matters:** Hitting rate limits in the middle of a long task is frustrating and can cost money (errors are still billed on some providers). Proactive rate limiting makes the system smooth and predictable: if you're about to hit a limit, the request waits briefly instead of failing. This is especially critical when sub-agents (Spec 07) are spawning parallel requests.

**Revised 2026-04-10 (simplification pass):** Collapsed the two new events (`rate_limit_status`, `rate_limit_throttled`) into one `activity` event with `activity_type: 'rate_limit'`. Dropped `enableProactive` (always on), `postThrottleSlowdownPct` / `slowdownDurationMs` (fixed constants), `reloadConfig()` (restart). Kept `rate-limits.json` — per-provider RPM/TPM are real knobs users need. Effort dropped from 3-4 days to 2 days.

## User Stories

1. **Proactive throttling:** A user runs an agent loop with many iterations. They approach Anthropic's 50 RPM limit. The rate limiter detects the pace, slows new requests, and keeps the agent under the limit without any errors.

2. **Queue on saturation:** 3 sub-agents each want to call Claude simultaneously but only 2 concurrent requests fit in the current window. One queues for 400ms until a slot opens, then runs.

3. **Retry-After respected:** Claude returns 429 with `Retry-After: 15`. The rate limiter records this, pauses Anthropic calls for 15 seconds, and all pending/new Anthropic requests wait. After 15 seconds, calls resume at a slightly lower rate to avoid hitting the limit again.

4. **TPM vs RPM:** The user's GPT-4o limit is 30 RPM and 150,000 TPM. A single request with 100k input tokens consumes most of the TPM budget. The rate limiter knows to wait for token budget to refill before sending the next large request, even though RPM is fine.

5. **Dashboard view:** The user runs `/rate-limits` and sees:
   ```
   anthropic  rpm: 12/50   tpm: 45,231/400,000   status: ok
   openai     rpm: 28/30   tpm: 112,445/150,000  status: throttled (3 queued)
   deepseek   rpm:  0/60   tpm:  0/1,000,000     status: idle
   ```

## Clarifications (2026-04-10)

- **Capacity check:** `acquire` must reserve estimated input plus max expected output tokens; adjust with actual usage on completion to avoid TPM overruns.
- **Concurrency:** Enforce `maxConcurrent` per provider in addition to RPM/TPM. Excess requests should queue or fail, not bypass.
- **Persistence:** `pausedUntil` and queued requests must survive backend restarts or be rebuilt from pending requests to honor `Retry-After`.
- **Provider headers:** Support `Retry-After` and, where available, `X-RateLimit-Remaining/Reset`; document per-provider behavior.
- **Fail-safe default:** If the limiter state is invalid or crashes, fail closed with a clear error instead of silently disabling rate limits.
## Technical Design

### Architecture

```
Every LLM call
        │
        v
┌─────────────────────────────────┐
│ RateLimiter.acquire(provider,    │
│                     estTokens)   │
│                                  │
│  - Check RPM bucket              │
│  - Check TPM bucket              │
│  - If limited: queue and wait    │
│  - If ok: consume, return        │
└────────────┬────────────────────┘
             │
             v
       Call provider
             │
             v
┌─────────────────────────────────┐
│ RateLimiter.recordResponse()     │
│                                  │
│  - Record actual tokens used     │
│  - Parse rate limit headers      │
│  - Update bucket state           │
│  - Honor Retry-After             │
└─────────────────────────────────┘
```

### Token bucket implementation

Each provider has two token buckets:
1. **RPM bucket**: capacity = configured RPM, refill rate = RPM/60 per second
2. **TPM bucket**: capacity = configured TPM, refill rate = TPM/60 per second

A call consumes 1 RPM token and `estimatedTokens` TPM tokens. After the response, we reconcile with actual tokens used and refund the difference.

### Interaction with retry layer (Spec 13)

The retry layer (`src/providers/retry.ts`) and the rate limiter (`src/providers/rate-limiter.ts`) cooperate:

1. **Before the call:** Retry layer calls rate limiter's `acquire()`. If the queue overflows, acquire throws `RateLimitOverflowError`, and the retry layer treats it as a fallback trigger (tries a different provider).
2. **On 429/503 response:** Both layers see the event. The rate limiter records the throttle via `recordThrottle()`, pausing its bucket. The retry layer decides whether to retry (on same provider after Retry-After) or fall back (to different provider).
3. **Shared source of truth:** The rate limiter's `pausedUntil` is the authoritative "when can we call this provider again". The retry layer queries it via `getStatus()` before deciding.

Rule: if the rate limiter says "paused for 15s" and the retry budget only allows 10s of total backoff, the retry layer falls back to another provider instead of waiting. If the budget allows 15+ seconds, it waits.

### Retry-After handling

When a provider returns 429 or 503 with `Retry-After`:
1. Parse the value (seconds or HTTP-date)
2. Set a "pauseUntil" timestamp on that provider's limiter
3. New `acquire()` calls on that provider wait until pauseUntil
4. After resume, drop the refill rate by 10% for 5 minutes to avoid immediate re-throttling

### Queue fairness

Pending requests are served FIFO within each provider. The queue is cooperative — waiters are resolved via `setTimeout` when tokens become available, not via spin waits.

A max queue length (default 50) prevents unbounded backlogs. If the queue is full, `acquire()` rejects immediately with a `RateLimitOverflowError`, which the retry layer (Spec 13) can handle via fallback.

## Implementation Details

### New files

**`src/providers/rate-limiter.ts`**

```typescript
import type { ProviderId } from '../types.ts';

export interface ProviderLimits {
  rpm: number;
  tpm: number;
  maxConcurrent?: number;
  maxQueueLength?: number;
}

export interface RateLimiterConfig {
  limits: Record<ProviderId, ProviderLimits>;
  enableProactive: boolean;
  postThrottleSlowdownPct: number;
  slowdownDurationMs: number;
}

export interface LimiterStatus {
  provider: ProviderId;
  rpmUsed: number;
  rpmLimit: number;
  tpmUsed: number;
  tpmLimit: number;
  pausedUntil?: number;
  queueLength: number;
  activeRequests: number;
  status: 'ok' | 'throttled' | 'paused' | 'idle';
}

export class RateLimiter {
  private config: RateLimiterConfig;
  private buckets: Map<ProviderId, ProviderBucket>;

  constructor(config: RateLimiterConfig);

  /** Acquire capacity for a call. Returns when capacity is available. */
  async acquire(provider: ProviderId, estimatedInputTokens: number): Promise<void>;

  /** Record the actual response, refunding unused tokens */
  recordResponse(
    provider: ProviderId,
    actualInputTokens: number,
    actualOutputTokens: number,
    estimatedTokens: number,
    headers?: Record<string, string>,
  ): void;

  /** Record a 429/503 with Retry-After */
  recordThrottle(provider: ProviderId, retryAfterMs: number): void;

  /** Get current status for all providers */
  getStatus(): LimiterStatus[];

  /** Format for /rate-limits command */
  format(): string;

}

class ProviderBucket {
  rpmTokens: number;
  tpmTokens: number;
  rpmRefillRate: number;  // tokens/ms
  tpmRefillRate: number;  // tokens/ms
  lastRefill: number;
  pausedUntil: number;
  queue: Array<{ cost: number; resolve: () => void; queuedAt: number }>;
  activeRequests: number;

  refill(now: number): void;
  tryAcquire(tokenCost: number, now: number): boolean;
  enqueue(tokenCost: number): Promise<void>;
  drainQueue(): void;
}
```

### Modified files

**`src/providers/llm-caller.ts`**

**Revised:** per Spec 13's revision, retry/rate-limit/timeout all live inside `callLLM` (wrapping a renamed raw `callProviderRaw`). Order inside the wrapper: `rateLimiter.acquire` → `retry.loop(callProviderRaw)` → `rateLimiter.recordResponse`/`recordThrottle`. The module-level `globalRateLimiter` pattern is fine — it matches the project's "direct and minimal" style — but it means tests must reset it via `setRateLimiter(undefined)` in `afterEach`.

Wrap each provider call with rate limiter:

```typescript
import { RateLimiter } from './rate-limiter.ts';
import { estimateTokens } from '../context/budget.ts';

let globalRateLimiter: RateLimiter | undefined;

export function setRateLimiter(limiter: RateLimiter): void {
  globalRateLimiter = limiter;
}

export async function callLLM(request: LLMRequest): Promise<LLMResponse> {
  const estimatedTokens = estimateTokens(
    request.systemPrompt +
    (request.userMessage || '') +
    (request.messages?.map(m => m.content).join('\n') || '')
  );

  if (globalRateLimiter) {
    await globalRateLimiter.acquire(request.provider, estimatedTokens);
  }

  try {
    const response = await callProvider(request);

    if (globalRateLimiter) {
      globalRateLimiter.recordResponse(
        request.provider,
        response.inputTokens,
        response.outputTokens,
        estimatedTokens,
        response.responseHeaders,
      );
    }

    return response;
  } catch (e) {
    if (e.status === 429 || e.status === 503) {
      const retryAfter = parseRetryAfter(e.headers?.['retry-after'] || '1') * 1000;
      globalRateLimiter?.recordThrottle(request.provider, retryAfter);
    }
    throw e;
  }
}
```

The low-level `callProvider()` function must now expose `responseHeaders` on `LLMResponse`. Add to types:

```typescript
export interface LLMResponse {
  // ... existing
  responseHeaders?: Record<string, string>;
}
```

**`src/cli/backend.ts`** — Initialize and expose via `/rate-limits`:

```typescript
import { RateLimiter, setRateLimiter } from '../providers/rate-limiter.ts';

const rateLimitConfig = loadRateLimitConfig(storageDir);
const rateLimiter = new RateLimiter(rateLimitConfig);
setRateLimiter(rateLimiter);

// In handleCommand:
case '/rate-limits':
  return rateLimiter.format();
```

### Sharing with sub-agents

Since sub-agents run in the same process, they share `globalRateLimiter` automatically. No special wiring needed — they use `callLLM()` which goes through the limiter.

### Web tools integration

The `WebToolsManager` (Spec 11) has its own rate limiter for search API calls. These are separate from LLM rate limits because they apply to different endpoints. However, the dashboard can show both:

```
/rate-limits
───── LLM Providers ─────
anthropic  rpm: 12/50  tpm: 45,231/400,000  ok
openai     rpm: 28/30  tpm: 112,445/150,000 throttled (3q)

───── Web Tools ─────
brave      rpm:  3/60  status: ok
```

## Protocol Changes

**None.** Rate-limit queueing and throttle events are emitted as regular `activity`:

```json
{ "type": "activity", "text": "anthropic queued 1.2s", "activity_type": "rate_limit" }
{ "type": "activity", "text": "openai throttled 15s (429)", "activity_type": "rate_limit" }
```

**Revised:** two new events collapsed to a single reuse of `activity`.

## Configuration

**`.kondi-chat/rate-limits.json`**

```json
{
  "limits": {
    "anthropic": { "rpm": 50, "tpm": 400000, "maxConcurrent": 10, "maxQueueLength": 50 },
    "openai": { "rpm": 30, "tpm": 150000, "maxConcurrent": 10, "maxQueueLength": 50 },
    "deepseek": { "rpm": 60, "tpm": 1000000, "maxConcurrent": 10 },
    "google": { "rpm": 60, "tpm": 1000000, "maxConcurrent": 10 },
    "xai": { "rpm": 60, "tpm": 500000 },
    "ollama": { "rpm": 600, "tpm": 100000000, "maxConcurrent": 4 }
  },
}
```

`enableProactive`, `postThrottleSlowdownPct`, `slowdownDurationMs` removed — proactive limiting is always on; post-throttle slowdown is hard-coded to 10% for 5 min in `rate-limiter.ts`.

Defaults are conservative (match free-tier limits) but users can raise them to match their actual plan.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Provider returns 429 | Record throttle, pause bucket, wait Retry-After |
| Queue overflow (>maxQueueLength) | Throw `RateLimitOverflowError`, Spec 13 triggers fallback |
| Estimated tokens wildly wrong | Reconcile on `recordResponse()`; log warning if estimate was >50% off |
| Clock skew / NTP adjustment | Use `performance.now()` for refill math |
| Config missing for provider | Fall back to permissive defaults (high limits); log warning |
| Rate limiter crashes | Calls proceed without limiting (fail-open); error logged |
| Sub-agent cancelled while queued | Waiter rejected with AbortError; queue cleaned |

## Testing Plan

1. **Unit tests** (`src/providers/rate-limiter.test.ts`):
   - Token bucket math (refill rate, capacity)
   - RPM limit enforced via queue
   - TPM limit enforced via queue (large request waits)
   - Retry-After pauses bucket correctly
   - Post-throttle slowdown applies for correct duration
   - Queue overflow throws correctly
   - Status format output

2. **Integration tests**:
   - Mock provider returning 429 triggers pause
   - Concurrent requests queue fairly (FIFO)
   - Sub-agent requests share parent's rate limit

3. **Load tests**:
   - 100 concurrent `acquire()` calls on a 10 RPM limiter complete over 10 minutes
   - Verify no deadlocks under contention

## Dependencies

- **Depends on:** `src/providers/llm-caller.ts` (integration point), `src/types.ts` (LLMResponse header field)
- **Depended on by:** Spec 07 (Sub-agents — share rate limits), Spec 13 (Error Recovery — overflow triggers fallback), Spec 11 (Web Tools — reuses TokenBucket implementation)

## Estimated Effort

**2 days** (revised from 3-4 days)
- Day 1: `RateLimiter` + `ProviderBucket` (acquire/recordResponse/recordThrottle/getStatus/format), config load.
- Day 2: `llm-caller.ts` integration (acquire → call → record), header parsing, `/rate-limits` command, smoke tests.
