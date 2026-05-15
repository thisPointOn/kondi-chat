/**
 * Pipeline Run Output Isolation
 * Structured per-run/per-stage/per-step output directories.
 * Runs live at {workingDir}/kondi-runs/{pipelineName}_run_NNN_date_time/
 */

import type { StepArtifact, StepMeta, RunManifest, OutputType } from './types';
import type { PlatformAdapter } from './executor';

// ============================================================================
// Name Sanitization
// ============================================================================

export function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

// ============================================================================
// Directory Name Builders
// ============================================================================

export function buildRunDirName(pipelineName: string, runNumber: number, date: Date): string {
  const safeName = sanitizeFolderName(pipelineName);
  const num = String(runNumber).padStart(3, '0');
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${safeName}_run_${num}_${y}-${m}-${d}_${h}${min}`;
}

export function buildStageDirName(stageIndex: number, stageName: string): string {
  return `stage_${stageIndex + 1}_${sanitizeFolderName(stageName)}`;
}

export function buildStepDirName(stepIndex: number, stepName: string): string {
  return `step_${stepIndex + 1}_${sanitizeFolderName(stepName)}`;
}

export function getRunsBaseDir(workingDir: string): string {
  return `${workingDir.replace(/\/$/, '')}/kondi-runs`;
}

export function buildStepOutputDir(
  runDir: string,
  stageIndex: number,
  stageName: string,
  stepIndex: number,
  stepName: string
): string {
  const stageDir = buildStageDirName(stageIndex, stageName);
  const stepDir = buildStepDirName(stepIndex, stepName);
  return `${runDir}/${stageDir}/${stepDir}`;
}

// ============================================================================
// File Extension Mapping
// ============================================================================

export function getOutputExtension(outputType: OutputType): string {
  switch (outputType) {
    case 'json': return '.json';
    default: return '.md';
  }
}

// ============================================================================
// Write Operations
// ============================================================================

export async function writeStepOutput(
  platform: PlatformAdapter,
  stepDir: string,
  artifact: StepArtifact,
  meta: StepMeta
): Promise<string> {
  const ext = getOutputExtension(meta.outputType);
  const outputPath = `${stepDir}/output${ext}`;

  await platform.writeFile(outputPath, artifact.content);
  await platform.writeFile(`${stepDir}/_meta.json`, JSON.stringify(meta, null, 2));

  return outputPath;
}

export async function writeDeliberationFiles(
  platform: PlatformAdapter,
  stepDir: string,
  deliberationMd: string,
  decisionMd?: string
): Promise<void> {
  await platform.writeFile(`${stepDir}/deliberation.md`, deliberationMd);
  if (decisionMd) {
    await platform.writeFile(`${stepDir}/decision.md`, decisionMd);
  }
}

export async function writeRunManifest(
  platform: PlatformAdapter,
  runDir: string,
  manifest: RunManifest
): Promise<void> {
  await platform.writeFile(
    `${runDir}/_manifest.json`,
    JSON.stringify(manifest, null, 2)
  );
}

// ============================================================================
// Run Pruning
// ============================================================================

export async function pruneOldRuns(
  platform: PlatformAdapter,
  runsBaseDir: string,
  pipelineName: string,
  maxRetained: number
): Promise<void> {
  if (maxRetained <= 0 || !platform.runCommand) return;

  try {
    const prefix = sanitizeFolderName(pipelineName);
    const result = await platform.runCommand(
      `ls -1d ${prefix}_run_* 2>/dev/null | sort`,
      runsBaseDir
    );

    if (!result.success || !result.stdout.trim()) return;

    const dirs = result.stdout.trim().split('\n').filter(Boolean);
    if (dirs.length <= maxRetained) return;

    const toDelete = dirs.slice(0, dirs.length - maxRetained);
    for (const dir of toDelete) {
      if (new RegExp(`^${prefix}_run_\\d{3}_`).test(dir)) {
        await platform.runCommand(`rm -rf "${dir}"`, runsBaseDir);
        console.log(`[RunOutput] Pruned old run: ${dir}`);
      }
    }
  } catch (err) {
    console.warn('[RunOutput] Failed to prune old runs:', err);
  }
}
