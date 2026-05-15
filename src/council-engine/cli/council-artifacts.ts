/**
 * CLI Council Artifact Writer
 *
 * Writes council deliberation artifacts to disk using node:fs.
 * Supports 5 output formats: full, abbreviated, output-only, json, none.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Council } from '../council/types';
import { buildFullDeliberation, buildAbbreviatedSummary } from '../services/deliberationSummary';
import { getDecision, getLatestOutput } from '../council/context-store';
import { getAllEntries } from '../council/ledger-store';
import type { OutputFormat } from './council-config';

// ============================================================================
// Helpers (mirrored from deliberationSaveService.ts, Tauri-free)
// ============================================================================

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function resolveOutputDir(workingDir: string, councilName: string, overrideDir?: string): string {
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  const safeName = sanitizeName(councilName);
  const ts = timestampSlug();
  const base = workingDir.replace(/\/$/, '');
  return `${base}/.kondi/outputs/${safeName}_${ts}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ============================================================================
// Format Writers
// ============================================================================

function writeFull(council: Council, outputDir: string): string[] {
  const files: string[] = [];

  // deliberation.md
  const deliberationMd = buildFullDeliberation(council);
  const deliberationPath = path.join(outputDir, 'deliberation.md');
  writeFile(deliberationPath, deliberationMd);
  files.push(deliberationPath);

  // decision.md
  const decision = getDecision(council.id);
  let decisionMd = `# Decision\n\n`;
  if (decision) {
    decisionMd += decision.content;
    if (decision.acceptanceCriteria) {
      decisionMd += `\n\n## Acceptance Criteria\n\n${decision.acceptanceCriteria}`;
    }
  } else {
    decisionMd += 'No decision recorded.';
  }
  const decisionPath = path.join(outputDir, 'decision.md');
  writeFile(decisionPath, decisionMd);
  files.push(decisionPath);

  // output.md
  const output = getLatestOutput(council.id);
  let outputMd = `# Output\n\n`;
  if (output) {
    outputMd += output.content;
  } else {
    outputMd += 'No output recorded.';
  }
  const outputPath = path.join(outputDir, 'output.md');
  writeFile(outputPath, outputMd);
  files.push(outputPath);

  return files;
}

function writeAbbreviated(council: Council, outputDir: string): string[] {
  const summaryMd = buildAbbreviatedSummary(council);
  const summaryPath = path.join(outputDir, 'summary.md');
  writeFile(summaryPath, summaryMd);
  return [summaryPath];
}

function writeOutputOnly(council: Council, outputDir: string): string[] {
  const output = getLatestOutput(council.id);
  let outputMd = `# Output\n\n`;
  if (output) {
    outputMd += output.content;
  } else {
    outputMd += 'No output recorded.';
  }
  const outputPath = path.join(outputDir, 'output.md');
  writeFile(outputPath, outputMd);
  return [outputPath];
}

function writeJson(council: Council, outputDir: string): string[] {
  const entries = getAllEntries(council.id);
  const decision = getDecision(council.id);
  const output = getLatestOutput(council.id);

  const result = {
    council: {
      id: council.id,
      name: council.name,
      topic: council.topic,
      createdAt: council.createdAt,
      status: council.status,
      totalTokensUsed: council.totalTokensUsed,
      personas: council.personas.map(p => ({
        id: p.id,
        name: p.name,
        provider: p.provider,
        model: p.model,
        role: p.preferredDeliberationRole,
      })),
    },
    deliberation: {
      rounds: council.deliberationState?.currentRound ?? 0,
      revisions: council.deliberationState?.revisionCount ?? 0,
      phase: council.deliberationState?.currentPhase,
      entryCount: entries.length,
    },
    entries: entries.map(e => ({
      timestamp: e.timestamp,
      author: e.authorPersonaId,
      entryType: e.entryType,
      round: e.roundNumber,
      content: e.content,
      tokensUsed: e.tokensUsed,
      latencyMs: e.latencyMs,
    })),
    decision: decision ? {
      content: decision.content,
      acceptanceCriteria: decision.acceptanceCriteria,
    } : null,
    output: output ? {
      content: output.content,
      version: output.version,
    } : null,
  };

  const jsonPath = path.join(outputDir, 'council-result.json');
  writeFile(jsonPath, JSON.stringify(result, null, 2));
  return [jsonPath];
}

// ============================================================================
// Public API
// ============================================================================

export interface WriteArtifactsOpts {
  format: OutputFormat;
  outputDir?: string;
  workingDir: string;
}

/**
 * Write council artifacts to disk.
 * Returns array of written file paths (empty for 'none' format).
 */
export function writeCouncilArtifacts(council: Council, opts: WriteArtifactsOpts): string[] {
  if (opts.format === 'none') return [];

  const outputDir = resolveOutputDir(opts.workingDir, council.name, opts.outputDir);

  switch (opts.format) {
    case 'full':
      return writeFull(council, outputDir);
    case 'abbreviated':
      return writeAbbreviated(council, outputDir);
    case 'output-only':
      return writeOutputOnly(council, outputDir);
    case 'json':
      return writeJson(council, outputDir);
    default:
      return writeFull(council, outputDir);
  }
}

/**
 * Build structured JSON result for --json-stdout output.
 */
export function buildJsonResult(council: Council, artifactPaths: string[], executionInfo: {
  status: 'completed' | 'failed';
  durationMs: number;
  error?: string;
}): object {
  const entries = getAllEntries(council.id);
  const decision = getDecision(council.id);
  const output = getLatestOutput(council.id);

  return {
    status: executionInfo.status,
    durationMs: executionInfo.durationMs,
    error: executionInfo.error,
    council: {
      id: council.id,
      name: council.name,
      topic: council.topic,
      totalTokensUsed: council.totalTokensUsed,
      rounds: council.deliberationState?.currentRound ?? 0,
      revisions: council.deliberationState?.revisionCount ?? 0,
      entryCount: entries.length,
    },
    decision: decision?.content ?? null,
    output: output?.content ?? null,
    artifacts: artifactPaths,
  };
}
