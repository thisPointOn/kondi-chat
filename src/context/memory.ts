/**
 * Memory System — persistent KONDI.md + AGENTS.md files injected into
 * the system prompt.
 *
 * Hierarchy (lowest to highest priority; later overrides earlier):
 *   1. user memory       ~/.kondi-chat/KONDI.md (+ AGENTS.md)
 *   2. project memory    <workingDir>/KONDI.md (+ AGENTS.md)
 *   3. subdir memory     nearest-ancestor KONDI.md or AGENTS.md from the active file
 *
 * AGENTS.md is an open convention supported by Claude Code, Cursor,
 * Copilot, Gemini CLI, Windsurf, Aider, Zed, and others. kondi-chat
 * reads it at the same levels as KONDI.md. If both files exist at the
 * same level, both are loaded (AGENTS.md first, then KONDI.md).
 *
 * No YAML frontmatter parsing, no file watcher — load() re-stats on each call
 * and re-reads only files whose mtime changed.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';

/** Files to search at each level, in load order. */
const MEMORY_FILENAMES = ['AGENTS.md', 'KONDI.md'];
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

  /**
   * Read user-level + project-level memory, plus the nearest-ancestor
   * KONDI.md or AGENTS.md for activeFile. Both filenames are checked at
   * every level; if both exist, both are loaded (AGENTS.md first).
   */
  load(activeFile?: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];

    // User level: ~/.kondi-chat/AGENTS.md, ~/.kondi-chat/KONDI.md
    const userDir = join(homedir(), '.kondi-chat');
    for (const fn of MEMORY_FILENAMES) {
      const e = this.readIfPresent(join(userDir, fn), 'user');
      if (e) entries.push(e);
    }

    // Project level: <workingDir>/AGENTS.md, <workingDir>/KONDI.md
    const projectPaths = new Set<string>();
    for (const fn of MEMORY_FILENAMES) {
      const p = join(this.workingDir, fn);
      projectPaths.add(p);
      const e = this.readIfPresent(p, 'project');
      if (e) entries.push(e);
    }

    // Subdirectory: walk up from activeFile toward workingDir, stop at project root.
    if (activeFile) {
      const full = resolve(this.workingDir, activeFile);
      if (!relative(this.workingDir, full).startsWith('..')) {
        let dir = dirname(full);
        let depth = 0;
        let found = false;
        while (!found && depth < MAX_SUBDIR_DEPTH && dir.length >= this.workingDir.length && dir !== this.workingDir) {
          for (const fn of MEMORY_FILENAMES) {
            const candidate = join(dir, fn);
            if (projectPaths.has(candidate)) continue;
            const e = this.readIfPresent(candidate, 'subdirectory');
            if (e) { entries.push(e); found = true; }
          }
          if (found) break;
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
    // Writes always go to KONDI.md (the kondi-chat-specific file).
    // AGENTS.md is a cross-tool convention and is typically hand-authored
    // or maintained by a separate process — the agent shouldn't overwrite it.
    const target = scope === 'user'
      ? join(homedir(), '.kondi-chat', 'KONDI.md')
      : join(this.workingDir, 'KONDI.md');
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
