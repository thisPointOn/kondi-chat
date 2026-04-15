/**
 * Rule-Based Router — the "teacher" that makes routing decisions.
 *
 * Maps (phase, task_kind) to the best model from the registry.
 * This is the initial routing strategy. Every decision it makes
 * gets logged by the collector, which eventually trains an NN
 * to replace it.
 *
 * Strategy:
 *   - discuss/dispatch/reflect → best reasoning model
 *   - execute → cheapest coding model (promote on failure)
 *   - compress/state_update → cheapest summarization model
 *   - verify → no LLM call (local tools)
 */

import type { LedgerPhase, ProviderId, TaskKind } from '../types.ts';
import { ModelRegistry, type ModelCapability, type ModelEntry } from './registry.ts';
import type { BudgetProfile } from './profiles.ts';

/**
 * Minimal subset of ModelRegistry used by the routing strategy helpers.
 * A scoped view (see scopedRegistry) implements this without inheriting.
 */
interface RegistryView {
  getEnabled(): ModelEntry[];
  getByCapability(capability: ModelCapability): ModelEntry[];
  getCheapest(capability: ModelCapability): ModelEntry | undefined;
  getBest(capability: ModelCapability): ModelEntry | undefined;
}

function scopedRegistry(registry: ModelRegistry, providers: ProviderId[]): RegistryView {
  const allowed = new Set(providers);
  const filter = (m: ModelEntry) => allowed.has(m.provider);
  return {
    getEnabled: () => registry.getEnabled().filter(filter),
    getByCapability: (cap) => registry.getByCapability(cap).filter(filter),
    getCheapest: (cap) => registry.getByCapability(cap).filter(filter)[0],
    getBest: (cap) => {
      const list = registry.getByCapability(cap).filter(filter);
      return list[list.length - 1];
    },
  };
}

// ---------------------------------------------------------------------------
// Route decision
// ---------------------------------------------------------------------------

export interface RouteDecision {
  model: ModelEntry;
  reason: string;
  /** Was this a promotion (retry after failure)? */
  promoted: boolean;
}

// ---------------------------------------------------------------------------
// Rule-based router
// ---------------------------------------------------------------------------

export class RuleRouter {
  private registry: ModelRegistry;
  private profile?: BudgetProfile;
  private override?: ModelEntry;

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  /** Set the active budget profile — changes model selection priorities */
  setProfile(profile: BudgetProfile): void {
    this.profile = profile;
  }

  /** Registry view scoped to the active profile's provider allow-list, if any. */
  private reg(): RegistryView {
    const allowed = this.profile?.allowedProviders;
    return allowed && allowed.length > 0
      ? scopedRegistry(this.registry, allowed)
      : this.registry;
  }

  /** Force all routing to a specific model. Pass undefined to clear. */
  setOverride(model: ModelEntry | undefined): void {
    this.override = model;
  }

  /** Get the current override, if any */
  getOverride(): ModelEntry | undefined {
    return this.override;
  }

  /**
   * Select the best model for a given phase and optional task context.
   *
   * @param phase      Pipeline phase (discuss, dispatch, execute, etc.)
   * @param taskKind   Type of task being executed (if in a task context)
   * @param failures   Number of prior failures for this task (triggers promotion)
   * @param promotionThreshold  Failures before promoting to best model
   */
  select(
    phase: LedgerPhase,
    taskKind?: TaskKind,
    failures = 0,
    promotionThreshold = 2,
  ): RouteDecision {
    // Manual override — user forced a specific model with /use
    if (this.override) {
      return { model: this.override, reason: `override: ${this.override.alias || this.override.id}`, promoted: false };
    }

    const promoted = failures >= promotionThreshold;

    // Promotion overrides: if the cheap model failed enough, use the best
    if (promoted && (phase === 'execute')) {
      const best = this.reg().getBest('coding');
      if (best) {
        return { model: best, reason: `promoted after ${failures} failures`, promoted: true };
      }
    }

    // Phase-based routing
    switch (phase) {
      case 'discuss':
      case 'dispatch':
      case 'reflect':
        return this.selectForReasoning();

      case 'execute':
        return this.selectForExecution(taskKind);

      case 'compress':
      case 'state_update':
        return this.selectForCheap();

      default:
        return this.selectForReasoning();
    }
  }

  // -------------------------------------------------------------------------
  // Strategy helpers
  // -------------------------------------------------------------------------

  private selectForReasoning(): RouteDecision {
    // Use profile preferences if available
    if (this.profile) {
      const prefs = this.profile.planningPreference;
      const selector = this.profile.preferLocal
        ? (cap: string) => this.reg().getCheapest(cap)
        : (cap: string) => this.reg().getBest(cap);
      for (const cap of prefs) {
        const model = selector(cap);
        if (model) return { model, reason: `${this.profile.name}: ${cap}`, promoted: false };
      }
    }

    // Default: best planning model
    const model = this.reg().getBest('planning')
      || this.reg().getBest('reasoning')
      || this.reg().getBest('coding')
      || this.fallback();
    return { model, reason: 'reasoning phase — best planner', promoted: false };
  }

  private selectForExecution(taskKind?: TaskKind): RouteDecision {
    // Use profile preferences if available
    if (this.profile) {
      // Try direct task kind match first
      if (taskKind) {
        const directMatch = this.profile.preferLocal
          ? this.reg().getCheapest(taskKind)
          : this.reg().getByCapability(taskKind)[0];
        if (directMatch) {
          return { model: directMatch, reason: `${this.profile.name}: ${taskKind} match`, promoted: false };
        }
      }

      // Then profile's execution preferences
      const prefs = this.profile.executionPreference;
      for (const cap of prefs) {
        const model = this.reg().getCheapest(cap);
        if (model) return { model, reason: `${this.profile.name}: ${cap}`, promoted: false };
      }
    }

    // Default: try to match task kind directly to a capability
    if (taskKind) {
      const directMatch = this.reg().getCheapest(taskKind);
      if (directMatch) {
        return { model: directMatch, reason: `${taskKind} task — direct capability match`, promoted: false };
      }
    }

    // Known task kind → capability mapping
    switch (taskKind) {
      case 'analysis':
      case 'code-review':
        const reviewer = this.reg().getBest('code-review')
          || this.reg().getBest('analysis')
          || this.reg().getBest('reasoning')
          || this.fallback();
        return { model: reviewer, reason: `${taskKind} task — best reviewer`, promoted: false };

      case 'marketing':
      case 'writing':
        const writer = this.reg().getCheapest('marketing')
          || this.reg().getCheapest('writing')
          || this.reg().getCheapest('general')
          || this.fallback();
        return { model: writer, reason: `${taskKind} task — best writer`, promoted: false };

      case 'test':
      case 'fix':
        const fixer = this.reg().getCheapest('fast-coding')
          || this.reg().getCheapest('coding')
          || this.fallback();
        return { model: fixer, reason: `${taskKind} task — cheapest coder`, promoted: false };

      case 'implementation':
      case 'refactor':
      case 'refactoring':
        const coder = this.reg().getCheapest('coding')
          || this.fallback();
        return { model: coder, reason: `${taskKind} task — cheapest coder`, promoted: false };

      default:
        // Unknown kind — use cheapest coding model as default for execution
        const defaultModel = this.reg().getCheapest('coding')
          || this.reg().getCheapest('general')
          || this.fallback();
        return { model: defaultModel, reason: `${taskKind || 'unknown'} task — default`, promoted: false };
    }
  }

  private selectForCheap(): RouteDecision {
    const model = this.reg().getCheapest('summarization')
      || this.reg().getCheapest('general')
      || this.fallback();
    return { model, reason: 'cheap phase — summarization', promoted: false };
  }

  private fallback(): ModelEntry {
    const enabled = this.reg().getEnabled();
    if (enabled.length === 0) {
      throw new Error('No models enabled in registry. Run /models to configure.');
    }
    return enabled[0];
  }
}
