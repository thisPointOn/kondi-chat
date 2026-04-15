/**
 * Intent Router — LLM-based classification, the primary routing strategy.
 *
 * Reads every model's description and capabilities from the registry and
 * asks a cheap LLM: "given these model descriptions, which one best matches
 * this task?" This is the smartest tier — it handles any model, any capability,
 * and adapts automatically when models are added or removed.
 *
 * Priority chain:
 *   1. NN Router  — fast approximation of Intent (when trained)
 *   2. Intent Router — primary, reads model descriptions (this file)
 *   3. Rule Router — minimal phase/task-kind fallback
 */

import type { LedgerPhase, TaskKind, ProviderId } from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';
import type { ModelRegistry, ModelEntry } from './registry.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface IntentRouterConfig {
  /** Provider for the classification LLM (should be cheap/fast) */
  provider: ProviderId;
  model?: string;
  /**
   * Phases to run intent routing on. Defaults to *all* phases — the intent
   * router is the primary tier, so we want it owning every decision it can.
   */
  phases?: LedgerPhase[];
}

const DEFAULT_CONFIG: IntentRouterConfig = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  // `undefined` = all phases eligible.
};

/** Optional per-call overrides that come from the active budget profile. */
export interface IntentRouterCallOptions {
  /** If set, only consider models from these providers. */
  allowedProviders?: ProviderId[];
  /** Override the classifier LLM for this call (e.g. zai's glm-4.5-flash). */
  classifier?: { provider: ProviderId; model: string };
}

// ---------------------------------------------------------------------------
// Intent Router
// ---------------------------------------------------------------------------

export class IntentRouter {
  private config: IntentRouterConfig;

  constructor(config?: Partial<IntentRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Classify a prompt against available models and return the best match.
   * Returns null if classification fails.
   */
  async classify(
    promptText: string,
    phase: LedgerPhase,
    taskKind: TaskKind | undefined,
    registry: ModelRegistry,
    opts?: IntentRouterCallOptions,
  ): Promise<{ model: ModelEntry; intent: string } | null> {
    // Phase filter: if the caller restricted phases in config, honor it.
    // Default (no config) = all phases.
    if (this.config.phases && !this.config.phases.includes(phase)) {
      return null;
    }

    // Candidate scope: profile's allowedProviders wins over all-enabled.
    let enabled = registry.getEnabled();
    if (opts?.allowedProviders && opts.allowedProviders.length > 0) {
      const allow = new Set(opts.allowedProviders);
      enabled = enabled.filter(m => allow.has(m.provider));
    }
    if (enabled.length <= 1) {
      // Trivial case: if there's only one candidate (or zero), skip the LLM
      // call and let whatever's there be the answer — or defer to the next
      // router tier. Returning null triggers the fallback chain.
      return enabled.length === 1
        ? { model: enabled[0], intent: 'only-candidate' }
        : null;
    }

    // Build route descriptions from registry
    const routes = enabled.map(m => ({
      name: m.id,
      description: this.describeModel(m),
    }));

    const routesXml = routes
      .map(r => `  <route name="${r.name}">${r.description}</route>`)
      .join('\n');

    const prompt = `You are a router that selects the best model for a given task.

<routes>
${routesXml}
</routes>

<task>
Phase: ${phase}
${taskKind ? `Kind: ${taskKind}` : ''}
Prompt: ${promptText.slice(0, 1000)}
</task>

Which route best matches this task? Consider the model's capabilities and cost.
Respond with ONLY a JSON object: {"route": "model_id"}`;

    // Classifier model: per-call override (from active profile) > config default.
    const classifierProvider = opts?.classifier?.provider ?? this.config.provider;
    const classifierModel = opts?.classifier?.model ?? this.config.model;

    try {
      const response = await callLLM({
        provider: classifierProvider,
        model: classifierModel,
        systemPrompt: 'You select the best model for a task. Respond with only JSON.',
        userMessage: prompt,
        maxOutputTokens: 50,
        temperature: 0,
      });

      const parsed = this.parseResponse(response.content);
      if (!parsed) return null;

      const model = registry.getById(parsed);
      // Also re-check it's inside the allowed set — the LLM could hallucinate
      // a model name that wasn't in the input list.
      if (!model || !model.enabled) return null;
      if (opts?.allowedProviders && opts.allowedProviders.length > 0) {
        if (!opts.allowedProviders.includes(model.provider)) return null;
      }

      process.stderr.write(`  │  intent-router: ${model.id} (via ${response.model})\n`);
      return { model, intent: parsed };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Generate a natural language description of a model from its registry entry. */
  private describeModel(m: ModelEntry): string {
    const costTier = m.inputCostPer1M < 1 ? 'cheap' : m.inputCostPer1M < 5 ? 'mid-tier' : 'expensive';
    return (
      `${m.name} — ${costTier} model (${m.provider}). ` +
      `Good at: ${m.capabilities.join(', ')}. ` +
      `Context: ${(m.contextWindow / 1000).toFixed(0)}K tokens. ` +
      `Cost: $${m.inputCostPer1M}/M input, $${m.outputCostPer1M}/M output.`
    );
  }

  /** Parse the LLM's route selection from its response. */
  private parseResponse(content: string): string | null {
    try {
      // Try JSON parse
      const match = content.match(/\{[^}]*"route"\s*:\s*"([^"]+)"[^}]*\}/);
      if (match) return match[1];

      // Try plain text
      const cleaned = content.trim().replace(/^["']|["']$/g, '');
      if (cleaned && !cleaned.includes(' ')) return cleaned;

      return null;
    } catch {
      return null;
    }
  }
}
