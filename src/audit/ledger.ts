/**
 * Audit Ledger — append-only log of every LLM call and verification.
 *
 * Records what was sent, what came back, which model handled it,
 * how much it cost, and what task it was for. Persisted to disk
 * alongside the session for full auditability.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerEntry, LedgerPhase, LLMResponse, ProviderId } from '../types.ts';

// ---------------------------------------------------------------------------
// Pricing table (USD per 1M tokens)
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'models/gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'grok-3': { input: 3, output: 15 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] || { input: 3, output: 15 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class Ledger {
  private entries: LedgerEntry[] = [];
  private sessionId: string;
  private storageDir?: string;

  constructor(sessionId: string, storageDir?: string) {
    this.sessionId = sessionId;
    this.storageDir = storageDir;

    if (storageDir) {
      mkdirSync(storageDir, { recursive: true });
      const existing = this.loadFromDisk();
      if (existing) this.entries = existing;
    }
  }

  /**
   * Record an LLM call in the ledger.
   */
  record(
    phase: LedgerPhase,
    response: LLMResponse,
    promptSummary: string,
    opts?: { taskId?: string; promoted?: boolean },
  ): LedgerEntry {
    const cost = estimateCost(response.model, response.inputTokens, response.outputTokens);

    const entry: LedgerEntry = {
      id: `${this.sessionId}-${this.entries.length.toString().padStart(4, '0')}`,
      timestamp: new Date().toISOString(),
      phase,
      provider: response.provider,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      latencyMs: response.latencyMs,
      costUsd: cost,
      cached: response.cached ?? false,
      promptSummary: truncate(promptSummary, 500),
      responseSummary: truncate(response.content, 500),
      taskId: opts?.taskId,
      promoted: opts?.promoted,
    };

    this.entries.push(entry);
    this.persistToDisk();

    return entry;
  }

  /**
   * Record a local verification step (no LLM call).
   */
  recordVerification(
    taskId: string,
    passed: boolean,
    output: string,
  ): LedgerEntry {
    const entry: LedgerEntry = {
      id: `${this.sessionId}-${this.entries.length.toString().padStart(4, '0')}`,
      timestamp: new Date().toISOString(),
      phase: 'verify',
      provider: 'ollama' as ProviderId, // placeholder — no actual provider
      model: 'local',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: 0,
      cached: false,
      promptSummary: `Verification for task ${taskId}`,
      responseSummary: truncate(output, 500),
      taskId,
    };

    this.entries.push(entry);
    this.persistToDisk();

    return entry;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getAll(): LedgerEntry[] {
    return [...this.entries];
  }

  getByPhase(phase: LedgerPhase): LedgerEntry[] {
    return this.entries.filter(e => e.phase === phase);
  }

  getByTask(taskId: string): LedgerEntry[] {
    return this.entries.filter(e => e.taskId === taskId);
  }

  getTotals(): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    byPhase: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
    byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  } {
    const byPhase: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};
    const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const e of this.entries) {
      totalInput += e.inputTokens;
      totalOutput += e.outputTokens;
      totalCost += e.costUsd;

      if (!byPhase[e.phase]) byPhase[e.phase] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      byPhase[e.phase].calls++;
      byPhase[e.phase].inputTokens += e.inputTokens;
      byPhase[e.phase].outputTokens += e.outputTokens;
      byPhase[e.phase].costUsd += e.costUsd;

      if (!byModel[e.model]) byModel[e.model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      byModel[e.model].calls++;
      byModel[e.model].inputTokens += e.inputTokens;
      byModel[e.model].outputTokens += e.outputTokens;
      byModel[e.model].costUsd += e.costUsd;
    }

    return {
      calls: this.entries.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      costUsd: totalCost,
      byPhase,
      byModel,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persistToDisk(): void {
    if (!this.storageDir) return;
    const path = join(this.storageDir, `${this.sessionId}-ledger.json`);
    writeFileSync(path, JSON.stringify(this.entries, null, 2));
  }

  private loadFromDisk(): LedgerEntry[] | null {
    if (!this.storageDir) return null;
    const path = join(this.storageDir, `${this.sessionId}-ledger.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}
