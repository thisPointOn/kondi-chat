/**
 * Rate Limiter — per-provider RPM + TPM buckets with FIFO queueing.
 *
 * Every LLM call goes through `acquire()` before hitting the network;
 * `recordResponse()` reconciles token estimates with actual usage;
 * `recordThrottle()` pauses a bucket for a Retry-After window.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId } from '../types.ts';

export interface ProviderLimits {
  rpm: number;
  tpm: number;
  maxConcurrent?: number;
  maxQueueLength?: number;
}

export interface LimiterStatus {
  provider: string;
  rpmUsed: number;
  rpmLimit: number;
  tpmUsed: number;
  tpmLimit: number;
  pausedUntil?: number;
  queueLength: number;
  activeRequests: number;
  status: 'ok' | 'throttled' | 'paused' | 'idle';
}

const DEFAULTS: Record<string, ProviderLimits> = {
  anthropic: { rpm: 50, tpm: 400_000, maxConcurrent: 10, maxQueueLength: 50 },
  openai: { rpm: 30, tpm: 150_000, maxConcurrent: 10, maxQueueLength: 50 },
  deepseek: { rpm: 60, tpm: 1_000_000, maxConcurrent: 10 },
  google: { rpm: 60, tpm: 1_000_000, maxConcurrent: 10 },
  xai: { rpm: 60, tpm: 500_000 },
  ollama: { rpm: 600, tpm: 100_000_000, maxConcurrent: 4 },
};

const POST_THROTTLE_SLOWDOWN_PCT = 0.10;
const POST_THROTTLE_DURATION_MS = 5 * 60_000;
const MAX_QUEUE_LENGTH = 50;
const MAX_CONCURRENT_DEFAULT = 10;

export class RateLimitOverflowError extends Error {
  constructor(provider: string) { super(`Rate limit queue overflow for ${provider}`); }
}

interface Waiter { cost: number; resolve: () => void; reject: (e: Error) => void; queuedAt: number; }

class Bucket {
  rpmCapacity: number;
  tpmCapacity: number;
  rpmTokens: number;
  tpmTokens: number;
  lastRefill: number;
  pausedUntil = 0;
  slowdownUntil = 0;
  activeRequests = 0;
  queue: Waiter[] = [];
  maxConcurrent: number;
  maxQueueLength: number;

  constructor(public limits: ProviderLimits) {
    this.rpmCapacity = limits.rpm;
    this.tpmCapacity = limits.tpm;
    this.rpmTokens = limits.rpm;
    this.tpmTokens = limits.tpm;
    this.lastRefill = Date.now();
    this.maxConcurrent = limits.maxConcurrent ?? MAX_CONCURRENT_DEFAULT;
    this.maxQueueLength = limits.maxQueueLength ?? MAX_QUEUE_LENGTH;
  }

  refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const slowed = now < this.slowdownUntil ? (1 - POST_THROTTLE_SLOWDOWN_PCT) : 1;
    this.rpmTokens = Math.min(this.rpmCapacity, this.rpmTokens + (this.limits.rpm * slowed * elapsed) / 60_000);
    this.tpmTokens = Math.min(this.tpmCapacity, this.tpmTokens + (this.limits.tpm * slowed * elapsed) / 60_000);
    this.lastRefill = now;
  }

  tryAcquire(cost: number, now: number): boolean {
    if (now < this.pausedUntil) return false;
    if (this.activeRequests >= this.maxConcurrent) return false;
    this.refill(now);
    if (this.rpmTokens < 1 || this.tpmTokens < cost) return false;
    this.rpmTokens -= 1;
    this.tpmTokens -= cost;
    this.activeRequests++;
    return true;
  }
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(limits: Record<string, ProviderLimits>) {
    for (const [k, v] of Object.entries(limits)) this.buckets.set(k, new Bucket(v));
  }

  private getBucket(provider: string): Bucket {
    let b = this.buckets.get(provider);
    if (!b) {
      b = new Bucket(DEFAULTS[provider] || { rpm: 60, tpm: 1_000_000 });
      this.buckets.set(provider, b);
    }
    return b;
  }

  /** Reserve capacity for a call. Resolves when a slot is free. */
  async acquire(provider: string, estimatedTokens: number): Promise<void> {
    const bucket = this.getBucket(provider);
    const now = Date.now();
    if (bucket.tryAcquire(estimatedTokens, now)) return;
    if (bucket.queue.length >= bucket.maxQueueLength) {
      throw new RateLimitOverflowError(provider);
    }
    return new Promise<void>((resolve, reject) => {
      bucket.queue.push({ cost: estimatedTokens, resolve, reject, queuedAt: Date.now() });
      this.schedule(provider);
    });
  }

  private schedule(provider: string): void {
    const bucket = this.getBucket(provider);
    const loop = () => {
      const now = Date.now();
      while (bucket.queue.length > 0) {
        const head = bucket.queue[0];
        if (!bucket.tryAcquire(head.cost, now)) break;
        bucket.queue.shift();
        head.resolve();
      }
      if (bucket.queue.length > 0) {
        const waitMs = Math.max(50, now < bucket.pausedUntil ? bucket.pausedUntil - now : 200);
        setTimeout(loop, waitMs);
      }
    };
    setTimeout(loop, 0);
  }

  /** Reconcile estimated vs actual and parse rate-limit headers. */
  recordResponse(
    provider: string,
    actualInputTokens: number,
    actualOutputTokens: number,
    estimatedTokens: number,
    headers?: Record<string, string>,
  ): void {
    const bucket = this.getBucket(provider);
    bucket.activeRequests = Math.max(0, bucket.activeRequests - 1);
    const actual = actualInputTokens + actualOutputTokens;
    const delta = estimatedTokens - actual;
    // Refund over-estimate, charge under-estimate.
    bucket.tpmTokens = Math.min(bucket.tpmCapacity, bucket.tpmTokens + delta);
    if (headers) {
      const ra = headers['retry-after'] || headers['Retry-After'];
      if (ra) {
        const ms = /^\d+$/.test(ra) ? parseInt(ra, 10) * 1000 : Math.max(0, new Date(ra).getTime() - Date.now());
        if (ms > 0) this.recordThrottle(provider, ms);
      }
    }
    this.schedule(provider);
  }

  recordThrottle(provider: string, retryAfterMs: number): void {
    const bucket = this.getBucket(provider);
    const now = Date.now();
    bucket.pausedUntil = Math.max(bucket.pausedUntil, now + retryAfterMs);
    bucket.slowdownUntil = bucket.pausedUntil + POST_THROTTLE_DURATION_MS;
    bucket.activeRequests = Math.max(0, bucket.activeRequests - 1);
    this.schedule(provider);
  }

  getStatus(): LimiterStatus[] {
    const now = Date.now();
    const out: LimiterStatus[] = [];
    for (const [provider, b] of this.buckets) {
      b.refill(now);
      let status: LimiterStatus['status'] = 'ok';
      if (now < b.pausedUntil) status = 'paused';
      else if (b.queue.length > 0) status = 'throttled';
      else if (b.rpmTokens === b.rpmCapacity && b.activeRequests === 0) status = 'idle';
      out.push({
        provider,
        rpmUsed: Math.round(b.rpmCapacity - b.rpmTokens),
        rpmLimit: b.rpmCapacity,
        tpmUsed: Math.round(b.tpmCapacity - b.tpmTokens),
        tpmLimit: b.tpmCapacity,
        pausedUntil: b.pausedUntil || undefined,
        queueLength: b.queue.length,
        activeRequests: b.activeRequests,
        status,
      });
    }
    return out;
  }

  format(): string {
    const rows = this.getStatus();
    if (rows.length === 0) return 'No rate limit buckets active.';
    const lines = ['provider     rpm            tpm                  status'];
    for (const r of rows) {
      const rpm = `${r.rpmUsed}/${r.rpmLimit}`.padEnd(13);
      const tpm = `${r.tpmUsed.toLocaleString()}/${r.tpmLimit.toLocaleString()}`.padEnd(20);
      const extra = r.queueLength > 0 ? ` (${r.queueLength} queued)` : '';
      lines.push(`${r.provider.padEnd(12)} ${rpm}  ${tpm} ${r.status}${extra}`);
    }
    return lines.join('\n');
  }
}

// ── Config loader + global instance ──────────────────────────────────

export function loadRateLimitConfig(storageDir: string): Record<string, ProviderLimits> {
  const path = `${storageDir}/rate-limits.json`;
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ limits: DEFAULTS }, null, 2));
    } catch { /* non-fatal */ }
    return { ...DEFAULTS };
  }
  // Fail closed on corrupt config: rate limits guard paid APIs and a silent
  // fallback could leave a user thinking a custom (stricter) config was in
  // effect. Surface the error; the caller decides whether to continue.
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if (raw == null || typeof raw !== 'object' || (raw.limits != null && typeof raw.limits !== 'object')) {
    throw new Error(`rate-limits.json is malformed (expected { limits: {...} })`);
  }
  return { ...DEFAULTS, ...(raw.limits || {}) };
}

let globalRateLimiter: RateLimiter | undefined;
export function setRateLimiter(r: RateLimiter | undefined): void { globalRateLimiter = r; }
export function getRateLimiter(): RateLimiter | undefined { return globalRateLimiter; }
