/**
 * Unified Router — chains NN → Intent → Rules for model selection.
 *
 * 1. NN Router: fast, trained on accumulated data (primary)
 * 2. Intent Router: LLM classifies against model descriptions (cold-start)
 * 3. Rule Router: phase/task-kind fallback (always works)
 *
 * The intent router is only used when:
 *   - NN router returns null (low confidence or not trained)
 *   - The registry has models the NN hasn't seen
 */

import type { LedgerPhase, TaskKind } from '../types.ts';
import type { ModelEntry } from './registry.ts';
import { ModelRegistry } from './registry.ts';
import { RuleRouter, type RouteDecision } from './rules.ts';
import { NNRouter } from './nn-router.ts';
import { IntentRouter, type IntentRouterConfig } from './intent-router.ts';
import { EmbeddingService, type EmbeddingConfig } from './embeddings.ts';
import { RoutingCollector } from './collector.ts';

// ---------------------------------------------------------------------------
// Unified route decision
// ---------------------------------------------------------------------------

export interface UnifiedRouteDecision {
  model: ModelEntry;
  reason: string;
  tier: 'nn' | 'intent' | 'rules';
  promoted: boolean;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Unified Router
// ---------------------------------------------------------------------------

export class Router {
  readonly registry: ModelRegistry;
  readonly rules: RuleRouter;
  readonly nn: NNRouter;
  readonly intent: IntentRouter;
  readonly embeddings: EmbeddingService;
  readonly collector: RoutingCollector;

  private useIntent: boolean;

  constructor(
    storageDir: string,
    options?: {
      embeddingConfig?: Partial<EmbeddingConfig>;
      intentConfig?: Partial<IntentRouterConfig>;
      useIntent?: boolean;
      nnConfidenceThreshold?: number;
    },
  ) {
    this.registry = new ModelRegistry(storageDir);
    this.rules = new RuleRouter(this.registry);
    this.embeddings = new EmbeddingService(storageDir, options?.embeddingConfig);
    this.nn = new NNRouter(storageDir, options?.nnConfidenceThreshold);
    this.intent = new IntentRouter(options?.intentConfig);
    this.collector = new RoutingCollector(storageDir, this.embeddings);
    this.useIntent = options?.useIntent ?? true;
  }

  /**
   * Select the best model. Tries NN → Intent → Rules in order.
   */
  async select(
    phase: LedgerPhase,
    promptText: string,
    taskKind?: TaskKind,
    failures?: number,
    promotionThreshold?: number,
  ): Promise<UnifiedRouteDecision> {
    // 1. Try NN router (fast, no LLM call) — Spec 13: never let a tier crash the turn.
    try {
      if (this.nn.isAvailable()) {
        let embedding: number[] | undefined;
        try { embedding = await this.embeddings.embed(promptText.slice(0, 2048)); } catch { /* skip */ }

        const nnResult = this.nn.predict(
          phase, taskKind,
          promptText.length, 0, failures || 0,
          this.registry, embedding,
        );

        if (nnResult) {
          return {
            model: nnResult.model,
            reason: `nn (${(nnResult.confidence * 100).toFixed(0)}% confidence)`,
            tier: 'nn',
            promoted: false,
            confidence: nnResult.confidence,
          };
        }
      }
    } catch (e) {
      process.stderr.write(`[router] NN tier failed: ${(e as Error).message}\n`);
    }

    // 2. Try intent router (LLM call, for cold-start/new models)
    try {
      if (this.useIntent) {
        const intentResult = await this.intent.classify(
          promptText, phase, taskKind, this.registry,
        );

        if (intentResult) {
          return {
            model: intentResult.model,
            reason: `intent: ${intentResult.intent}`,
            tier: 'intent',
            promoted: false,
          };
        }
      }
    } catch (e) {
      process.stderr.write(`[router] Intent tier failed: ${(e as Error).message}\n`);
    }

    // 3. Fall back to rules
    const ruleResult = this.rules.select(phase, taskKind, failures, promotionThreshold);
    return {
      model: ruleResult.model,
      reason: ruleResult.reason,
      tier: 'rules',
      promoted: ruleResult.promoted,
    };
  }

  /**
   * Synchronous select — rules only. Use when you can't await.
   */
  selectSync(
    phase: LedgerPhase,
    taskKind?: TaskKind,
    failures?: number,
    promotionThreshold?: number,
  ): UnifiedRouteDecision {
    const ruleResult = this.rules.select(phase, taskKind, failures, promotionThreshold);
    return {
      model: ruleResult.model,
      reason: ruleResult.reason,
      tier: 'rules',
      promoted: ruleResult.promoted,
    };
  }

  /** Status summary for display. */
  status(): string {
    const lines: string[] = [];
    lines.push(`NN Router: ${this.nn.isAvailable() ? 'trained and active' : 'not trained (collecting data)'}`);
    lines.push(`Intent Router: ${this.useIntent ? 'enabled' : 'disabled'}`);
    lines.push(`Rule Router: active (fallback)`);
    lines.push(`Embeddings: ${this.embeddings.getConfig().backend}/${this.embeddings.getConfig().model} (${this.embeddings.getConfig().dimension}D, ${this.embeddings.cacheSize()} cached)`);
    return lines.join('\n');
  }
}

// Re-export for convenience
export { ModelRegistry, type ModelEntry } from './registry.ts';
export { RuleRouter, type RouteDecision } from './rules.ts';
export { NNRouter } from './nn-router.ts';
export { IntentRouter } from './intent-router.ts';
export { EmbeddingService, type EmbeddingConfig } from './embeddings.ts';
export { RoutingCollector, type RoutingSample } from './collector.ts';
