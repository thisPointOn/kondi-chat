import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRelevantFiles } from './task-card.ts';

describe('readRelevantFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kondi-task-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/index.ts'), 'export const main = () => "hello";');
    writeFileSync(join(tempDir, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b; }');
    writeFileSync(join(tempDir, 'README.md'), '# Test Project');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads listed files and formats them', () => {
    const result = readRelevantFiles(tempDir, ['src/index.ts', 'README.md']);
    expect(result).toContain('#### src/index.ts');
    expect(result).toContain('export const main');
    expect(result).toContain('#### README.md');
    expect(result).toContain('# Test Project');
  });

  it('handles missing files gracefully', () => {
    const result = readRelevantFiles(tempDir, ['src/index.ts', 'nonexistent.ts']);
    expect(result).toContain('#### src/index.ts');
    expect(result).toContain('#### nonexistent.ts');
    expect(result).toContain('(file not found)');
  });

  it('truncates large files', () => {
    writeFileSync(join(tempDir, 'big.txt'), 'x'.repeat(10_000));
    const result = readRelevantFiles(tempDir, ['big.txt'], 500);
    expect(result).toContain('... (truncated)');
    expect(result.length).toBeLessThan(10_000);
  });

  it('returns empty string for empty file list', () => {
    const result = readRelevantFiles(tempDir, []);
    expect(result).toBe('');
  });

  it('blocks path traversal attempts', () => {
    const result = readRelevantFiles(tempDir, ['../../etc/passwd']);
    // Should not contain actual file content from outside workingDir
    expect(result).not.toContain('root:');
    // The path traversal resolves outside base, so it gets skipped entirely
  });
});
