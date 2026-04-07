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

  // Routing context (features for the NN)
  phase: LedgerPhase;
  taskKind?: TaskKind;
  promptLength: number;
  contextTokens: number;
  failures: number;
  promoted: boolean;

  /** Truncated prompt text for embedding (first 512 chars) */
  promptText?: string;
  /** Pre-computed embedding vector (if embedding service was available) */
  embedding?: number[];

  // What was chosen
  modelId: string;
  provider: string;

  // Outcome (labels for the NN)
  succeeded: boolean;
  verificationPassed?: boolean;
  /** API error — model was unreachable, overloaded, or timed out */
  apiError?: boolean;
  /** Error code (429, 500, 529, etc.) */
  apiErrorCode?: number;
  /** Was this a fallback call after the primary model failed? */
  wasFallback?: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;

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

    // Discover all phases and task kinds from the data (open-ended)
    const phases = [...new Set(samples.map(s => s.phase))].sort();
    const taskKinds = [...new Set(samples.map(s => s.taskKind || 'none'))].sort();

    // Build feature names for interpretability
    const featureNames = [
      ...phases.map(p => `phase:${p}`),
      ...taskKinds.map(k => `kind:${k}`),
      'prompt_length',
      'context_tokens',
      'failures',
    ];

    const features: number[][] = [];
    const labels: Record<string, number[]> = {};
    for (const name of modelNames) labels[name] = [];

    for (const s of samples) {
      // One-hot phase (dynamic)
      const phaseVec = phases.map(p => p === s.phase ? 1 : 0);
      // One-hot task kind (dynamic)
      const kindVec = taskKinds.map(k => k === (s.taskKind || 'none') ? 1 : 0);
      // Normalized features
      const promptNorm = Math.min(s.promptLength / 10_000, 1);
      const contextNorm = Math.min(s.contextTokens / 100_000, 1);
      const failureNorm = Math.min(s.failures / 5, 1);

      features.push([...phaseVec, ...kindVec, promptNorm, contextNorm, failureNorm]);

      // Labels: did this model succeed on this sample?
      for (const name of modelNames) {
        if (s.modelId === name) {
          labels[name].push(s.succeeded ? 1 : 0);
        } else {
          // Unknown — we didn't test this model on this sample
          labels[name].push(-1); // -1 = missing, exclude from loss
        }
      }
    }

    // Collect embeddings (null for samples without them)
    const embeddings: (number[] | null)[] = samples.map(s => s.embedding || null);
    const embeddingDim = embeddings.find(e => e !== null)?.length || 0;

    return { features, embeddings, labels, modelNames, featureNames, embeddingDim };
  }
}
