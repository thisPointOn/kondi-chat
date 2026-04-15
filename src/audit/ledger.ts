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

/**
 * Pricing per 1M tokens.
 * `cachedInput` is the discounted rate for prompt-cached bytes — typically
 * 10% of standard (Anthropic) or 50% (OpenAI/Z.AI). If omitted, we use the
 * standard input rate as a conservative fallback.
 */
const PRICING: Record<string, { input: number; output: number; cachedInput?: number }> = {
  // Anthropic (cache-read priced at ~10% of input on current plans)
  'claude-opus-4-20250514':     { input: 15,   output: 75,  cachedInput: 1.50 },
  'claude-sonnet-4-5-20250929': { input: 3,    output: 15,  cachedInput: 0.30 },
  'claude-haiku-4-5-20251001':  { input: 0.8,  output: 4,   cachedInput: 0.08 },
  // OpenAI (cached reads at 50% of input)
  'gpt-5.4':                    { input: 2.5,  output: 15,  cachedInput: 1.25 },
  'gpt-5.4-mini':               { input: 0.75, output: 4.5, cachedInput: 0.375 },
  'gpt-5.4-nano':               { input: 0.20, output: 1.25, cachedInput: 0.10 },
  'gpt-4o':                     { input: 2.5,  output: 10,  cachedInput: 1.25 },
  'gpt-4o-mini':                { input: 0.15, output: 0.6, cachedInput: 0.075 },
  // DeepSeek (cached at ~10%)
  'deepseek-chat':              { input: 0.27, output: 1.10, cachedInput: 0.027 },
  // Google / xAI (no documented cache discount)
  'models/gemini-2.5-flash':    { input: 0.15, output: 0.6 },
  'grok-3':                     { input: 3,    output: 15 },
  // Z.AI GLM — per https://docs.z.ai/guides/overview/pricing (cached at 50%)
  'glm-5.1':                    { input: 1.4,  output: 4.4, cachedInput: 0.7 },
  'glm-5':                      { input: 1.0,  output: 3.2, cachedInput: 0.5 },
  'glm-5-turbo':                { input: 1.2,  output: 4.0, cachedInput: 0.6 },
  'glm-4.7':                    { input: 0.6,  output: 2.2, cachedInput: 0.3 },
  'glm-4.6':                    { input: 0.6,  output: 2.2, cachedInput: 0.3 },
  'glm-4.5':                    { input: 0.6,  output: 2.2, cachedInput: 0.3 },
  'glm-4.5-air':                { input: 0.2,  output: 1.1, cachedInput: 0.1 },
  'glm-4.5-flash':              { input: 0,    output: 0 },
  'glm-4.7-flash':              { input: 0,    output: 0 },
};

/**
 * Estimate cost in USD.
 * @param cachedInputTokens  Portion of inputTokens served from prompt cache.
 *                           Billed at the model's `cachedInput` rate (typically
 *                           10–50% of standard input) instead of `input`.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = PRICING[model] || { input: 3, output: 15 };
  const cached = Math.min(cachedInputTokens, inputTokens);
  const uncachedInput = inputTokens - cached;
  const cachedRate = p.cachedInput ?? p.input;
  return (uncachedInput * p.input + cached * cachedRate + outputTokens * p.output) / 1_000_000;
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
    const cached = response.cachedInputTokens ?? 0;
    const cost = estimateCost(response.model, response.inputTokens, response.outputTokens, cached);

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
      cached: response.cached ?? cached > 0,
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
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
