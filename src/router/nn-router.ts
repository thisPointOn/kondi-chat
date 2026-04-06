/**
 * NN Router — lightweight neural network for model selection.
 *
 * Trained by src/router/train.py from data collected by the rule-based
 * router. At inference time, predicts which model will succeed for a
 * given (phase, task_kind, prompt_length, context_tokens, failures).
 *
 * Falls back to the rule router when:
 *   - No trained model exists
 *   - Confidence is below threshold
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerPhase, TaskKind } from '../types.ts';
import type { ModelRegistry, ModelEntry } from './registry.ts';
import type { EmbeddingService } from './embeddings.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NNModelData {
  nn: {
    weights: number[][][];
    biases: number[][];
    layerDims: number[];
  };
  featureInfo: {
    phases: string[];
    taskKinds: string[];
    featureNames: string[];
    inputDim: number;
    embeddingDim: number;
    hasEmbeddings: boolean;
  };
  modelNames: string[];
  metrics: Record<string, unknown>;
  sampleCount: number;
}

// ---------------------------------------------------------------------------
// Inference (pure math, no dependencies)
// ---------------------------------------------------------------------------

function relu(x: number[]): number[] {
  return x.map(v => Math.max(0, v));
}

function sigmoid(x: number[]): number[] {
  return x.map(v => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, v)))));
}

function matmul(input: number[], weights: number[][], bias: number[]): number[] {
  const output = new Array(weights[0].length).fill(0);
  for (let j = 0; j < output.length; j++) {
    let sum = bias[j];
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * weights[i][j];
    }
    output[j] = sum;
  }
  return output;
}

function predict(input: number[], weights: number[][][], biases: number[][]): number[] {
  let x = input;
  for (let layer = 0; layer < weights.length; layer++) {
    x = matmul(x, weights[layer], biases[layer]);
    if (layer < weights.length - 1) {
      x = relu(x);
    } else {
      x = sigmoid(x);
    }
  }
  return x;
}

// ---------------------------------------------------------------------------
// NN Router
// ---------------------------------------------------------------------------

export class NNRouter {
  private modelData: NNModelData | null = null;
  private modelPath: string;
  private confidenceThreshold: number;

  constructor(storageDir: string, confidenceThreshold = 0.6) {
    this.modelPath = join(storageDir, 'router-model.json');
    this.confidenceThreshold = confidenceThreshold;
    this.load();
  }

  /** Is a trained model available? */
  isAvailable(): boolean {
    return this.modelData !== null;
  }

  /** Reload model from disk (after retraining). */
  reload(): void {
    this.load();
  }

  /**
   * Predict the best model for a given context.
   * Returns null if no model is loaded or confidence is too low.
   *
   * @param embedding Optional pre-computed embedding from EmbeddingService.
   *   If the model was trained with embeddings and none is provided,
   *   a zero vector is used (degrades to structured-only features).
   */
  predict(
    phase: LedgerPhase,
    taskKind: TaskKind | undefined,
    promptLength: number,
    contextTokens: number,
    failures: number,
    registry: ModelRegistry,
    embedding?: number[],
  ): { model: ModelEntry; confidence: number; probabilities: Record<string, number> } | null {
    if (!this.modelData) return null;

    const features = this.encodeFeatures(phase, taskKind, promptLength, contextTokens, failures, embedding);
    const probs = predict(features, this.modelData.nn.weights, this.modelData.nn.biases);

    // Build probability map
    const probabilities: Record<string, number> = {};
    let bestIdx = 0;
    let bestProb = 0;

    for (let i = 0; i < this.modelData.modelNames.length; i++) {
      const name = this.modelData.modelNames[i];
      probabilities[name] = probs[i];
      if (probs[i] > bestProb) {
        bestProb = probs[i];
        bestIdx = i;
      }
    }

    // Check confidence threshold
    if (bestProb < this.confidenceThreshold) return null;

    // Find the model in the registry
    const modelId = this.modelData.modelNames[bestIdx];
    const model = registry.getById(modelId);
    if (!model || !model.enabled) return null;

    return { model, confidence: bestProb, probabilities };
  }

  // -------------------------------------------------------------------------
  // Feature encoding
  // -------------------------------------------------------------------------

  private encodeFeatures(
    phase: LedgerPhase,
    taskKind: TaskKind | undefined,
    promptLength: number,
    contextTokens: number,
    failures: number,
    embedding?: number[],
  ): number[] {
    if (!this.modelData) return [];

    const info = this.modelData.featureInfo;

    // Structured features
    const phaseVec = info.phases.map(p => p === phase ? 1 : 0);
    const kindVec = info.taskKinds.map(k => k === (taskKind || 'none') ? 1 : 0);
    const promptNorm = Math.min(promptLength / 10_000, 1);
    const contextNorm = Math.min(contextTokens / 100_000, 1);
    const failureNorm = Math.min(failures / 5, 1);
    const structured = [...phaseVec, ...kindVec, promptNorm, contextNorm, failureNorm];

    // Prepend embedding if the model was trained with them
    if (info.hasEmbeddings && info.embeddingDim > 0) {
      const emb = embedding || new Array(info.embeddingDim).fill(0);
      // Pad or truncate to expected dimension
      const padded = emb.length >= info.embeddingDim
        ? emb.slice(0, info.embeddingDim)
        : [...emb, ...new Array(info.embeddingDim - emb.length).fill(0)];
      return [...padded, ...structured];
    }

    return structured;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): void {
    if (!existsSync(this.modelPath)) {
      this.modelData = null;
      return;
    }

    try {
      const raw = readFileSync(this.modelPath, 'utf-8');
      this.modelData = JSON.parse(raw);
    } catch {
      this.modelData = null;
    }
  }
}
