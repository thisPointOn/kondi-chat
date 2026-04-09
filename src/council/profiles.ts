/**
 * Council Profiles — stored configurations for different council types.
 *
 * Each profile defines:
 *   - Council type (coding, analysis, debate, review)
 *   - Persona assignments (which models for manager, consultants, workers)
 *   - Cost tier (cheap vs quality — affects model selection and round count)
 *   - Max rounds, max tokens, output format
 *
 * Profiles are stored in .kondi-chat/councils/ as JSON files.
 * Presets are generated on first run; users can create custom ones.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CouncilProfile {
  /** Profile name (filename without .json) */
  name: string;
  /** Description shown in /council list */
  description: string;
  /** Council type passed to kondi-council CLI */
  councilType: 'coding' | 'analysis' | 'debate' | 'review' | 'custom';
  /** Cost tier — affects model selection */
  tier: 'cheap' | 'balanced' | 'quality';

  /** Model assignments */
  manager: { provider: string; model?: string };
  consultants: Array<{ provider: string; model?: string; stance?: string }>;
  worker?: { provider: string; model?: string };

  /** Deliberation settings */
  maxRounds: number;
  maxOutputTokens: number;

  /** Extra args passed to kondi-council CLI */
  extraArgs?: string[];
}

// ---------------------------------------------------------------------------
// Default profiles
// ---------------------------------------------------------------------------

const PRESETS: CouncilProfile[] = [
  {
    name: 'coding-cheap',
    description: 'Code generation council — cheap models, fast turnaround',
    councilType: 'coding',
    tier: 'cheap',
    manager: { provider: 'openai-api', model: 'gpt-5.4-nano' },
    consultants: [
      { provider: 'ollama', model: 'qwen2.5:3b', stance: 'advocate' },
      { provider: 'ollama', model: 'phi3.5', stance: 'critic' },
    ],
    worker: { provider: 'ollama', model: 'qwen2.5:3b' },
    maxRounds: 2,
    maxOutputTokens: 4096,
  },
  {
    name: 'coding-quality',
    description: 'Code generation council — frontier models, thorough review',
    councilType: 'coding',
    tier: 'quality',
    manager: { provider: 'anthropic-api', model: 'claude-sonnet-4-5-20250929' },
    consultants: [
      { provider: 'openai-api', model: 'gpt-5.4', stance: 'advocate' },
      { provider: 'anthropic-api', model: 'claude-sonnet-4-5-20250929', stance: 'critic' },
      { provider: 'openai-api', model: 'gpt-5.4', stance: 'wildcard' },
    ],
    worker: { provider: 'openai-api', model: 'gpt-5.4' },
    maxRounds: 3,
    maxOutputTokens: 16384,
  },
  {
    name: 'analysis',
    description: 'Code analysis — architecture review, security audit, tech debt',
    councilType: 'analysis',
    tier: 'balanced',
    manager: { provider: 'openai-api', model: 'gpt-5.4' },
    consultants: [
      { provider: 'anthropic-api', model: 'claude-sonnet-4-5-20250929', stance: 'advocate' },
      { provider: 'openai-api', model: 'gpt-5.4', stance: 'critic' },
    ],
    maxRounds: 2,
    maxOutputTokens: 8192,
  },
  {
    name: 'debate',
    description: 'Open debate — models argue positions on a topic',
    councilType: 'debate',
    tier: 'balanced',
    manager: { provider: 'openai-api', model: 'gpt-5.4' },
    consultants: [
      { provider: 'anthropic-api', model: 'claude-sonnet-4-5-20250929', stance: 'advocate' },
      { provider: 'openai-api', model: 'gpt-5.4', stance: 'critic' },
      { provider: 'ollama', model: 'nemotron-3-nano:4b', stance: 'wildcard' },
    ],
    maxRounds: 3,
    maxOutputTokens: 8192,
  },
  {
    name: 'security-review',
    description: 'Security-focused code review — finds vulnerabilities',
    councilType: 'review',
    tier: 'quality',
    manager: { provider: 'anthropic-api', model: 'claude-sonnet-4-5-20250929' },
    consultants: [
      { provider: 'openai-api', model: 'gpt-5.4', stance: 'critic' },
      { provider: 'anthropic-api', model: 'claude-sonnet-4-5-20250929', stance: 'critic' },
    ],
    maxRounds: 2,
    maxOutputTokens: 8192,
  },
];

// ---------------------------------------------------------------------------
// Profile manager
// ---------------------------------------------------------------------------

export class CouncilProfileManager {
  private profileDir: string;

  constructor(storageDir: string) {
    this.profileDir = join(storageDir, 'councils');
    mkdirSync(this.profileDir, { recursive: true });
    this.ensurePresets();
  }

  /** Get all available profiles */
  getAll(): CouncilProfile[] {
    const files = readdirSync(this.profileDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        return JSON.parse(readFileSync(join(this.profileDir, f), 'utf-8'));
      } catch {
        return null;
      }
    }).filter(Boolean) as CouncilProfile[];
  }

  /** Get a specific profile by name */
  get(name: string): CouncilProfile | undefined {
    const path = join(this.profileDir, `${name}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return undefined;
    }
  }

  /** Save a profile */
  save(profile: CouncilProfile): void {
    const path = join(this.profileDir, `${profile.name}.json`);
    writeFileSync(path, JSON.stringify(profile, null, 2));
  }

  /** Delete a profile */
  delete(name: string): boolean {
    const path = join(this.profileDir, `${name}.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  /** Format for display */
  format(): string {
    const profiles = this.getAll();
    if (profiles.length === 0) return 'No council profiles configured.';

    const lines: string[] = ['Council Profiles:'];
    for (const p of profiles) {
      const consultantNames = p.consultants.map(c => `${c.model || c.provider}(${c.stance || 'neutral'})`).join(', ');
      lines.push('');
      lines.push(`  ${p.name} [${p.tier}] — ${p.description}`);
      lines.push(`    Type: ${p.councilType} | Rounds: ${p.maxRounds} | Max tokens: ${p.maxOutputTokens.toLocaleString()}`);
      lines.push(`    Manager: ${p.manager.model || p.manager.provider}`);
      lines.push(`    Consultants: ${consultantNames}`);
      if (p.worker) lines.push(`    Worker: ${p.worker.model || p.worker.provider}`);
    }
    return lines.join('\n');
  }

  /** Build CLI args for kondi-council from a profile */
  buildArgs(profile: CouncilProfile, brief: string, workingDir: string): string[] {
    const args = [
      '--config', profile.councilType,
      '--problem', brief,
      '--dir', workingDir,
      '--max-rounds', String(profile.maxRounds),
      '--json-stdout',
    ];

    // Manager provider/model
    args.push('--manager-provider', profile.manager.provider);
    if (profile.manager.model) args.push('--manager-model', profile.manager.model);

    // Extra args
    if (profile.extraArgs) args.push(...profile.extraArgs);

    return args;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private ensurePresets(): void {
    for (const preset of PRESETS) {
      const path = join(this.profileDir, `${preset.name}.json`);
      if (!existsSync(path)) {
        writeFileSync(path, JSON.stringify(preset, null, 2));
      }
    }
  }
}
