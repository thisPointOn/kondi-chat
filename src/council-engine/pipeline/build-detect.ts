/**
 * Build Command Auto-Detection
 * Scans project files to determine the appropriate build/compile command.
 * Reuses ReadFileFn type from test-detect.ts.
 */

import type { ReadFileFn } from './test-detect';

export interface DetectedBuild {
  command: string;
  framework: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Detect the appropriate build command for a project directory.
 * Checks common project files in priority order.
 *
 * @param workingDir  Absolute path to the project root
 * @param readFile    Optional callback that reads a file and returns its content
 *                    (or null if not found). When omitted, detection is skipped.
 */
export async function detectBuildCommand(
  workingDir: string,
  readFile?: ReadFileFn,
): Promise<DetectedBuild | null> {
  if (!readFile) return null;

  const fileExists = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  };

  // 1. package.json — Node.js projects
  const packageJson = await fileExists(`${workingDir}/package.json`);
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson);
      if (pkg.scripts?.build) {
        return { command: 'npm run build', framework: 'npm', confidence: 'high' };
      }
    } catch { /* invalid JSON, skip */ }

    // No build script — check for tsconfig.json → tsc --noEmit
    const tsconfig = await fileExists(`${workingDir}/tsconfig.json`);
    if (tsconfig) {
      return { command: 'npx tsc --noEmit', framework: 'tsc', confidence: 'medium' };
    }
  }

  // 2. Cargo.toml — Rust projects
  const cargoToml = await fileExists(`${workingDir}/Cargo.toml`);
  if (cargoToml) {
    return { command: 'cargo build', framework: 'cargo', confidence: 'high' };
  }

  // 3. go.mod — Go projects
  const goMod = await fileExists(`${workingDir}/go.mod`);
  if (goMod) {
    return { command: 'go build ./...', framework: 'go', confidence: 'high' };
  }

  // 4. Makefile with build target
  const makefile = await fileExists(`${workingDir}/Makefile`);
  if (makefile && /^build\s*:/m.test(makefile)) {
    return { command: 'make build', framework: 'make', confidence: 'medium' };
  }

  return null;
}
