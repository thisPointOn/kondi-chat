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
import type { ProviderId } from '../types.ts';

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
  /** If set, routing is restricted to models from these providers only. */
  allowedProviders?: ProviderId[];
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
      this.loadCustom();
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

  /** Load custom profiles from .kondi-chat/profiles/*.json */
  private loadCustom(): void {
    if (!this.profileDir || !existsSync(this.profileDir)) return;
    const files = readdirSync(this.profileDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.profileDir, file), 'utf-8');
        const profile = JSON.parse(raw) as BudgetProfile;
        if (profile.name) {
          this.custom[profile.name] = profile;
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  /** Reload custom profiles from disk */
  reload(): void {
    this.custom = {};
    this.loadCustom();
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
