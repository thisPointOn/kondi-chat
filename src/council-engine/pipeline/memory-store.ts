/**
 * Pipeline Memory Store
 * Reads/writes JSONL memory files and patterns from disk via PlatformAdapter.
 * Memory lives at {workingDir}/.kondi/memory/{pipelineId}.jsonl
 */

import type { MemoryEntry } from './types';
import type { PlatformAdapter } from './executor';

// ============================================================================
// Path Helpers
// ============================================================================

export function getMemoryDir(workingDir: string): string {
  return `${workingDir.replace(/\/$/, '')}/.kondi/memory`;
}

export function getMemoryFilePath(workingDir: string, pipelineId: string): string {
  return `${getMemoryDir(workingDir)}/${pipelineId}.jsonl`;
}

export function getPatternsFilePath(workingDir: string, pipelineId: string): string {
  return `${getMemoryDir(workingDir)}/${pipelineId}_patterns.json`;
}

// ============================================================================
// Read Operations
// ============================================================================

export async function readAllEntries(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string
): Promise<MemoryEntry[]> {
  if (!platform.readFile) return [];
  const filePath = getMemoryFilePath(workingDir, pipelineId);
  try {
    const content = await platform.readFile(filePath);
    if (!content) return [];
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as MemoryEntry);
  } catch {
    return [];
  }
}

export async function readLastEntries(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string,
  n: number
): Promise<MemoryEntry[]> {
  const all = await readAllEntries(platform, workingDir, pipelineId);
  return all.slice(-n);
}

export async function readPatterns(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string
): Promise<string> {
  if (!platform.readFile) return '';
  const filePath = getPatternsFilePath(workingDir, pipelineId);
  try {
    const content = await platform.readFile(filePath);
    if (!content) return '';
    const data = JSON.parse(content);
    if (!Array.isArray(data.patterns)) return '';
    return data.patterns.map((p: string) => `- ${p}`).join('\n');
  } catch {
    return '';
  }
}

// ============================================================================
// Write Operations
// ============================================================================

export async function appendEntry(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string,
  entry: MemoryEntry
): Promise<void> {
  const filePath = getMemoryFilePath(workingDir, pipelineId);
  const line = JSON.stringify(entry);

  let existing = '';
  if (platform.readFile) {
    try {
      existing = (await platform.readFile(filePath)) || '';
    } catch {
      // File doesn't exist yet
    }
  }

  const newContent = existing
    ? (existing.endsWith('\n') ? existing : existing + '\n') + line + '\n'
    : line + '\n';

  await platform.writeFile(filePath, newContent);
}

// ============================================================================
// Formatting for Templates
// ============================================================================

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().split('T')[0];
  } catch {
    return iso;
  }
}

export function formatEntriesForTemplate(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((entry) => {
    const header = `--- Run #${entry.runNumber} (${formatDate(entry.runDate)})${entry.compressed ? ' [compressed]' : ''} ---`;
    const captures = Object.entries(entry.captures)
      .map(([stepName, content]) => `[${stepName}]:\n${content}`)
      .join('\n\n');
    return `${header}\n${captures}`;
  }).join('\n\n');
}

export function formatEntryCapture(entry: MemoryEntry, stepName: string): string {
  // Try exact match first, then case-insensitive
  if (entry.captures[stepName]) return entry.captures[stepName];
  const key = Object.keys(entry.captures).find(
    (k) => k.toLowerCase() === stepName.toLowerCase()
  );
  return key ? entry.captures[key] : '';
}

// ============================================================================
// Run Numbering
// ============================================================================

export async function getNextRunNumber(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string
): Promise<number> {
  const entries = await readAllEntries(platform, workingDir, pipelineId);
  if (entries.length === 0) return 1;
  const maxRun = Math.max(...entries.map((e) => e.runNumber));
  return maxRun + 1;
}

// ============================================================================
// Memory Context Builder (for template rendering)
// ============================================================================

export interface MemoryContext {
  all: string;
  last: string;
  lastN: (n: number) => string;
  lastCapture: (stepName: string) => string;
  patterns: string;
}

export async function buildMemoryContext(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string
): Promise<MemoryContext> {
  const allEntries = await readAllEntries(platform, workingDir, pipelineId);
  const patternsStr = await readPatterns(platform, workingDir, pipelineId);
  const lastEntry = allEntries.length > 0 ? allEntries[allEntries.length - 1] : null;

  return {
    all: formatEntriesForTemplate(allEntries),
    last: lastEntry ? formatEntriesForTemplate([lastEntry]) : '',
    lastN: (n: number) => formatEntriesForTemplate(allEntries.slice(-n)),
    lastCapture: (stepName: string) =>
      lastEntry ? formatEntryCapture(lastEntry, stepName) : '',
    patterns: patternsStr,
  };
}
