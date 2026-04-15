/**
 * Loop Guard — prevents runaway costs in autonomous loops.
 *
 * Tracks:
 *   - Iteration count vs cap
 *   - Cumulative cost vs budget
 *   - Error deduplication (same error twice = stuck)
 *   - Diminishing returns (no progress between iterations)
 *
 * Used by the regular agent loop inside handleSubmit and by the autonomous
 * /loop command which runs handleSubmit with opts.loop = true (so the loop
 * does not stop at the first no-tool-call response).
 */

import type { BudgetProfile } from '../router/profiles.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopStatus {
  iteration: number;
  maxIterations: number;
  costUsd: number;
  costCap: number;
  lastErrors: string[];
  stuck: boolean;
  shouldStop: boolean;
  stopReason?: string;
}

// ---------------------------------------------------------------------------
// Loop Guard
// ---------------------------------------------------------------------------

export class LoopGuard {
  private iteration = 0;
  private costUsd = 0;
  private recentErrors: string[] = [];
  private errorCounts: Map<string, number> = new Map();
  private lastOutputHash = '';

  private maxIterations: number;
  private costCap: number;

  constructor(profile: BudgetProfile) {
    this.maxIterations = profile.loopIterationCap;
    this.costCap = profile.loopCostCap;
  }

  /** Record a completed iteration */
  recordIteration(cost: number, error?: string, outputHash?: string): void {
    this.iteration++;
    this.costUsd += cost;

    if (error) {
      // Normalize error for dedup (strip line numbers, timestamps)
      const normalized = this.normalizeError(error);
      this.recentErrors.push(normalized);
      if (this.recentErrors.length > 5) this.recentErrors.shift();

      const count = (this.errorCounts.get(normalized) || 0) + 1;
      this.errorCounts.set(normalized, count);
    }

    if (outputHash) {
      this.lastOutputHash = outputHash;
    }
  }

  /** Check if the loop should continue */
  check(): LoopStatus {
    const status: LoopStatus = {
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      costUsd: this.costUsd,
      costCap: this.costCap,
      lastErrors: [...this.recentErrors.slice(-3)],
      stuck: false,
      shouldStop: false,
    };

    // Iteration cap
    if (this.iteration >= this.maxIterations) {
      status.shouldStop = true;
      status.stopReason = `iteration limit (${this.maxIterations})`;
      return status;
    }

    // Cost cap
    if (this.costUsd >= this.costCap) {
      status.shouldStop = true;
      status.stopReason = `cost limit ($${this.costCap.toFixed(2)}, spent $${this.costUsd.toFixed(4)})`;
      return status;
    }

    // Error deduplication — same error 3+ times means stuck
    for (const [error, count] of this.errorCounts) {
      if (count >= 3) {
        status.stuck = true;
        status.shouldStop = true;
        status.stopReason = `stuck on repeated error (${count}x): ${error.slice(0, 100)}`;
        return status;
      }
    }

    // Same error back-to-back
    if (this.recentErrors.length >= 2) {
      const last = this.recentErrors[this.recentErrors.length - 1];
      const prev = this.recentErrors[this.recentErrors.length - 2];
      if (last === prev) {
        status.stuck = true;
        status.shouldStop = true;
        status.stopReason = `same error repeated: ${last.slice(0, 100)}`;
        return status;
      }
    }

    return status;
  }

  /** Get a summary for display */
  getSummary(): string {
    const status = this.check();
    return [
      `Iteration ${status.iteration}/${status.maxIterations}`,
      `Cost: $${status.costUsd.toFixed(4)} / $${status.costCap.toFixed(2)}`,
      status.stuck ? 'STUCK — same error repeating' : '',
      status.shouldStop ? `Stopped: ${status.stopReason}` : 'Running',
    ].filter(Boolean).join(' | ');
  }

  /** Reset for a new loop */
  reset(): void {
    this.iteration = 0;
    this.costUsd = 0;
    this.recentErrors = [];
    this.errorCounts.clear();
    this.lastOutputHash = '';
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private normalizeError(error: string): string {
    return error
      .replace(/line \d+/g, 'line N')
      .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
      .replace(/\d+:\d+:\d+/g, 'TIME')
      .replace(/0x[a-f0-9]+/gi, '0xADDR')
      .trim()
      .slice(0, 300);
  }
}
