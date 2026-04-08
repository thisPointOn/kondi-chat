/**
 * Apply — parses model output and writes changes to disk.
 *
 * Supports two output modes:
 *   - file_replacements: model returns full file contents with path labels
 *   - diff: model returns unified diffs
 *
 * All writes are backed up before overwriting. Backup files go to
 * .kondi-chat/backups/<task-id>/ so they can be restored.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

function isPathSafe(base: string, fullPath: string): boolean {
  const rel = relative(base, fullPath);
  return !rel.startsWith('..') && !resolve(fullPath).includes('\0');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  content: string;
  isNew: boolean;
}

export interface ApplyResult {
  applied: FileChange[];
  skipped: string[];
  backupDir?: string;
}

// ---------------------------------------------------------------------------
// Parse model output
// ---------------------------------------------------------------------------

/**
 * Parse file replacements from model output.
 *
 * Expects patterns like:
 *   #### path/to/file.ts
 *   ```
 *   file content
 *   ```
 *
 * Or:
 *   **File: path/to/file.ts**
 *   ```typescript
 *   file content
 *   ```
 *
 * Or:
 *   // path/to/file.ts
 *   ```
 *   file content
 *   ```
 */
export function parseFileReplacements(output: string): FileChange[] {
  const changes: FileChange[] = [];

  // Pattern 1: #### path/to/file
  // Pattern 2: **File: path/to/file**
  // Pattern 3: ## path/to/file
  // Pattern 4: `path/to/file`:
  const headerPatterns = [
    /^#{1,4}\s+([^\n]+?)$/gm,
    /^\*\*(?:File:\s*)?([^\n*]+?)\*\*$/gm,
    /^`([^`\n]+?)`\s*:?\s*$/gm,
    /^\/\/\s+([^\n]+?)$/gm,
  ];

  // Find all code blocks
  const codeBlockRegex = /```[a-z]*\n([\s\S]*?)```/g;
  const blocks: { start: number; end: number; content: string }[] = [];
  let match;
  while ((match = codeBlockRegex.exec(output)) !== null) {
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1],
    });
  }

  if (blocks.length === 0) return [];

  // For each code block, look backwards for a path header
  for (const block of blocks) {
    const textBefore = output.slice(Math.max(0, block.start - 300), block.start);
    let filePath: string | null = null;

    for (const pattern of headerPatterns) {
      pattern.lastIndex = 0;
      let headerMatch;
      let lastMatch: RegExpExecArray | null = null;
      while ((headerMatch = pattern.exec(textBefore)) !== null) {
        lastMatch = headerMatch;
      }
      if (lastMatch) {
        const candidate = lastMatch[1].trim()
          .replace(/^`|`$/g, '')
          .replace(/^\*\*|\*\*$/g, '')
          .replace(/^File:\s*/i, '')
          .trim();
        // Validate it looks like a file path
        if (candidate.includes('/') || candidate.includes('.')) {
          filePath = candidate;
          break;
        }
      }
    }

    if (filePath) {
      // Clean up the content — remove trailing newline
      let content = block.content;
      if (content.endsWith('\n')) {
        content = content.slice(0, -1);
      }
      changes.push({
        path: filePath,
        content,
        isNew: false, // Will be set during apply
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Apply changes to disk
// ---------------------------------------------------------------------------

/**
 * Apply file changes to the working directory.
 *
 * @param workingDir  Root directory for the project
 * @param changes     Parsed file changes
 * @param backupDir   Where to store backups (optional)
 */
export function applyChanges(
  workingDir: string,
  changes: FileChange[],
  backupDir?: string,
): ApplyResult {
  const base = resolve(workingDir);
  const applied: FileChange[] = [];
  const skipped: string[] = [];

  // Create backup directory
  if (backupDir) {
    mkdirSync(backupDir, { recursive: true });
  }

  for (const change of changes) {
    const fullPath = resolve(join(workingDir, change.path));

    // Path traversal check
    if (!isPathSafe(base, fullPath)) {
      skipped.push(`${change.path} (path traversal blocked)`);
      continue;
    }

    // Backup existing file
    if (existsSync(fullPath) && backupDir) {
      const backupPath = join(backupDir, change.path);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(fullPath, backupPath);
    }

    change.isNew = !existsSync(fullPath);

    // Create parent directories
    mkdirSync(dirname(fullPath), { recursive: true });

    // Write the file
    writeFileSync(fullPath, change.content + '\n');
    applied.push(change);
  }

  return { applied, skipped, backupDir };
}

// ---------------------------------------------------------------------------
// Restore from backup
// ---------------------------------------------------------------------------

/**
 * Restore files from a backup directory.
 */
export function restoreBackup(workingDir: string, backupDir: string, files: string[]): string[] {
  const restored: string[] = [];

  for (const relPath of files) {
    const backupPath = join(backupDir, relPath);
    const targetPath = join(workingDir, relPath);

    if (existsSync(backupPath)) {
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(backupPath, targetPath);
      restored.push(relPath);
    }
  }

  return restored;
}

// ---------------------------------------------------------------------------
// Format for display
// ---------------------------------------------------------------------------

export function formatApplyResult(result: ApplyResult): string {
  const lines: string[] = [];

  if (result.applied.length > 0) {
    lines.push(`Applied ${result.applied.length} file(s):`);
    for (const f of result.applied) {
      lines.push(`  ${f.isNew ? '+' : '~'} ${f.path}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length}:`);
    for (const s of result.skipped) {
      lines.push(`  ✗ ${s}`);
    }
  }

  if (result.backupDir) {
    lines.push(`Backups: ${result.backupDir}`);
  }

  return lines.join('\n');
}
