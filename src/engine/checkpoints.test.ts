import { describe, it, expect } from 'vitest';
import { isMutatingToolCall, predictedMutations } from './checkpoints.ts';

describe('isMutatingToolCall', () => {
  it('treats write/edit/commit as mutating', () => {
    expect(isMutatingToolCall('write_file', { path: 'a' })).toBe(true);
    expect(isMutatingToolCall('edit_file', { path: 'a', old_string: 'x', new_string: 'y' })).toBe(true);
    expect(isMutatingToolCall('git_commit', { message: 'x', files: ['a'] })).toBe(true);
  });

  it('does not treat read-only run_command prefixes as mutating', () => {
    expect(isMutatingToolCall('run_command', { command: 'ls -la' })).toBe(false);
    expect(isMutatingToolCall('run_command', { command: 'git status' })).toBe(false);
    expect(isMutatingToolCall('run_command', { command: 'cat foo.txt' })).toBe(false);
  });

  it('treats arbitrary run_command as mutating', () => {
    expect(isMutatingToolCall('run_command', { command: 'npm install' })).toBe(true);
    expect(isMutatingToolCall('run_command', { command: 'make clean' })).toBe(true);
  });

  it('does not treat read-only tools as mutating', () => {
    expect(isMutatingToolCall('read_file', { path: 'a' })).toBe(false);
    expect(isMutatingToolCall('list_files', { path: '.' })).toBe(false);
  });
});

describe('predictedMutations', () => {
  it('returns the path for write_file / edit_file', () => {
    expect(predictedMutations('write_file', { path: 'a.ts' })).toEqual(['a.ts']);
    expect(predictedMutations('edit_file', { path: 'b.ts' })).toEqual(['b.ts']);
  });
  it('returns empty for tools without a predictable path', () => {
    expect(predictedMutations('run_command', { command: 'x' })).toEqual([]);
    expect(predictedMutations('read_file', { path: 'a' })).toEqual([]);
  });
});
