import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verify } from './verify.ts';

describe('verify', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kondi-verify-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when no commands are configured and nothing is detected', () => {
    // Empty directory — no package.json, no Cargo.toml, etc.
    const result = verify(tempDir);
    expect(result.passed).toBe(true);
    expect(result.testOutput).toBeUndefined();
    expect(result.typecheckOutput).toBeUndefined();
    expect(result.lintOutput).toBeUndefined();
  });

  it('uses repoMap commands when provided', () => {
    const repoMap = {
      stack: ['node'],
      entrypoints: [],
      subsystems: [],
      commands: { test: 'echo "tests passed"', typecheck: 'echo "types ok"' },
      conventions: [],
    };
    const result = verify(tempDir, repoMap);
    expect(result.passed).toBe(true);
    expect(result.testOutput).toContain('tests passed');
    expect(result.typecheckOutput).toContain('types ok');
  });

  it('detects failure from non-zero exit code', () => {
    const repoMap = {
      stack: ['node'],
      entrypoints: [],
      subsystems: [],
      commands: { test: 'exit 1' },
      conventions: [],
    };
    const result = verify(tempDir, repoMap);
    expect(result.passed).toBe(false);
  });

  it('auto-detects npm test from package.json', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "npm test ok"' } }),
    );
    const result = verify(tempDir);
    expect(result.passed).toBe(true);
    expect(result.testOutput).toContain('npm test ok');
  });

  it('auto-detects typecheck from typescript devDependency', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {},
        devDependencies: { typescript: '^5.0.0' },
      }),
    );
    // npx tsc --noEmit will fail in the temp dir (no tsconfig), but that's fine —
    // we're testing that the command gets detected and run
    const result = verify(tempDir);
    // tsc will fail since there's no real TS project, which is expected
    expect(result.typecheckOutput).toBeTruthy();
  });
});
