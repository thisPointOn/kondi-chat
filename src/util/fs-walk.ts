/**
 * Cross-platform recursive file walk.
 *
 * Replaces Unix `find ... | sort | head` pipelines, which fail on Windows
 * (`head` / `grep` don't exist, `find` differs). Pure Node `fs` — behaves
 * identically on Windows and POSIX.
 */

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface WalkOptions {
  /** Max directory depth — files directly in root are depth 1. Default 4. */
  maxDepth?: number;
  /** Stop after collecting this many files. Default 100. */
  maxFiles?: number;
  /** Directory names to skip entirely. */
  excludeDirs?: string[];
}

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'target', '__pycache__', '.next', 'dist'];

/**
 * Walk `root` recursively. Returns file paths relative to `root`, using
 * forward slashes on every platform, sorted, and capped at `maxFiles`.
 */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? 4;
  const maxFiles = opts.maxFiles ?? 100;
  const exclude = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDES);
  const out: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!exclude.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };

  walk(root, 1);
  return out;
}
