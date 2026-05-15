/**
 * CLI Council Config Loader
 *
 * Loads council configuration from JSON files with auto-discovery.
 * Search order: explicit --config path, cwd/council.json, ~/.config/kondi/council.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CouncilStepType } from '../pipeline/types';

// ============================================================================
// Config Schema
// ============================================================================

export type OutputFormat = 'full' | 'abbreviated' | 'output-only' | 'json' | 'none';

export interface CouncilPersonaConfig {
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

export interface CouncilConfigFile {
  name: string;
  task?: string;
  type?: CouncilStepType;
  personas: CouncilPersonaConfig[];
  orchestration?: {
    maxRounds?: number;
    maxRevisions?: number;
    contextTokenBudget?: number;
    summarizeAfterRound?: number;
    summaryMode?: string;
    consultantExecution?: 'sequential' | 'parallel';
    evolveContext?: boolean;
    bootstrapContext?: boolean;
  };
  output?: {
    format?: OutputFormat;
    directory?: string;
    sessionExport?: boolean;
  };
  expectedOutput?: string;
  decisionCriteria?: string[];
  testCommand?: string;
  maxDebugCycles?: number;
  maxReviewCycles?: number;
}

// ============================================================================
// CLI Args (parsed externally, merged here)
// ============================================================================

export interface CouncilCliArgs {
  configPath?: string;
  councilJsonPath?: string;
  task?: string;
  type?: CouncilStepType;
  workingDir?: string;
  model?: string;
  provider?: string;
  outputFormat?: OutputFormat;
  outputDir?: string;
  noSessionExport?: boolean;
  noCache?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  jsonStdout?: boolean;
}

// ============================================================================
// Loader
// ============================================================================

const SEARCH_PATHS = [
  () => path.join(process.cwd(), 'council.json'),
  () => path.join(os.homedir(), '.config', 'kondi', 'council.json'),
];

export function loadCouncilConfig(configPath?: string): CouncilConfigFile | null {
  // Explicit path
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return parseAndValidate(resolved);
  }

  // Auto-discovery
  for (const getPath of SEARCH_PATHS) {
    const p = getPath();
    if (fs.existsSync(p)) {
      return parseAndValidate(p);
    }
  }

  return null;
}

function parseAndValidate(filePath: string): CouncilConfigFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${filePath}`);
  }

  // Validate required fields
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Config file missing required "name" field: ${filePath}`);
  }
  if (!Array.isArray(parsed.personas) || parsed.personas.length === 0) {
    throw new Error(`Config file must have at least one persona: ${filePath}`);
  }
  for (const p of parsed.personas) {
    if (!p.name || !p.role) {
      throw new Error(`Each persona must have "name" and "role": ${filePath}`);
    }
    const validRoles = ['manager', 'worker', 'consultant', 'reviewer'];
    if (!validRoles.includes(p.role)) {
      throw new Error(`Invalid persona role "${p.role}" for "${p.name}". Must be: ${validRoles.join(', ')}`);
    }
  }

  return parsed as CouncilConfigFile;
}

// ============================================================================
// Merge config with CLI args (CLI wins)
// ============================================================================

export interface ResolvedCouncilConfig {
  config: CouncilConfigFile;
  task: string;
  type: CouncilStepType;
  workingDir?: string;
  model?: string;
  provider?: string;
  outputFormat: OutputFormat;
  outputDir?: string;
  sessionExport: boolean;
  dryRun: boolean;
  quiet: boolean;
  jsonStdout: boolean;
}

export function mergeConfigWithArgs(
  config: CouncilConfigFile,
  args: CouncilCliArgs,
): ResolvedCouncilConfig {
  return {
    config,
    task: args.task || config.task || config.name,
    type: args.type || config.type || 'council',
    workingDir: args.workingDir,
    model: args.model,
    provider: args.provider,
    outputFormat: args.outputFormat || config.output?.format || 'full',
    outputDir: args.outputDir || config.output?.directory,
    sessionExport: args.noSessionExport ? false : (config.output?.sessionExport ?? true),
    dryRun: args.dryRun || false,
    quiet: args.quiet || false,
    jsonStdout: args.jsonStdout || false,
  };
}
