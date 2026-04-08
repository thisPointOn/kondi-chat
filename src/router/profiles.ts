/**
 * Budget Profiles — named presets that control how the system
 * balances cost vs quality across all components.
 *
 * Profiles affect:
 *   - Which models the router prefers (capability priority order)
 *   - Context budget (how much context is assembled per call)
 *   - Loop limits (max iterations, max cost per loop)
 *   - Whether review/reflection steps are included
 *   - Promotion threshold (how many failures before escalating)
 *
 * Usage:
 *   /mode cheap        — local/cheapest models, tight loops
 *   /mode balanced     — default, good cost/quality tradeoff
 *   /mode quality      — frontier models, thorough review
 *   /mode              — show current mode
 */

// ---------------------------------------------------------------------------
// Profile definition
// ---------------------------------------------------------------------------

export type ProfileName = 'quality' | 'balanced' | 'cheap';

export interface BudgetProfile {
  name: ProfileName;
  description: string;

  /** Model selection: which capabilities to prefer, in order */
  planningPreference: string[];   // For discuss/dispatch/reflect
  executionPreference: string[];  // For execute phase
  reviewPreference: string[];     // For code review / analysis

  /** Context budget (tokens) for prompt assembly */
  contextBudget: number;

  /** Max tool-use iterations per agent turn */
  maxIterations: number;

  /** Max cost (USD) per autonomous loop before breaking */
  loopCostCap: number;

  /** Max iterations per autonomous loop */
  loopIterationCap: number;

  /** Failures before promoting to a better model */
  promotionThreshold: number;

  /** Include reflection step after task execution? */
  includeReflection: boolean;

  /** Include verification (tests/lint) after execution? */
  includeVerification: boolean;

  /** Prefer local models when available? */
  preferLocal: boolean;

  /** Max output tokens per LLM call */
  maxOutputTokens: number;
}

// ---------------------------------------------------------------------------
// Preset profiles
// ---------------------------------------------------------------------------

const PROFILES: Record<ProfileName, BudgetProfile> = {
  quality: {
    name: 'quality',
    description: 'Frontier models, thorough review, generous context',
    planningPreference: ['planning', 'reasoning', 'architecture'],
    executionPreference: ['coding', 'reasoning'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 60_000,
    maxIterations: 20,
    loopCostCap: 5.00,
    loopIterationCap: 10,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 16_384,
  },

  balanced: {
    name: 'balanced',
    description: 'Good cost/quality balance — default mode',
    planningPreference: ['planning', 'reasoning'],
    executionPreference: ['coding', 'fast-coding'],
    reviewPreference: ['code-review', 'analysis'],
    contextBudget: 30_000,
    maxIterations: 15,
    loopCostCap: 2.00,
    loopIterationCap: 6,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 8_192,
  },

  cheap: {
    name: 'cheap',
    description: 'Cheapest models, tight limits, local when possible',
    planningPreference: ['fast-coding', 'general'],
    executionPreference: ['fast-coding', 'coding'],
    reviewPreference: [],  // Skip review
    contextBudget: 15_000,
    maxIterations: 10,
    loopCostCap: 0.50,
    loopIterationCap: 3,
    promotionThreshold: 3,  // More attempts before promoting
    includeReflection: false,
    includeVerification: true,
    preferLocal: true,
    maxOutputTokens: 4_096,
  },
};

// ---------------------------------------------------------------------------
// Profile manager
// ---------------------------------------------------------------------------

export class ProfileManager {
  private active: BudgetProfile;

  constructor(initial: ProfileName = 'balanced') {
    this.active = { ...PROFILES[initial] };
  }

  getActive(): BudgetProfile {
    return this.active;
  }

  setProfile(name: ProfileName): void {
    if (!PROFILES[name]) {
      throw new Error(`Unknown profile: ${name}. Use: quality, balanced, cheap`);
    }
    this.active = { ...PROFILES[name] };
  }

  /** Get a specific profile without activating it */
  getProfile(name: ProfileName): BudgetProfile {
    return { ...PROFILES[name] };
  }

  /** Get all profile names */
  getNames(): ProfileName[] {
    return Object.keys(PROFILES) as ProfileName[];
  }

  /** Format for display */
  format(): string {
    const lines: string[] = [];
    for (const [name, profile] of Object.entries(PROFILES)) {
      const marker = name === this.active.name ? ' (active)' : '';
      lines.push(`${name}${marker}: ${profile.description}`);
      lines.push(`  Context: ${profile.contextBudget.toLocaleString()} tokens | Max output: ${profile.maxOutputTokens.toLocaleString()}`);
      lines.push(`  Loop: ${profile.loopIterationCap} iterations, $${profile.loopCostCap.toFixed(2)} cap`);
      lines.push(`  Promotion after ${profile.promotionThreshold} failures | Review: ${profile.includeReflection ? 'yes' : 'skip'} | Local: ${profile.preferLocal ? 'prefer' : 'no preference'}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}
