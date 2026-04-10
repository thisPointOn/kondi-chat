import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff } from './diff.ts';

describe('computeUnifiedDiff', () => {
  it('returns empty for identical content', () => {
    const r = computeUnifiedDiff('a.txt', 'foo\nbar', 'foo\nbar');
    expect(r.diff).toBe('');
    expect(r.skipped).toBe('empty');
  });

  it('diffs a single-line edit', () => {
    const r = computeUnifiedDiff('a.ts', 'const x = 1;\n', 'const x = 2;\n');
    expect(r.diff).toContain('-const x = 1;');
    expect(r.diff).toContain('+const x = 2;');
    expect(r.linesAdded).toBeGreaterThanOrEqual(1);
    expect(r.linesRemoved).toBeGreaterThanOrEqual(1);
  });

  it('diffs a new file (oldContent empty) as all additions', () => {
    const r = computeUnifiedDiff('new.md', '', 'hello\nworld');
    expect(r.diff).toContain('--- /dev/null');
    expect(r.diff).toContain('+hello');
    expect(r.diff).toContain('+world');
    expect(r.linesRemoved).toBe(0);
  });

  it('skips files larger than the size cap', () => {
    const big = 'a'.repeat(250_000);
    const r = computeUnifiedDiff('big.bin', '', big);
    expect(r.skipped).toBe('file-too-large');
    expect(r.diff).toBe('');
  });

  it('detects binary content', () => {
    const r = computeUnifiedDiff('bin.bin', '', 'foo\0bar');
    expect(r.skipped).toBe('binary');
  });
});
