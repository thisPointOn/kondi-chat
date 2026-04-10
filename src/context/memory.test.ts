import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from './memory.ts';

describe('MemoryManager', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kondi-mem-'));
  });

  it('returns [] when no KONDI.md files exist', () => {
    const m = new MemoryManager(dir);
    expect(m.load()).toEqual([]);
  });

  it('loads project KONDI.md', () => {
    writeFileSync(join(dir, 'KONDI.md'), '# project rules');
    const m = new MemoryManager(dir);
    const entries = m.load();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('project');
    expect(entries[0].content).toContain('project rules');
  });

  it('walks up to a subdirectory KONDI.md', () => {
    const sub = join(dir, 'packages', 'api');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'KONDI.md'), 'use fastify');
    writeFileSync(join(sub, 'server.ts'), '// ...');
    const m = new MemoryManager(dir);
    const entries = m.load(join('packages', 'api', 'server.ts'));
    expect(entries.some(e => e.source === 'subdirectory' && e.content.includes('use fastify'))).toBe(true);
  });

  it('append creates the file and preserves prior content', () => {
    const m = new MemoryManager(dir);
    m.updateMemory('project', 'append', 'first');
    m.updateMemory('project', 'append', 'second');
    const entries = m.load();
    expect(entries[0].content).toContain('first');
    expect(entries[0].content).toContain('second');
  });

});
