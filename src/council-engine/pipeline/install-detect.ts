/**
 * Install Command Auto-Detection
 * Scans project files to determine the appropriate dependency install command.
 * Reuses ReadFileFn type from test-detect.ts.
 */

import type { ReadFileFn } from './test-detect';

export interface DetectedInstall {
  command: string;
  framework: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Detect the appropriate install command for a project directory.
 * Checks common project files in priority order.
 *
 * @param workingDir  Absolute path to the project root
 * @param readFile    Optional callback that reads a file and returns its content
 *                    (or null if not found). When omitted, detection is skipped.
 */
export async function detectInstallCommand(
  workingDir: string,
  readFile?: ReadFileFn,
): Promise<DetectedInstall | null> {
  if (!readFile) return null;

  const fileExists = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  };

  // 1. Node.js — lockfile-first detection
  const pnpmLock = await fileExists(`${workingDir}/pnpm-lock.yaml`);
  if (pnpmLock) {
    return { command: 'pnpm install', framework: 'pnpm', confidence: 'high' };
  }

  const yarnLock = await fileExists(`${workingDir}/yarn.lock`);
  if (yarnLock) {
    return { command: 'yarn install', framework: 'yarn', confidence: 'high' };
  }

  const packageLock = await fileExists(`${workingDir}/package-lock.json`);
  if (packageLock) {
    return { command: 'npm install', framework: 'npm', confidence: 'high' };
  }

  const packageJson = await fileExists(`${workingDir}/package.json`);
  if (packageJson) {
    return { command: 'npm install', framework: 'npm', confidence: 'medium' };
  }

  // 2. Python — requirements.txt or pyproject.toml
  const requirements = await fileExists(`${workingDir}/requirements.txt`);
  if (requirements) {
    return { command: 'pip install -r requirements.txt', framework: 'pip', confidence: 'high' };
  }

  const pyprojectToml = await fileExists(`${workingDir}/pyproject.toml`);
  if (pyprojectToml && (pyprojectToml.includes('[project.dependencies]') || pyprojectToml.includes('dependencies'))) {
    return { command: 'pip install -e .', framework: 'pip', confidence: 'medium' };
  }

  // 3. Rust — skip (cargo build handles deps implicitly)

  // 4. Go — go.mod
  const goMod = await fileExists(`${workingDir}/go.mod`);
  if (goMod) {
    return { command: 'go mod download', framework: 'go', confidence: 'high' };
  }

  // 5. Makefile with install target
  const makefile = await fileExists(`${workingDir}/Makefile`);
  if (makefile && /^install\s*:/m.test(makefile)) {
    return { command: 'make install', framework: 'make', confidence: 'medium' };
  }

  return null;
}
