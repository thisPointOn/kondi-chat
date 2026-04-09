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

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
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
    const { writeFileSync } = require('node:fs');
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

  /** Get summary stats for training readiness */
  getStats(): {
    totalSamples: number;
    byModel: Record<string, { total: number; succeeded: number; apiErrors: number; avgCost: number }>;
    byPhase: Record<string, { total: number; succeeded: number }>;
    readyForTraining: boolean;
  } {
    const samples = this.getAll();
    const byModel: Record<string, { total: number; succeeded: number; apiErrors: number; totalCost: number }> = {};
    const byPhase: Record<string, { total: number; succeeded: number }> = {};

    for (const s of samples) {
      // By model
      if (!byModel[s.modelId]) byModel[s.modelId] = { total: 0, succeeded: 0, apiErrors: 0, totalCost: 0 };
      byModel[s.modelId].total++;
      if (s.succeeded) byModel[s.modelId].succeeded++;
      if (s.apiError) byModel[s.modelId].apiErrors++;
      byModel[s.modelId].totalCost += s.costUsd;

      // By phase
      if (!byPhase[s.phase]) byPhase[s.phase] = { total: 0, succeeded: 0 };
      byPhase[s.phase].total++;
      if (s.succeeded) byPhase[s.phase].succeeded++;
    }

    const modelStats: Record<string, { total: number; succeeded: number; apiErrors: number; avgCost: number }> = {};
    for (const [id, data] of Object.entries(byModel)) {
      modelStats[id] = {
        total: data.total,
        succeeded: data.succeeded,
        apiErrors: data.apiErrors,
        avgCost: data.total > 0 ? data.totalCost / data.total : 0,
      };
    }

    return {
      totalSamples: samples.length,
      byModel: modelStats,
      byPhase,
      // Need at least 100 samples with multiple models to train usefully
      readyForTraining: samples.length >= 100 && Object.keys(byModel).length >= 2,
    };
  }

  /** Format stats for display */
  formatStats(): string {
    const stats = this.getStats();
    if (stats.totalSamples === 0) return 'No routing data collected yet.';

    const lines: string[] = [
      `Routing data: ${stats.totalSamples} samples (${stats.readyForTraining ? 'ready for training' : 'collecting...'})`,
      '',
      'By model:',
    ];

    for (const [id, data] of Object.entries(stats.byModel)) {
      const rate = data.total > 0 ? (data.succeeded / data.total * 100).toFixed(0) : '0';
      const reliability = data.total > 0 ? (((data.total - data.apiErrors) / data.total) * 100).toFixed(0) : '100';
      const errorTag = data.apiErrors > 0 ? `  ${data.apiErrors} API errors (${reliability}% reliable)` : '';
      lines.push(`  ${id.padEnd(35)} ${data.total} calls  ${rate}% success  $${data.avgCost.toFixed(4)}/call${errorTag}`);
    }

    lines.push('', 'By phase:');
    for (const [phase, data] of Object.entries(stats.byPhase)) {
      const rate = data.total > 0 ? (data.succeeded / data.total * 100).toFixed(0) : '0';
      lines.push(`  ${phase.padEnd(16)} ${data.total} calls  ${rate}% success`);
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
