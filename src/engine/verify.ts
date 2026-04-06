/**
 * Verification — run local tests, lint, and typecheck after task execution.
 */

import { execSync } from 'node:child_process';
import type { VerificationResult, RepoMap } from '../types.ts';

const TIMEOUT_MS = 60_000; // 1 minute per command

/**
 * Run all available verification commands and return results.
 */
export function verify(workingDir: string, repoMap?: RepoMap): VerificationResult {
  const commands = repoMap?.commands || detectCommands(workingDir);
  const result: VerificationResult = { passed: true };

  // Test
  if (commands.test) {
    const testResult = runCommand(commands.test, workingDir);
    result.testOutput = testResult.output;
    if (!testResult.ok) result.passed = false;
  }

  // Typecheck
  if (commands.typecheck) {
    const typecheckResult = runCommand(commands.typecheck, workingDir);
    result.typecheckOutput = typecheckResult.output;
    if (!typecheckResult.ok) result.passed = false;
  }

  // Lint
  if (commands.lint) {
    const lintResult = runCommand(commands.lint, workingDir);
    result.lintOutput = lintResult.output;
    if (!lintResult.ok) result.passed = false;
  }

  return result;
}

/**
 * Auto-detect build/test/lint commands from project files.
 */
function detectCommands(workingDir: string): RepoMap['commands'] {
  const { existsSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const commands: RepoMap['commands'] = {};

  // Node.js / package.json
  const pkgPath = join(workingDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      if (scripts.test) commands.test = 'npm test';
      if (scripts.lint) commands.lint = 'npm run lint';
      if (scripts.typecheck) commands.typecheck = 'npm run typecheck';
      else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        commands.typecheck = 'npx tsc --noEmit';
      }
      if (scripts.build) commands.build = 'npm run build';
    } catch { /* ignore */ }
  }

  // Python
  if (existsSync(join(workingDir, 'pyproject.toml')) || existsSync(join(workingDir, 'setup.py'))) {
    if (!commands.test) commands.test = 'pytest';
    if (!commands.lint) commands.lint = 'ruff check .';
    if (!commands.typecheck) commands.typecheck = 'mypy .';
  }

  // Rust
  if (existsSync(join(workingDir, 'Cargo.toml'))) {
    commands.test = 'cargo test';
    commands.build = 'cargo build';
    commands.lint = 'cargo clippy';
  }

  // Go
  if (existsSync(join(workingDir, 'go.mod'))) {
    commands.test = 'go test ./...';
    commands.build = 'go build ./...';
    commands.lint = 'golangci-lint run';
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.slice(-2000) }; // Keep last 2K chars
  } catch (error: any) {
    const stdout = error.stdout?.toString() || '';
    const stderr = error.stderr?.toString() || '';
    const combined = `${stdout}\n${stderr}`.trim().slice(-2000);
    return { ok: false, output: combined || error.message };
  }
}
