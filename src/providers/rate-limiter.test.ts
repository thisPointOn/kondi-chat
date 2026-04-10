import { describe, it, expect } from 'vitest';
import { RateLimiter, RateLimitOverflowError } from './rate-limiter.ts';

describe('RateLimiter', () => {
  it('acquires within capacity', async () => {
    const rl = new RateLimiter({ test: { rpm: 60, tpm: 1_000_000, maxConcurrent: 5 } });
    await rl.acquire('test', 100);
    const status = rl.getStatus().find(s => s.provider === 'test')!;
    expect(status.rpmUsed).toBe(1);
    expect(status.tpmUsed).toBeGreaterThanOrEqual(100);
  });

  it('throws overflow when queue is saturated', async () => {
    const rl = new RateLimiter({
      tiny: { rpm: 1, tpm: 10, maxConcurrent: 1, maxQueueLength: 0 },
    });
    await rl.acquire('tiny', 1);
    await expect(rl.acquire('tiny', 1)).rejects.toBeInstanceOf(RateLimitOverflowError);
  });

  it('refunds over-estimated tokens on recordResponse', async () => {
    const rl = new RateLimiter({ test: { rpm: 60, tpm: 1000 } });
    await rl.acquire('test', 500);
    rl.recordResponse('test', 10, 10, 500);
    const status = rl.getStatus().find(s => s.provider === 'test')!;
    // After refund, TPM used should be close to the actual 20, not the estimated 500.
    expect(status.tpmUsed).toBeLessThanOrEqual(30);
  });
});
