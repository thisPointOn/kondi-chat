/**
 * Directory Context Bootstrap
 *
 * Scans a working directory to produce structured grounding context.
 * Based on kondi-council's context-bootstrap.ts — simplified, two-tier.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_FILE_SIZE = 2048;

const KEY_FILES = [
  'README.md',
  'package.json',
  'Cargo.toml',
  'tsconfig.json',
  '.env.example',
  'pyproject.toml',
  'go.mod',
  'Makefile',
  'docker-compose.yml',
  'Dockerfile',
];

const ENTRY_PATTERNS = [
  'src/index.ts', 'src/index.js', 'src/index.tsx',
  'src/main.ts', 'src/main.js', 'src/main.tsx', 'src/main.rs',
  'src/app.ts', 'src/app.js', 'src/App.tsx',
  'src/lib.rs',
  'main.go', 'main.py', 'app.py',
];

const SOURCE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb'];

export type BootstrapDepth = 'light' | 'deep';

/**
 * Bootstrap directory context.
 *
 * - light: tree + key files (~10K chars, ~2.5K tokens)
 * - deep: tree + key files + all source files (~120K chars, ~30K tokens)
 */
export async function bootstrapDirectory(
  workingDir: string,
  depth: BootstrapDepth = 'light',
): Promise<string> {
  const maxTotalChars = depth === 'deep' ? 120_000 : 10_000;
  const maxFiles = 80;

  try {
    let tree = '';
    let fileList: string[] = [];

    try {
      const raw = execSync(
        `find . -maxdepth 4 -type f ` +
        `-not -path '*/node_modules/*' -not -path '*/.git/*' ` +
        `-not -path '*/target/*' -not -path '*/__pycache__/*' ` +
        `-not -path '*/.next/*' -not -path '*/dist/*' ` +
        `-not -path '*/package-lock.json' ` +
        `| sort | head -${maxFiles}`,
        { cwd: workingDir, encoding: 'utf-8', timeout: 10_000 },
      ).trim();
      tree = raw;
      fileList = raw.split('\n').filter(Boolean);
    } catch {
      // find failed, continue
    }

    const files: Array<{ name: string; content: string }> = [];
    let totalChars = tree.length + 200;
    const resolvedBase = resolve(workingDir);

    // Key files first
    for (const fileName of [...KEY_FILES, ...ENTRY_PATTERNS]) {
      if (totalChars >= maxTotalChars) break;
      const content = safeRead(workingDir, resolvedBase, fileName, MAX_FILE_SIZE);
      if (content) {
        files.push({ name: fileName, content });
        totalChars += content.length + fileName.length + 20;
      }
    }

    // Deep mode: all source files
    if (depth === 'deep' && fileList.length > 0) {
      const keySet = new Set([...KEY_FILES, ...ENTRY_PATTERNS]);
      const sourceFiles = fileList.filter(f =>
        SOURCE_EXTENSIONS.some(ext => f.endsWith(ext)) &&
        !Array.from(keySet).some(kf => f.endsWith(kf))
      );

      for (const relPath of sourceFiles) {
        if (totalChars >= maxTotalChars) break;
        const cleanPath = relPath.startsWith('./') ? relPath.slice(2) : relPath;
        const maxSize = Math.min(4096, maxTotalChars - totalChars);
        if (maxSize < 100) break;
        const content = safeRead(workingDir, resolvedBase, cleanPath, maxSize);
        if (content) {
          files.push({ name: cleanPath, content });
          totalChars += content.length + cleanPath.length + 20;
        }
      }
    }

    if (!tree && files.length === 0) return '';

    const sections: string[] = [];
    sections.push(`## Working Directory: ${workingDir}`);
    if (tree) sections.push(`### File Tree\n\`\`\`\n${tree}\n\`\`\``);
    if (files.length > 0) {
      sections.push('### Files');
      for (const f of files) {
        sections.push(`#### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``);
      }
    }

    return sections.join('\n\n');
  } catch (error) {
    process.stderr.write(`[bootstrap] Failed: ${(error as Error).message}\n`);
    return '';
  }
}

function safeRead(workingDir: string, base: string, fileName: string, maxSize: number): string | null {
  try {
    const filePath = join(workingDir.replace(/\/$/, ''), fileName);
    const resolved = resolve(filePath);
    if (!resolved.startsWith(base + '/') && resolved !== base) return null;
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    if (!content) return null;
    return content.length > maxSize ? content.slice(0, maxSize) + '\n... (truncated)' : content;
  } catch {
    return null;
  }
}
