/**
 * Budget Profiles — control how the system balances cost vs quality.
 *
 * Three built-in profiles: quality, balanced, cheap.
 * Custom profiles: add JSON files to .kondi-chat/profiles/
 *
 * Example custom profile (.kondi-chat/profiles/aerospace-review.json):
 * {
 *   "name": "aerospace-review",
 *   "description": "Aerospace engineering analysis with frontier models",
 *   "planningPreference": ["reasoning", "aerospace", "architecture"],
 *   "executionPreference": ["aerospace", "coding"],
 *   "reviewPreference": ["analysis", "reasoning"],
 *   "contextBudget": 50000,
 *   "maxIterations": 15,
 *   "loopCostCap": 5.00,
 *   "loopIterationCap": 8,
 *   "promotionThreshold": 2,
 *   "includeReflection": true,
 *   "includeVerification": true,
 *   "preferLocal": false,
 *   "maxOutputTokens": 16384
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileName = string;

export interface BudgetProfile {
  name: string;
  description: string;
  planningPreference: string[];
  executionPreference: string[];
  reviewPreference: string[];
  contextBudget: number;
  maxIterations: number;
  loopCostCap: number;
  loopIterationCap: number;
  promotionThreshold: number;
  includeReflection: boolean;
  includeVerification: boolean;
  preferLocal: boolean;
  maxOutputTokens: number;
  /**
   * Hard-pin specific ledger phases to specific model IDs. When the router
   * is asked to select for a pinned phase, it returns that exact model and
   * skips the NN/intent/rules tiers. Unpinned phases route normally.
   *
   * Useful for profiles that want a deterministic multi-role pipeline
   * (e.g. plan with gpt-5.4, code with gemini-2.5-pro, review with glm-5.1)
   * without relying on capability tags resolving unambiguously across
   * providers.
   *
   * Keys are `LedgerPhase` strings — typically 'dispatch', 'discuss',
   * 'execute', 'reflect', 'compress'. The model ID must be in the active
   * registry (enabled or not) or routing will fall through.
   */
  rolePinning?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

const BUILTIN_PROFILES: Record<string, BudgetProfile> = {
  quality: {
    name: 'quality',
    description: 'Frontier models, thorough review, generous context',
    planningPreference: ['general', 'planning', 'reasoning', 'architecture'],
    executionPreference: ['coding', 'reasoning'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 60_000,
    maxIterations: 30,
    loopCostCap: 10.00,
    loopIterationCap: 30,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 16_384,
  },
  balanced: {
    name: 'balanced',
    description: 'Good cost/quality balance — default mode',
    planningPreference: ['general', 'planning', 'reasoning'],
    executionPreference: ['coding', 'fast-coding'],
    reviewPreference: ['code-review', 'analysis'],
    contextBudget: 30_000,
    maxIterations: 20,
    loopCostCap: 3.00,
    loopIterationCap: 20,
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
    reviewPreference: [],
    contextBudget: 15_000,
    maxIterations: 12,
    loopCostCap: 0.75,
    loopIterationCap: 8,
    promotionThreshold: 3,
    includeReflection: false,
    includeVerification: true,
    preferLocal: true,
    maxOutputTokens: 4_096,
  },
};

// ---------------------------------------------------------------------------
// Profile Manager
// ---------------------------------------------------------------------------

export class ProfileManager {
  private active: BudgetProfile;
  private custom: Record<string, BudgetProfile> = {};
  private profileDir: string;

  constructor(initial: ProfileName = 'balanced', storageDir?: string) {
    this.profileDir = storageDir ? join(storageDir, 'profiles') : '';
    if (this.profileDir) {
      mkdirSync(this.profileDir, { recursive: true });
      this.ensureBuiltins();
      // Load user-level profiles first (~/.kondi-chat/profiles/), then
      // project-level profiles (which override user-level on name collision).
      // This way custom profiles like glm/best-value/orchestra are available
      // in every project, not just the one they were created in.
      const userProfileDir = join(homedir(), '.kondi-chat', 'profiles');
      this.loadFromDir(userProfileDir);
      this.loadFromDir(this.profileDir);
    }
    this.active = { ...(this.getAll()[initial] || BUILTIN_PROFILES.balanced) };
  }

  /**
   * Write built-in profiles to disk so they're visible and editable.
   * Always overwrites — built-in files are owned by the code, not the user.
   * Users who want to customize should copy to a new file under a different
   * name (those are loaded as custom profiles and never overwritten).
   */
  private ensureBuiltins(): void {
    for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
      const path = join(this.profileDir, `${name}.json`);
      writeFileSync(path, JSON.stringify(profile, null, 2));
    }
  }

  getActive(): BudgetProfile {
    return this.active;
  }

  setProfile(name: ProfileName): void {
    const all = this.getAll();
    if (!all[name]) {
      const available = Object.keys(all).join(', ');
      throw new Error(`Unknown profile: ${name}. Available: ${available}`);
    }
    this.active = { ...all[name] };
  }

  getProfile(name: ProfileName): BudgetProfile {
    const all = this.getAll();
    return { ...(all[name] || BUILTIN_PROFILES.balanced) };
  }

  getNames(): string[] {
    return Object.keys(this.getAll());
  }

  /** Get all profiles — disk versions override built-in defaults */
  getAll(): Record<string, BudgetProfile> {
    // Custom (from disk) takes priority — this includes edited built-ins
    return { ...BUILTIN_PROFILES, ...this.custom };
  }

  /** Load profiles from a directory into this.custom */
  private loadFromDir(dir: string): void {
    if (!dir || !existsSync(dir)) return;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const profile = JSON.parse(raw) as BudgetProfile;
        if (profile.name) {
          this.custom[profile.name] = profile;
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  /** Reload profiles from disk (user-level + project-level) */
  reload(): void {
    this.custom = {};
    const userProfileDir = join(homedir(), '.kondi-chat', 'profiles');
    this.loadFromDir(userProfileDir);
    this.loadFromDir(this.profileDir);
  }

  format(): string {
    const all = this.getAll();
    const lines: string[] = [];
    for (const [name, profile] of Object.entries(all)) {
      const marker = name === this.active.name ? ' (active)' : '';
      const isCustom = this.custom[name] ? ' [custom]' : '';
      lines.push(`${name}${marker}${isCustom}: ${profile.description}`);
      lines.push(`  Context: ${profile.contextBudget.toLocaleString()} | Loop: ${profile.loopIterationCap} iters, $${profile.loopCostCap.toFixed(2)} cap | Local: ${profile.preferLocal ? 'yes' : 'no'}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}
