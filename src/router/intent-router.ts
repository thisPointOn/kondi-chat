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
  /**
   * If set, only consider these specific model IDs. Derived from the
   * profile's rolePinning values so the classifier sees exactly the
   * models the profile uses, not every model from the allowed providers.
   * Takes precedence over allowedProviders when both are set.
   */
  allowedModelIds?: string[];
  /** Override the classifier LLM for this call (e.g. zai's glm-4.5-flash). */
  classifier?: { provider: ProviderId; model: string };
  /** Rich context about what happened in prior pipeline phases. */
  phaseContext?: import('../router/index.ts').PhaseContext;
  /** The profile's preferred model for this phase (soft hint, not hard pin). */
  phasePreference?: string;
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

    // Candidate scope: specific model IDs (from rolePinning) > provider
    // filter > all enabled. When the profile declares rolePinning, the
    // classifier sees exactly those 4–5 models, not every model from 3
    // providers. Much less noise, much better picks.
    let enabled = registry.getEnabled();
    if (opts?.allowedModelIds && opts.allowedModelIds.length > 0) {
      const allow = new Set(opts.allowedModelIds);
      enabled = enabled.filter(m => allow.has(m.id));
    } else if (opts?.allowedProviders && opts.allowedProviders.length > 0) {
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

    // Build phase-context block so the classifier knows what happened
    // in prior pipeline steps, not just the original user prompt.
    let contextBlock = '';
    if (opts?.phaseContext?.priorPhases && opts.phaseContext.priorPhases.length > 0) {
      const lines = opts.phaseContext.priorPhases.map(p =>
        `  - ${p.phase}: handled by ${p.model}${p.succeeded === false ? ' (FAILED)' : ''}${p.summary ? ` — ${p.summary}` : ''}`
      );
      contextBlock = `\n<prior_phases>\n${lines.join('\n')}\n</prior_phases>\n`;
    }

    let preferenceHint = '';
    if (opts?.phasePreference) {
      preferenceHint = `\nThe user's profile suggests "${opts.phasePreference}" for the ${phase} phase. Honor this preference unless another model is clearly better suited given the context above.\n`;
    }

    const phaseDescriptions: Record<string, string> = {
      discuss: 'Conversational Q&A, explanations, open-ended discussion. Needs good general reasoning at reasonable cost.',
      dispatch: 'Planning and task decomposition. Needs strong architectural reasoning — this call sets the direction for everything that follows. Worth paying more for quality here.',
      execute: 'Code generation, file editing, tool calls. High-volume phase (3-10 calls per turn). Cost matters. Speed matters. Code quality needs to be good but planning was already done.',
      reflect: 'Reviewing and critiquing code that was just written. Needs to catch bugs without hallucinating new ones. Should NOT be the same model that wrote the code if possible.',
      compress: 'Summarizing old context to save tokens. Grunt work. Use the cheapest model available.',
      state_update: 'Updating session state. Grunt work. Use the cheapest model available.',
      verify: 'Local verification (no LLM needed).',
      consult: 'Domain-expert consultation. Use whatever model the consultant specifies.',
    };

    const phaseDesc = phaseDescriptions[phase] || `Phase: ${phase}`;

    const prompt = `You are a router that selects the best model for the current step of a multi-phase coding pipeline.

<routes>
${routesXml}
</routes>

<current_step>
Phase: ${phase}
Phase meaning: ${phaseDesc}
${taskKind ? `Task kind: ${taskKind}` : ''}
Original goal: ${(opts?.phaseContext?.currentGoal || promptText).slice(0, 800)}
</current_step>
${contextBlock}${preferenceHint}
Given the available models, the current phase, and what happened in prior phases, which model should handle this step? Consider: capabilities, cost, and whether the model that wrote the code should be different from the one that reviews it.
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
