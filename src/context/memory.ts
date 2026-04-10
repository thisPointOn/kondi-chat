/**
 * Memory System — persistent KONDI.md files injected into the system prompt.
 *
 * Hierarchy (lowest to highest priority; later overrides earlier):
 *   1. user memory       ~/.kondi-chat/KONDI.md
 *   2. project memory    <workingDir>/KONDI.md
 *   3. subdir memory     nearest-ancestor KONDI.md from the active file
 *
 * No YAML frontmatter parsing, no file watcher — load() re-stats on each call
 * and re-reads only files whose mtime changed.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';

const MEMORY_FILENAME = 'KONDI.md';
const MAX_FILE_BYTES = 50_000;
const MAX_SUBDIR_DEPTH = 5;

export interface MemoryEntry {
  source: 'user' | 'project' | 'subdirectory';
  path: string;
  content: string;
}

interface Cached {
  mtimeMs: number;
  content: string;
}

function readCapped(path: string): string {
  const buf = readFileSync(path, 'utf-8');
  return buf.length > MAX_FILE_BYTES
    ? buf.slice(0, MAX_FILE_BYTES) + '\n\n(truncated)'
    : buf;
}

export class MemoryManager {
  private workingDir: string;
  private cache = new Map<string, Cached>();

  constructor(workingDir: string) {
    this.workingDir = resolve(workingDir);
  }

  /** Read user-level + project-level memory, plus the nearest-ancestor KONDI.md for activeFile. */
  load(activeFile?: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];

    const userPath = join(homedir(), '.kondi-chat', MEMORY_FILENAME);
    const userEntry = this.readIfPresent(userPath, 'user');
    if (userEntry) entries.push(userEntry);

    const projectPath = join(this.workingDir, MEMORY_FILENAME);
    const projectEntry = this.readIfPresent(projectPath, 'project');
    if (projectEntry) entries.push(projectEntry);

    // Subdirectory: walk up from activeFile toward workingDir, stop at project root.
    if (activeFile) {
      const full = resolve(this.workingDir, activeFile);
      if (!relative(this.workingDir, full).startsWith('..')) {
        let dir = dirname(full);
        let depth = 0;
        while (depth < MAX_SUBDIR_DEPTH && dir.length >= this.workingDir.length && dir !== this.workingDir) {
          const candidate = join(dir, MEMORY_FILENAME);
          const e = this.readIfPresent(candidate, 'subdirectory');
          if (e && e.path !== projectPath) { entries.push(e); break; }
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
          depth++;
        }
      }
    }

    return entries;
  }

  private readIfPresent(path: string, source: MemoryEntry['source']): MemoryEntry | null {
    if (!existsSync(path)) { this.cache.delete(path); return null; }
    try {
      const stat = statSync(path);
      const cached = this.cache.get(path);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return { source, path, content: cached.content };
      }
      const content = readCapped(path);
      this.cache.set(path, { mtimeMs: stat.mtimeMs, content });
      return { source, path, content };
    } catch {
      return null;
    }
  }

  /** Render memory entries as a delimited system-prompt section. Lower-priority first. */
  formatForPrompt(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';
    const order: MemoryEntry['source'][] = ['user', 'project', 'subdirectory'];
    const sorted = [...entries].sort(
      (a, b) => order.indexOf(a.source) - order.indexOf(b.source),
    );
    const parts: string[] = ['## Memory (advisory, not safety-critical; higher sections override lower)'];
    for (const e of sorted) {
      parts.push(`### Memory: ${e.source} (${e.path})\n${e.content.trim()}`);
    }
    return parts.join('\n\n');
  }

  /**
   * Write a KONDI.md file. `append` concatenates to the existing file; `replace` overwrites.
   * Returns the absolute path written.
   */
  updateMemory(
    scope: 'user' | 'project',
    operation: 'append' | 'replace',
    content: string,
  ): { path: string } {
    const target = scope === 'user'
      ? join(homedir(), '.kondi-chat', MEMORY_FILENAME)
      : join(this.workingDir, MEMORY_FILENAME);
    mkdirSync(dirname(target), { recursive: true });
    if (operation === 'append' && existsSync(target)) {
      const existing = readFileSync(target, 'utf-8');
      const sep = existing.endsWith('\n') ? '' : '\n';
      writeFileSync(target, existing + sep + content + '\n');
    } else {
      writeFileSync(target, content.endsWith('\n') ? content : content + '\n');
    }
    this.cache.delete(target);
    return { path: target };
  }
}
