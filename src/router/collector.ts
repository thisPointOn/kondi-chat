/**
 * Training Data Collector — logs every routing decision for NN training.
 *
 * Every time the router picks a model, we record:
 *   - The routing context (phase, task kind, prompt features)
 *   - Which model was chosen
 *   - Whether it succeeded (verification passed, no errors)
 *   - Cost and latency
 *
 * This accumulates into a JSONL file that feeds the NN trainer.
 * The orchestrator is the teacher; the NN is the student.
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerPhase, TaskKind } from '../types.ts';
import type { EmbeddingService } from './embeddings.ts';

// ---------------------------------------------------------------------------
// Training sample
// ---------------------------------------------------------------------------

export interface RoutingSample {
  timestamp: string;

  // --- Routing context (features for the NN) ---
  phase: LedgerPhase;
  taskKind?: TaskKind;
  promptLength: number;
  contextTokens: number;
  failures: number;
  promoted: boolean;
  /** Active budget profile when this decision was made */
  profile?: string;

  /** Truncated prompt text for embedding (first 512 chars) */
  promptText?: string;
  /** Pre-computed embedding vector (if embedding service was available) */
  embedding?: number[];

  // --- What was chosen ---
  modelId: string;
  provider: string;

  // --- Outcome (labels for the NN) ---
  succeeded: boolean;
  verificationPassed?: boolean;

  /** API error — model was unreachable, overloaded, or timed out */
  apiError?: boolean;
  /** Error code (429, 500, 529, etc.) */
  apiErrorCode?: number;
  /** Was this a fallback call after the primary model failed? */
  wasFallback?: boolean;

  // --- Cost & performance ---
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;

  // --- Quality signals (richer training data) ---

  /**
   * User accepted the response (moved on to next message without
   * rejecting, retrying, or asking the same question).
   * null = not yet determined (set retroactively).
   */
  userAccepted?: boolean | null;

  /**
   * User retried — sent a very similar message right after this response,
   * indicating the response was unsatisfactory.
   */
  userRetried?: boolean;

  /**
   * Quality score 0-1 based on heuristics:
   * - Did the model use tools appropriately?
   * - Was the response length reasonable for the task?
   * - Did the user follow up with a correction?
   * - Did verification pass (if applicable)?
   */
  qualityScore?: number;

  /**
   * Cost efficiency: quality / cost. Higher = better value.
   * Used to learn which model gives the best bang for buck.
   */
  costEfficiency?: number;

  /** Which routing tier made this selection */
  routingTier?: 'nn' | 'intent' | 'rules';

  // The reason the rule router gave
  routeReason: string;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class RoutingCollector {
  private filePath: string;
  private embeddingService?: EmbeddingService;

  constructor(storageDir: string, embeddingService?: EmbeddingService) {
    this.filePath = join(storageDir, 'routing-data.jsonl');
    this.embeddingService = embeddingService;
  }

  /** Record a routing decision and its outcome */
  record(sample: RoutingSample): void {
    const line = JSON.stringify(sample) + '\n';
    appendFileSync(this.filePath, line);
  }

  /**
   * Record with async embedding. Embeds the prompt text and stores
   * the vector alongside the sample. Non-blocking — if embedding fails,
   * the sample is still recorded without an embedding.
   */
  async recordWithEmbedding(sample: RoutingSample, promptText: string): Promise<void> {
    sample.promptText = promptText.slice(0, 512);
    if (this.embeddingService) {
      try {
        sample.embedding = await this.embeddingService.embed(promptText.slice(0, 2048));
      } catch {
        // Embedding failed — record without it
      }
    }
    this.record(sample);
  }

  /**
   * Retroactively update the last sample for a model with user feedback.
   * Called when we detect the user's next action implies acceptance or rejection.
   */
  recordFeedback(modelId: string, feedback: {
    userAccepted?: boolean;
    userRetried?: boolean;
    qualityScore?: number;
  }): void {
    // Read all samples, update the last one matching this model, rewrite
    const samples = this.getAll();
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].modelId === modelId) {
        if (feedback.userAccepted !== undefined) samples[i].userAccepted = feedback.userAccepted;
        if (feedback.userRetried !== undefined) samples[i].userRetried = feedback.userRetried;
        if (feedback.qualityScore !== undefined) {
          samples[i].qualityScore = feedback.qualityScore;
          // Compute cost efficiency
          if (samples[i].costUsd > 0) {
            samples[i].costEfficiency = feedback.qualityScore / samples[i].costUsd;
          }
        }
        break;
      }
    }
    // Rewrite the file
    writeFileSync(this.filePath, samples.map(s => JSON.stringify(s)).join('\n') + '\n');
  }

  /**
   * Compute a quality score based on heuristics.
   * Returns 0-1 where 1 is best quality.
   */
  static computeQualityScore(params: {
    verificationPassed?: boolean;
    apiError?: boolean;
    userRetried?: boolean;
    responseLength: number;
    toolsUsed: number;
    latencyMs: number;
    phase: string;
  }): number {
    let score = 0.5; // Base score

    // Verification is the strongest signal
    if (params.verificationPassed === true) score += 0.3;
    if (params.verificationPassed === false) score -= 0.4;

    // API errors are very bad
    if (params.apiError) score -= 0.5;

    // User retry is a strong negative signal
    if (params.userRetried) score -= 0.3;

    // Response length heuristics (too short or too long is bad)
    if (params.phase === 'execute' && params.responseLength < 50) score -= 0.1;
    if (params.responseLength > 20000) score -= 0.05; // Wastefully long

    // Tool usage in discuss phase is usually good (model is investigating)
    if (params.phase === 'discuss' && params.toolsUsed > 0) score += 0.1;

    // Very slow responses are penalized slightly
    if (params.latencyMs > 30000) score -= 0.05;

    return Math.max(0, Math.min(1, score));
  }

  /** Load all recorded samples */
  getAll(): RoutingSample[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return readFileSync(this.filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /** Get summary stats for training readiness and dashboard display */
  getStats(): {
    totalSamples: number;
    readyForTraining: boolean;
    byTier: Record<string, { total: number; succeeded: number; avgLatencyMs: number; avgCost: number }>;
    byModel: Record<string, { total: number; succeeded: number; apiErrors: number; avgCost: number; avgLatencyMs: number; avgQuality: number }>;
    byPhase: Record<string, { total: number; succeeded: number }>;
    byModelTier: Record<string, Record<string, { total: number; succeeded: number }>>;
    avgQualityScore: number;
    avgCostEfficiency: number;
    totalCost: number;
    firstSample: string | null;
    lastSample: string | null;
  } {
    const samples = this.getAll();
    const byTier: Record<string, { total: number; succeeded: number; totalLatency: number; totalCost: number }> = {};
    const byModel: Record<string, { total: number; succeeded: number; apiErrors: number; totalCost: number; totalLatency: number; qualitySum: number; qualityCount: number }> = {};
    const byPhase: Record<string, { total: number; succeeded: number }> = {};
    const byModelTier: Record<string, Record<string, { total: number; succeeded: number }>> = {};

    let totalQuality = 0, qualityCount = 0;
    let totalEfficiency = 0, efficiencyCount = 0;
    let totalCost = 0;
    let firstTs: string | null = null, lastTs: string | null = null;

    for (const s of samples) {
      // Time range
      if (!firstTs || s.timestamp < firstTs) firstTs = s.timestamp;
      if (!lastTs || s.timestamp > lastTs) lastTs = s.timestamp;

      // By tier
      const tier = s.routingTier || 'rules';
      if (!byTier[tier]) byTier[tier] = { total: 0, succeeded: 0, totalLatency: 0, totalCost: 0 };
      byTier[tier].total++;
      if (s.succeeded) byTier[tier].succeeded++;
      byTier[tier].totalLatency += s.latencyMs;
      byTier[tier].totalCost += s.costUsd;

      // By model
      if (!byModel[s.modelId]) byModel[s.modelId] = { total: 0, succeeded: 0, apiErrors: 0, totalCost: 0, totalLatency: 0, qualitySum: 0, qualityCount: 0 };
      byModel[s.modelId].total++;
      if (s.succeeded) byModel[s.modelId].succeeded++;
      if (s.apiError) byModel[s.modelId].apiErrors++;
      byModel[s.modelId].totalCost += s.costUsd;
      byModel[s.modelId].totalLatency += s.latencyMs;
      if (s.qualityScore !== undefined) {
        byModel[s.modelId].qualitySum += s.qualityScore;
        byModel[s.modelId].qualityCount++;
      }

      // By phase
      if (!byPhase[s.phase]) byPhase[s.phase] = { total: 0, succeeded: 0 };
      byPhase[s.phase].total++;
      if (s.succeeded) byPhase[s.phase].succeeded++;

      // By model × tier
      if (!byModelTier[s.modelId]) byModelTier[s.modelId] = {};
      if (!byModelTier[s.modelId][tier]) byModelTier[s.modelId][tier] = { total: 0, succeeded: 0 };
      byModelTier[s.modelId][tier].total++;
      if (s.succeeded) byModelTier[s.modelId][tier].succeeded++;

      // Global quality / efficiency
      if (s.qualityScore !== undefined) { totalQuality += s.qualityScore; qualityCount++; }
      if (s.costEfficiency !== undefined) { totalEfficiency += s.costEfficiency; efficiencyCount++; }
      totalCost += s.costUsd;
    }

    const modelStats: Record<string, { total: number; succeeded: number; apiErrors: number; avgCost: number; avgLatencyMs: number; avgQuality: number }> = {};
    for (const [id, d] of Object.entries(byModel)) {
      modelStats[id] = {
        total: d.total, succeeded: d.succeeded, apiErrors: d.apiErrors,
        avgCost: d.total > 0 ? d.totalCost / d.total : 0,
        avgLatencyMs: d.total > 0 ? d.totalLatency / d.total : 0,
        avgQuality: d.qualityCount > 0 ? d.qualitySum / d.qualityCount : 0,
      };
    }

    const tierStats: Record<string, { total: number; succeeded: number; avgLatencyMs: number; avgCost: number }> = {};
    for (const [t, d] of Object.entries(byTier)) {
      tierStats[t] = {
        total: d.total, succeeded: d.succeeded,
        avgLatencyMs: d.total > 0 ? d.totalLatency / d.total : 0,
        avgCost: d.total > 0 ? d.totalCost / d.total : 0,
      };
    }

    return {
      totalSamples: samples.length,
      readyForTraining: samples.length >= 100 && Object.keys(byModel).length >= 2,
      byTier: tierStats,
      byModel: modelStats,
      byPhase,
      byModelTier,
      avgQualityScore: qualityCount > 0 ? totalQuality / qualityCount : 0,
      avgCostEfficiency: efficiencyCount > 0 ? totalEfficiency / efficiencyCount : 0,
      totalCost,
      firstSample: firstTs,
      lastSample: lastTs,
    };
  }

  /** Format stats as a rich terminal dashboard */
  formatStats(): string {
    const stats = this.getStats();
    if (stats.totalSamples === 0) return 'No routing data collected yet.';

    const lines: string[] = [];
    const w = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);

    lines.push('═══ Routing Statistics ═══');
    lines.push('');

    // Date range
    const fmtDate = (iso: string | null) => iso ? iso.slice(0, 10) : '?';
    lines.push(`Data: ${stats.totalSamples.toLocaleString()} samples (${fmtDate(stats.firstSample)} → ${fmtDate(stats.lastSample)})`);

    // NN training readiness
    const nnSamples = stats.byTier.nn?.total ?? 0;
    const needed = Math.max(0, 100 - stats.totalSamples);
    const multiModel = Object.keys(stats.byModel).length >= 2;
    if (stats.readyForTraining) {
      lines.push(`NN Training: ✓ ready (${stats.totalSamples} samples, ${Object.keys(stats.byModel).length} models)`);
    } else {
      const reason = !multiModel ? `need ≥2 models, have ${Object.keys(stats.byModel).length}` : `need 100 samples, have ${stats.totalSamples}`;
      lines.push(`NN Training: ✗ collecting (${reason})`);
    }
    lines.push('');

    // Tier distribution
    lines.push('── Tier Distribution ──────────────────────────────────────');
    const tierOrder = ['intent', 'nn', 'rules'] as const;
    for (const tier of tierOrder) {
      const d = stats.byTier[tier];
      if (!d) continue;
      const pct = stats.totalSamples > 0 ? (d.total / stats.totalSamples * 100).toFixed(0) : '0';
      const succ = d.total > 0 ? (d.succeeded / d.total * 100).toFixed(0) : '0';
      const lat = d.avgLatencyMs > 0 ? `${(d.avgLatencyMs / 1000).toFixed(1)}s` : '—';
      const tag = tier === 'intent' ? '  ← primary' : '';
      lines.push(`  ${tier.padEnd(8)} ${String(d.total).padStart(5)} calls (${pct.padStart(3)}%)  ${succ}% success  avg ${lat}${tag}`);
    }
    lines.push('');

    // Model selection
    lines.push('── Model Selection ───────────────────────────────────────');
    // Sort by total descending
    const sortedModels = Object.entries(stats.byModel).sort((a, b) => b[1].total - a[1].total);
    for (const [id, d] of sortedModels) {
      const pct = stats.totalSamples > 0 ? (d.total / stats.totalSamples * 100).toFixed(0) : '0';
      const succ = d.total > 0 ? (d.succeeded / d.total * 100).toFixed(0) : '0';
      const qTag = d.avgQuality > 0 ? `  Q:${d.avgQuality.toFixed(2)}` : '';
      lines.push(`  ${w(id, 36)} ${String(d.total).padStart(5)} (${pct.padStart(3)}%)  ${succ}% success  $${d.avgCost.toFixed(4)}/call${qTag}`);
    }
    lines.push('');

    // Model × Tier matrix
    if (Object.keys(stats.byModelTier).length > 0) {
      lines.push('── Model × Tier ──────────────────────────────────────────');
      for (const [model, tiers] of Object.entries(stats.byModelTier)) {
        const parts = tierOrder.map(t => {
          const td = tiers[t];
          return td ? `${t}:${td.total}` : '';
        }).filter(Boolean);
        lines.push(`  ${w(model, 36)} ${parts.join('  ')}`);
      }
      lines.push('');
    }

    // Quality & efficiency
    if (stats.avgQualityScore > 0 || stats.totalCost > 0) {
      lines.push('── Quality & Efficiency ──────────────────────────────────');
      if (stats.avgQualityScore > 0) lines.push(`  Avg quality score:   ${stats.avgQualityScore.toFixed(2)}/1.0`);
      if (stats.avgCostEfficiency > 0) lines.push(`  Avg cost efficiency: ${stats.avgCostEfficiency.toFixed(1)}`);
      lines.push(`  Total spent:         $${stats.totalCost.toFixed(4)}`);
      lines.push('');
    }

    // By phase
    lines.push('── By Phase ──────────────────────────────────────────────');
    for (const [phase, d] of Object.entries(stats.byPhase)) {
      const rate = d.total > 0 ? (d.succeeded / d.total * 100).toFixed(0) : '0';
      lines.push(`  ${phase.padEnd(16)} ${String(d.total).padStart(5)} calls  ${rate}% success`);
    }

    return lines.join('\n');
  }

  /**
   * Export to the format expected by the NN trainer.
   *
   * Features are dynamically built from whatever phases and task kinds
   * appear in the data — no hardcoded enum. New domains (robot control,
   * image generation, etc.) are automatically encoded as new features.
   */
  exportForTraining(): {
    features: number[][];
    embeddings: (number[] | null)[];
    labels: Record<string, number[]>;
    modelNames: string[];
    featureNames: string[];
    embeddingDim: number;
  } {
    const samples = this.getAll();
    if (samples.length === 0) return { features: [], embeddings: [], labels: {}, modelNames: [], featureNames: [], embeddingDim: 0 };

    // Collect all model IDs
    const modelNames = [...new Set(samples.map(s => s.modelId))].sort();

    // Discover all categories from the data (open-ended)
    const phases = [...new Set(samples.map(s => s.phase))].sort();
    const taskKinds = [...new Set(samples.map(s => s.taskKind || 'none'))].sort();
    const profileNames = [...new Set(samples.map(s => s.profile || 'none'))].sort();

    // Build feature names for interpretability
    const featureNames = [
      ...phases.map(p => `phase:${p}`),
      ...taskKinds.map(k => `kind:${k}`),
      ...profileNames.map(p => `profile:${p}`),
      'prompt_length',
      'context_tokens',
      'failures',
      'latency_norm',
    ];

    const features: number[][] = [];
    const labels: Record<string, number[]> = {};
    for (const name of modelNames) labels[name] = [];

    for (const s of samples) {
      // One-hot phase (dynamic)
      const phaseVec = phases.map(p => p === s.phase ? 1 : 0);
      // One-hot task kind (dynamic)
      const kindVec = taskKinds.map(k => k === (s.taskKind || 'none') ? 1 : 0);
      // One-hot profile (dynamic)
      const profileVec = profileNames.map(p => p === (s.profile || 'none') ? 1 : 0);
      // Normalized features
      const promptNorm = Math.min(s.promptLength / 10_000, 1);
      const contextNorm = Math.min(s.contextTokens / 100_000, 1);
      const failureNorm = Math.min(s.failures / 5, 1);
      const latencyNorm = Math.min(s.latencyMs / 60_000, 1);

      features.push([...phaseVec, ...kindVec, ...profileVec, promptNorm, contextNorm, failureNorm, latencyNorm]);

      // Labels: use quality score if available, otherwise binary success
      for (const name of modelNames) {
        if (s.modelId === name) {
          const label = s.qualityScore !== undefined ? s.qualityScore : (s.succeeded ? 1 : 0);
          labels[name].push(label);
        } else {
          labels[name].push(-1); // Unknown — exclude from loss
        }
      }
    }

    // Collect embeddings (null for samples without them)
    const embeddings: (number[] | null)[] = samples.map(s => s.embedding || null);
    const embeddingDim = embeddings.find(e => e !== null)?.length || 0;

    return { features, embeddings, labels, modelNames, featureNames, embeddingDim };
  }
}
