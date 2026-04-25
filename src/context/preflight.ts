/**
 * Preflight Investigation — automatically reads relevant files before
 * the agent loop starts so the model begins each turn already knowing
 * the relevant code.
 *
 * Instead of the agent spending its first 3-4 tool calls on read_file,
 * the preflight infers which files matter from the task text and injects
 * a compact snapshot into the system prompt. Zero LLM calls — just
 * regex matching against the file tree + reading the matches.
 *
 * The router is unaffected — this runs before router.select() and
 * provides context that any model can use regardless of which one
 * is selected for the phase.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';

const MAX_FILE_SIZE = 8_000;  // chars per file
const MAX_TOTAL_SIZE = 30_000; // total preflight context chars
const MAX_FILES = 8;

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.cpp', '.cc', '.c', '.h', '.hpp', '.cs', '.rb', '.php',
  '.swift', '.kt', '.sh', '.sql', '.md', '.json', '.yml', '.yaml', '.toml',
]);

interface PreflightResult {
  filesRead: string[];
  context: string;
  gitDiff?: string;
}

/**
 * Scan the task text for file references, find related files, read
 * them, and assemble a preflight context block.
 */
export function runPreflight(
  workingDir: string,
  taskText: string,
): PreflightResult {
  const filesRead: string[] = [];
  const sections: string[] = [];
  let totalChars = 0;

  // 1. Extract explicit file references from the task text.
  const explicitFiles = extractFileReferences(taskText);

  // 2. Infer related files from keywords in the task.
  const inferredFiles = inferRelatedFiles(workingDir, taskText);

  // 3. Merge, deduplicate, cap at MAX_FILES.
  const candidates = [...new Set([...explicitFiles, ...inferredFiles])].slice(0, MAX_FILES);

  // 4. Read each file.
  for (const relPath of candidates) {
    if (totalChars >= MAX_TOTAL_SIZE) break;
    const absPath = join(workingDir, relPath);
    if (!existsSync(absPath)) continue;
    try {
      const stat = statSync(absPath);
      if (!stat.isFile() || stat.size > 100_000) continue;
      let content = readFileSync(absPath, 'utf-8');
      if (content.length > MAX_FILE_SIZE) {
        content = content.slice(0, MAX_FILE_SIZE) + `\n... (${content.length - MAX_FILE_SIZE} chars truncated)`;
      }
      sections.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
      filesRead.push(relPath);
      totalChars += content.length;
    } catch {
      // Skip unreadable files
    }
  }

  // 5. Recent git diff (last commit or uncommitted changes).
  let gitDiff: string | undefined;
  try {
    const diff = execSync('git diff --stat HEAD 2>/dev/null || git diff --stat 2>/dev/null', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (diff && diff.length < 2000) {
      gitDiff = diff;
      sections.push(`### Recent changes (git diff --stat)\n${diff}`);
    }
  } catch {
    // Not a git repo or git not available
  }

  const context = sections.length > 0
    ? `## Preflight: relevant files (auto-loaded)\n\n${sections.join('\n\n')}`
    : '';

  return { filesRead, context, gitDiff };
}

/**
 * Extract explicit file paths from the task text.
 * Matches patterns like "src/foo.ts", "package.json", "./bar/baz.py".
 */
function extractFileReferences(text: string): string[] {
  const refs: string[] = [];
  // Match file paths with known extensions
  const pathRe = /(?:^|\s|["'`(])([.\w/-]+(?:\.\w{1,10}))(?=[\s"'`),.:;]|$)/gm;
  let match;
  while ((match = pathRe.exec(text)) !== null) {
    const candidate = match[1].replace(/^\.\//, '');
    const ext = extname(candidate).toLowerCase();
    if (CODE_EXTENSIONS.has(ext) || candidate === 'package.json' || candidate === 'Cargo.toml') {
      refs.push(candidate);
    }
  }
  return refs;
}

/**
 * Infer related files from keywords in the task. Scans the file tree
 * (shallow, no node_modules) for filenames that match significant
 * words from the task.
 */
function inferRelatedFiles(workingDir: string, text: string): string[] {
  // Extract significant words (3+ chars, not common stop words)
  const stopWords = new Set(['the', 'this', 'that', 'with', 'from', 'have', 'been', 'will',
    'can', 'should', 'would', 'could', 'make', 'like', 'just', 'also', 'into', 'about',
    'what', 'when', 'where', 'which', 'there', 'their', 'them', 'then', 'than', 'some',
    'more', 'most', 'very', 'each', 'every', 'all', 'any', 'both', 'few', 'other',
    'such', 'only', 'same', 'how', 'does', 'did', 'has', 'had', 'not', 'but', 'for',
    'are', 'was', 'were', 'and', 'the', 'add', 'fix', 'update', 'change', 'remove',
    'write', 'read', 'create', 'delete', 'implement', 'refactor', 'test', 'run', 'build',
    'use', 'using', 'file', 'code', 'function', 'method', 'class', 'module',
  ]);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  if (words.length === 0) return [];

  // Scan the file tree (max 2 levels deep, skip heavy dirs)
  const skipDirs = new Set(['node_modules', '.git', '.kondi-chat', 'dist', 'target', '__pycache__', '.next']);
  const matches: string[] = [];

  function scan(dir: string, depth: number) {
    if (depth > 2) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (skipDirs.has(entry.name)) continue;
        const rel = relative(workingDir, join(dir, entry.name));
        if (entry.isDirectory()) {
          scan(join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!CODE_EXTENSIONS.has(ext)) continue;
          const nameLower = entry.name.toLowerCase().replace(extname(entry.name), '');
          // Check if any task word appears in the filename
          for (const word of words) {
            if (nameLower.includes(word) || word.includes(nameLower)) {
              matches.push(rel);
              break;
            }
          }
        }
      }
    } catch {
      // Permission error or similar
    }
  }

  scan(workingDir, 0);
  return matches;
}
