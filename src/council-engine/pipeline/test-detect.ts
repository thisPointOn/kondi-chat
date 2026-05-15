/**
 * Test Command Auto-Detection
 * Scans project files to determine the appropriate test command.
 * Accepts an optional readFile callback to abstract file I/O (Tauri / Node.js).
 */

export type ReadFileFn = (path: string) => Promise<string | null>;

export interface DetectedTest {
  command: string;
  framework: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Detect the appropriate test command for a project directory.
 * Checks common project files in priority order.
 *
 * @param workingDir  Absolute path to the project root
 * @param readFile    Optional callback that reads a file and returns its content
 *                    (or null if not found). When omitted, detection is skipped.
 */
export async function detectTestCommand(
  workingDir: string,
  readFile?: ReadFileFn,
): Promise<DetectedTest | null> {
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
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        let framework = 'npm test';
        if (deps?.vitest) framework = 'vitest';
        else if (deps?.jest) framework = 'jest';
        else if (deps?.mocha) framework = 'mocha';
        return { command: 'npm test', framework, confidence: 'high' };
      }
    } catch { /* invalid JSON, skip */ }
  }

  // 2. Cargo.toml — Rust projects
  const cargoToml = await fileExists(`${workingDir}/Cargo.toml`);
  if (cargoToml) {
    return { command: 'cargo test', framework: 'cargo', confidence: 'high' };
  }

  // 3. go.mod — Go projects
  const goMod = await fileExists(`${workingDir}/go.mod`);
  if (goMod) {
    return { command: 'go test ./...', framework: 'go test', confidence: 'high' };
  }

  // 4. Python — pytest or unittest
  const pytestIni = await fileExists(`${workingDir}/pytest.ini`);
  if (pytestIni) {
    return { command: 'pytest', framework: 'pytest', confidence: 'high' };
  }
  const pyprojectToml = await fileExists(`${workingDir}/pyproject.toml`);
  if (pyprojectToml && pyprojectToml.includes('[tool.pytest')) {
    return { command: 'pytest', framework: 'pytest', confidence: 'high' };
  }

  // 5. Makefile with test target
  const makefile = await fileExists(`${workingDir}/Makefile`);
  if (makefile && /^test\s*:/m.test(makefile)) {
    return { command: 'make test', framework: 'make', confidence: 'medium' };
  }

  return null;
}
