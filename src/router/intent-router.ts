/**
 * Intent Router — LLM-based classification for cold-start routing.
 *
 * When a new model is added with capabilities the NN hasn't seen yet,
 * this router asks a cheap LLM: "given these model descriptions,
 * which one best matches this prompt?"
 *
 * Inspired by NVIDIA's intent routing approach, but using our own
 * model registry descriptions instead of hardcoded routes.
 *
 * This is the middle tier:
 *   1. NN Router  — fast, trained (primary)
 *   2. Intent Router — LLM classifies against descriptions (cold-start)
 *   3. Rule Router — phase/task-kind lookup (fallback)
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
  /** Only use intent routing for these phases (default: execute) */
  phases?: LedgerPhase[];
}

const DEFAULT_CONFIG: IntentRouterConfig = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  phases: ['execute', 'dispatch'],
};

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
  ): Promise<{ model: ModelEntry; intent: string } | null> {
    // Only run for configured phases
    if (this.config.phases && !this.config.phases.includes(phase)) {
      return null;
    }

    const enabled = registry.getEnabled();
    if (enabled.length <= 1) return null;

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

    try {
      const response = await callLLM({
        provider: this.config.provider,
        model: this.config.model,
        systemPrompt: 'You select the best model for a task. Respond with only JSON.',
        userMessage: prompt,
        maxOutputTokens: 50,
        temperature: 0,
      });

      const parsed = this.parseResponse(response.content);
      if (!parsed) return null;

      const model = registry.getById(parsed);
      if (!model || !model.enabled) return null;

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
