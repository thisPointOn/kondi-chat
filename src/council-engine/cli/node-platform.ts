/**
 * Node.js PlatformAdapter implementation for CLI mode.
 * Uses fs and child_process instead of Tauri invoke.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PlatformAdapter } from '../pipeline/executor';

function assertSafePath(filePath: string, workingDir: string): void {
  const resolved = path.resolve(filePath);
  const base = path.resolve(workingDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path traversal blocked: ${filePath} escapes working directory ${workingDir}`);
  }
}

export function createNodePlatform(initialWorkingDir: string): PlatformAdapter {
  let workingDir = initialWorkingDir;

  return {
    async writeFile(filePath: string, content: string): Promise<void> {
      assertSafePath(filePath, workingDir);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    },

    async readFile(filePath: string): Promise<string | null> {
      assertSafePath(filePath, workingDir);
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    },

    async runCommand(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }> {
      try {
        const stdout = execFileSync('/bin/sh', ['-c', cmd], {
          cwd,
          encoding: 'utf-8',
          timeout: 300_000, // 5 minute timeout for test commands
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { stdout, stderr: '', exit_code: 0, success: true };
      } catch (err: any) {
        return {
          stdout: err.stdout || '',
          stderr: err.stderr || err.message || '',
          exit_code: err.status ?? 1,
          success: false,
        };
      }
    },

    setWorkingDir(dir: string): void {
      workingDir = dir;
    },

    getWorkingDir(): string {
      return workingDir;
    },

    // saveDeliberationOutput is optional in CLI — files are written directly via writeFile
  };
}
