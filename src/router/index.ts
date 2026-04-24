/**
 * Unified Router — chains NN → Intent → Rules for model selection.
 *
 * The Intent Router is the primary and most capable strategy — it reads
 * every model's description and capabilities from the registry and asks
 * an LLM which one best fits the task. It handles any model, any capability.
 *
 * The NN Router is a fast approximation of Intent — when trained on enough
 * data, it can predict the Intent Router's choice without an LLM call.
 * It's used when available for speed (no API latency).
 *
 * The Rule Router is the minimal fallback — phase/task-kind heuristics
 * that always produce a result but don't consider model descriptions.
 *
 * Priority: NN (if trained & confident) → Intent (primary) → Rules (fallback)
 */

import type { LedgerPhase, TaskKind, ProviderId } from '../types.ts';
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

/**
 * Context about what happened in prior phases of the current pipeline.
 * Fed to the intent router so the LLM classifier can make informed
 * decisions — "Gemini just wrote the code, tests passed, pick a
 * reviewer" instead of blindly seeing the original prompt again.
 */
export interface PhaseContext {
  priorPhases?: Array<{
    phase: string;
    model: string;
    summary?: string;
    succeeded?: boolean;
  }>;
  currentGoal?: string;
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
  /**
   * Active profile scope + classifier overrides, applied to every
   * `select()` call. `setProfileScope` is called from backend.ts whenever
   * the active budget profile changes so the intent router (and its
   * classifier LLM) stay inside the profile's allowedProviders.
   */
  private profileScope: {
    allowedProviders?: ProviderId[];
    classifier?: { provider: ProviderId; model: string };
    rolePinning?: Record<string, string>;
  } = {};

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
   * Update the profile-scoped behavior for intent routing:
   *   - allowedProviders: filters candidate models
   *   - classifier: overrides the classifier LLM (e.g. zai uses glm-4.5-flash)
   * Called from backend.ts whenever the active profile changes.
   */
  setProfileScope(scope: {
    classifier?: { provider: ProviderId; model: string };
    rolePinning?: Record<string, string>;
  }): void {
    // Derive allowedProviders from rolePinning automatically.
    // The profile declares models, and the providers follow from those.
    // No separate allowedProviders field needed.
    let allowedProviders: ProviderId[] | undefined;
    if (scope.rolePinning) {
      const providers = new Set<ProviderId>();
      for (const modelId of Object.values(scope.rolePinning)) {
        const m = this.registry.getById(modelId);
        if (m) providers.add(m.provider);
      }
      if (providers.size > 0) {
        allowedProviders = [...providers];
      }
    }
    this.profileScope = { ...scope, allowedProviders };
  }

  /** Get the profile-scoped classifier model (for task-router, compactor, etc.) */
  getClassifier(): { provider: ProviderId; model: string } | undefined {
    return this.profileScope.classifier;
  }

  /**
   * Select the best model. Tries NN → Intent → Pin fallback → Rules.
   *
   * The intent router gets rich phase context (what models handled prior
   * phases, what succeeded/failed) so it can make informed per-phase
   * decisions. Profile pins (`rolePinning`) now serve as the fallback,
   * not the first check — the router gets a real shot at intelligent
   * selection before the hard override kicks in.
   */
  async select(
    phase: LedgerPhase,
    promptText: string,
    taskKind?: TaskKind,
    failures?: number,
    promotionThreshold?: number,
    phaseContext?: PhaseContext,
  ): Promise<UnifiedRouteDecision> {
    // 1. Try NN router (fast, no LLM call).
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

    // 2. Intent router with enriched phase context. When the profile has
    //    rolePinning, derive the exact candidate model IDs from the pin
    //    values so the classifier sees only those 4–5 models, not every
    //    model from 3 providers. Much less noise, much better picks.
    const pinnedModelIds = this.profileScope.rolePinning
      ? [...new Set(Object.values(this.profileScope.rolePinning))]
      : undefined;

    try {
      if (this.useIntent) {
        const intentResult = await this.intent.classify(
          promptText, phase, taskKind, this.registry,
          {
            allowedProviders: this.profileScope.allowedProviders,
            allowedModelIds: pinnedModelIds,
            classifier: this.profileScope.classifier,
            phaseContext,
            phasePreference: this.profileScope.rolePinning?.[phase],
          },
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

    // 3. Profile pin fallback. If the intent router didn't produce a
    //    result (classifier error, no candidates, model hallucination),
    //    honor the profile's rolePinning as a hard guarantee. This
    //    preserves the deterministic behavior users relied on while the
    //    intent router was the primary path — pins only fire when the
    //    intelligent tiers fail.
    const pinnedId = this.profileScope.rolePinning?.[phase];
    if (pinnedId) {
      const pinned = this.registry.getById(pinnedId);
      if (pinned && pinned.enabled) {
        return {
          model: pinned,
          reason: `pin fallback: ${phase} → ${pinned.alias || pinned.id}`,
          tier: 'rules',
          promoted: false,
        };
      }
    }

    // 4. Rule-based fallback — deterministic phase/task-kind heuristics.
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
