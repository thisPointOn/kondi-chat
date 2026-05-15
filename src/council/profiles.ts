/**
 * Council Profiles — configurations for the `/council` command.
 *
 * A council profile is a kondi-council engine config file: a set of
 * personas (manager / consultants / worker) plus orchestration settings.
 * The deliberation engine itself is bundled at `src/council-engine/`.
 *
 * Presets are seeded on first run by copying the engine's curated
 * configs (`src/council-engine/configs/councils/*.json`) into
 * `.kondi-chat/councils/`. Users can edit those or add their own JSON
 * files there; the filename (without `.json`) is the profile id passed
 * to `/council run <id>`.
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types — mirror the engine's CouncilConfigFile
// (see src/council-engine/cli/council-config.ts). Kept as a local copy
// because the engine subtree is excluded from kondi-chat's typecheck.
// ---------------------------------------------------------------------------

export interface CouncilPersona {
  name: string;
  role: 'manager' | 'worker' | 'consultant' | 'reviewer';
  provider?: string;
  model?: string;
  avatar?: string;
  systemPrompt?: string;
  traits?: string[];
  stance?: 'advocate' | 'critic' | 'neutral' | 'wildcard';
  domain?: string;
  temperature?: number;
  suppressPersona?: boolean;
  toolAccess?: 'full' | 'none';
}

export interface CouncilProfile {
  /** Human-readable council title. */
  name: string;
  /** Council type — council, coding, analysis, review, agent, code_planning. */
  type?: string;
  personas: CouncilPersona[];
  orchestration?: {
    maxRounds?: number;
    maxRevisions?: number;
    contextTokenBudget?: number;
    summarizeAfterRound?: number;
    consultantExecution?: 'sequential' | 'parallel';
    evolveContext?: boolean;
    bootstrapContext?: boolean;
  };
  output?: { format?: string; directory?: string; sessionExport?: boolean };
  expectedOutput?: string;
  decisionCriteria?: string[];
  testCommand?: string;
  maxDebugCycles?: number;
  maxReviewCycles?: number;
}

/** Bundled engine presets — copied into .kondi-chat/councils/ on first run. */
const ENGINE_PRESETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'council-engine', 'configs', 'councils',
);

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

  /** Profile ids — the JSON filenames (without extension) in the dir. */
  ids(): string[] {
    return readdirSync(this.profileDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
      .sort();
  }

  /** Load a profile by id. Returns undefined for unknown / invalid files. */
  get(id: string): CouncilProfile | undefined {
    const path = this.getPath(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as CouncilProfile;
    } catch {
      return undefined;
    }
  }

  /** Absolute path to a profile's config file (passed to the engine). */
  getPath(id: string): string {
    return join(this.profileDir, `${id}.json`);
  }

  /** Human-readable roster for `/council list`. */
  format(): string {
    const ids = this.ids();
    if (ids.length === 0) return 'No council profiles configured.';
    const lines: string[] = ['Council profiles — run with /council run <id> "<brief>":'];
    for (const id of ids) {
      const p = this.get(id);
      if (!p) continue;
      const rounds = p.orchestration?.maxRounds ?? '?';
      const roster = p.personas.map(x => `${x.name}(${x.role})`).join(', ');
      lines.push('');
      lines.push(`  ${id} — ${p.name}`);
      lines.push(`    Type: ${p.type || 'council'} | Rounds: ${rounds} | ${p.personas.length} personas`);
      lines.push(`    ${roster}`);
    }
    return lines.join('\n');
  }

  /**
   * Seed presets from the bundled engine configs. Only copies files that
   * don't already exist, so user edits to a preset are never clobbered.
   */
  private ensurePresets(): void {
    if (!existsSync(ENGINE_PRESETS_DIR)) return;
    for (const file of readdirSync(ENGINE_PRESETS_DIR).filter(f => f.endsWith('.json'))) {
      const dest = join(this.profileDir, file);
      if (!existsSync(dest)) {
        copyFileSync(join(ENGINE_PRESETS_DIR, file), dest);
      }
    }
  }
}
