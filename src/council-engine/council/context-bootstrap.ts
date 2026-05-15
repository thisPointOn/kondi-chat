/**
 * Directory Context Bootstrapping
 * Scans a working directory to produce structured context for council deliberations.
 *
 * Node.js implementation (no Tauri dependency).
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_FILE_SIZE = 2048; // chars per key file
const MAX_TOTAL_CHARS_DEFAULT = 10000;
const MAX_TOTAL_CHARS_DEEP = 120000; // ~30k tokens — enough for full source review

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

const KEY_ENTRY_PATTERNS = [
  'src/index.ts', 'src/index.js', 'src/index.tsx',
  'src/main.ts', 'src/main.js', 'src/main.tsx', 'src/main.rs',
  'src/app.ts', 'src/app.js', 'src/App.tsx',
  'src/lib.rs',
  'main.go', 'main.py', 'app.py',
];

const SOURCE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb'];

/**
 * Bootstrap directory context by scanning the working directory.
 * When deep=true, reads all source files (for personas without tool access).
 * Returns a formatted context block, or empty string if scanning fails.
 */
export async function bootstrapDirectoryContext(
  workingDir: string,
  options?: { maxFiles?: number; maxFileSize?: number; deep?: boolean }
): Promise<string> {
  const maxFiles = options?.maxFiles ?? 80;
  const maxFileSize = options?.maxFileSize ?? MAX_FILE_SIZE;
  const deep = options?.deep ?? false;
  const maxTotalChars = deep ? MAX_TOTAL_CHARS_DEEP : MAX_TOTAL_CHARS_DEFAULT;

  try {
    // Step 1: Get directory tree
    let tree = '';
    let fileList: string[] = [];
    try {
      const rawTree = execSync(
        `find . -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/target/*' -not -path '*/__pycache__/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/package-lock.json' | sort | head -${maxFiles}`,
        { cwd: workingDir, encoding: 'utf-8', timeout: 10_000 }
      ).trim();
      tree = rawTree;
      fileList = rawTree.split('\n').filter(Boolean);
    } catch {
      // find command failed, continue without tree
    }

    // Step 2: Read key files
    const keyFileContents: Array<{ name: string; content: string }> = [];
    let totalChars = tree.length + 200; // overhead for headers

    const resolvedBase = resolve(workingDir);

    // Key files first
    const filesToTry = [...KEY_FILES, ...KEY_ENTRY_PATTERNS];
    for (const fileName of filesToTry) {
      if (totalChars >= maxTotalChars) break;
      const content = safeReadFile(workingDir, resolvedBase, fileName, maxFileSize);
      if (content) {
        keyFileContents.push({ name: fileName, content });
        totalChars += content.length + fileName.length + 20;
      }
    }

    // Step 3: In deep mode, read all source files from the tree
    if (deep && fileList.length > 0) {
      const sourceFiles = fileList.filter(f =>
        SOURCE_EXTENSIONS.some(ext => f.endsWith(ext)) &&
        !filesToTry.some(kf => f.endsWith(kf))
      );

      for (const relPath of sourceFiles) {
        if (totalChars >= maxTotalChars) break;
        const cleanPath = relPath.startsWith('./') ? relPath.slice(2) : relPath;
        const deepMaxSize = Math.min(4096, maxTotalChars - totalChars);
        if (deepMaxSize < 100) break;
        const content = safeReadFile(workingDir, resolvedBase, cleanPath, deepMaxSize);
        if (content) {
          keyFileContents.push({ name: cleanPath, content });
          totalChars += content.length + cleanPath.length + 20;
        }
      }
    }

    // Step 4: Format output
    if (!tree && keyFileContents.length === 0) {
      return '';
    }

    const sections: string[] = [];
    sections.push(`## Working Directory: ${workingDir}`);

    if (tree) {
      sections.push(`### Directory Structure\n\`\`\`\n${tree}\n\`\`\``);
    }

    if (keyFileContents.length > 0) {
      sections.push('### Key Files');
      for (const file of keyFileContents) {
        sections.push(`#### ${file.name}\n\`\`\`\n${file.content}\n\`\`\``);
      }
    }

    return sections.join('\n\n');
  } catch (error) {
    console.warn('[ContextBootstrap] Failed to bootstrap directory context:', error);
    return '';
  }
}

function safeReadFile(workingDir: string, resolvedBase: string, fileName: string, maxSize: number): string | null {
  try {
    const filePath = join(workingDir.replace(/\/$/, ''), fileName);
    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(resolvedBase + '/') && resolvedPath !== resolvedBase) return null;
    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, 'utf-8');
    if (!content || content.length === 0) return null;

    return content.length > maxSize
      ? content.slice(0, maxSize) + '\n... (truncated)'
      : content;
  } catch {
    return null;
  }
}
