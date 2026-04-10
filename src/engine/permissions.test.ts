import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager } from './permissions.ts';

describe('PermissionManager', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kondi-perm-'));
  });

  it('auto-approves read-only tools by default', () => {
    const pm = new PermissionManager(join(dir, 'permissions.json'));
    expect(pm.check('read_file', { path: 'a.ts' })).toBe('auto-approve');
    expect(pm.check('list_files', { path: '.' })).toBe('auto-approve');
  });

  it('requires confirmation for mutating tools by default', () => {
    const pm = new PermissionManager(join(dir, 'permissions.json'));
    expect(pm.check('write_file', { path: 'a.ts' })).toBe('confirm');
    expect(pm.check('run_command', { command: 'ls -la' })).toBe('confirm');
  });

  it('forces always-confirm on dangerous run_command patterns', () => {
    const pm = new PermissionManager(join(dir, 'permissions.json'));
    expect(pm.check('run_command', { command: 'rm -rf /tmp/foo' })).toBe('always-confirm');
    expect(pm.check('run_command', { command: 'sudo apt install curl' })).toBe('always-confirm');
    expect(pm.check('run_command', { command: 'git push --force origin main' })).toBe('always-confirm');
  });

  it('--dangerously-skip-permissions auto-approves everything', () => {
    const pm = new PermissionManager(join(dir, 'permissions.json'), true);
    expect(pm.check('run_command', { command: 'rm -rf /' })).toBe('auto-approve');
  });

});
