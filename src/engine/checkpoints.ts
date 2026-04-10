/**
 * Checkpoints — automatic restore points taken before the first mutating
 * tool call in a turn. Git mode uses `git stash create`; file mode copies
 * mutated files into `.kondi-chat/checkpoints/<session-id>/<cp-id>/files/`.
 */

import { execSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type CheckpointMode = 'git' | 'file';

export interface Checkpoint {
  id: string;
  turnNumber: number;
  timestamp: string;
  mode: CheckpointMode;
  stashRef?: string;        // git sha of the stash commit
  preHead?: string;         // HEAD at checkpoint time (git mode)
  filesChanged: string[];
  summary: string;
  costUsd: number;
  userMessage: string;
}

const MAX_CHECKPOINTS = 20;
const NON_MUTATING_COMMAND_PREFIXES = [
  'ls', 'cat', 'grep', 'find', 'echo', 'pwd', 'which', 'file', 'head', 'tail', 'wc',
  'git status', 'git log', 'git diff', 'git show', 'git blame', 'git branch',
  'npm test', 'npm run test', 'npx vitest', 'npx tsc',
  'cargo check', 'cargo test', 'cargo fmt --check', 'cargo clippy',
  'tsc --noEmit', 'python -c', 'node -v', 'node --version',
];

const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'create_task', 'update_memory',
  'git_commit', 'git_branch', 'git_create_pr',
]);

/** Predict which files this tool call will touch (for file-mode pre-snapshots). */
export function predictedMutations(name: string, args: Record<string, unknown>): string[] {
  if (name === 'write_file' || name === 'edit_file') {
    const p = args.path;
    return typeof p === 'string' ? [p] : [];
  }
  return [];
}

/** Return true if this tool call should cause a checkpoint snapshot before running. */
export function isMutatingToolCall(name: string, args: Record<string, unknown>): boolean {
  if (MUTATING_TOOLS.has(name)) return true;
  if (name === 'run_command') {
    const cmd = String(args.command || '').trim();
    if (!cmd) return false;
    for (const prefix of NON_MUTATING_COMMAND_PREFIXES) {
      if (cmd === prefix || cmd.startsWith(prefix + ' ')) return false;
    }
    return true;
  }
  return false;
}

function tryGit(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

function atomicWrite(path: string, data: string) {
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, data);
  try { renameSync(tmp, path); } catch { writeFileSync(path, data); }
}

export class CheckpointManager {
  private workingDir: string;
  private storageDir: string;
  private indexPath: string;
  private checkpoints: Checkpoint[] = [];
  private isGitRepo: boolean;

  constructor(workingDir: string, sessionId: string, storageRoot: string) {
    this.workingDir = resolve(workingDir);
    this.storageDir = join(storageRoot, 'checkpoints', sessionId);
    this.indexPath = join(this.storageDir, 'index.json');
    mkdirSync(this.storageDir, { recursive: true });
    this.isGitRepo = tryGit('git rev-parse --is-inside-work-tree', this.workingDir) === 'true';
    this.loadIndex();
  }

  list(): Checkpoint[] {
    return [...this.checkpoints].reverse();
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find(c => c.id === id);
  }

  /**
   * Create a checkpoint just before the first mutation in a turn.
   * `mutatedFiles` is used in file mode; `summary` is shown in /checkpoints.
   */
  create(summary: string, userMessage: string, turnNumber: number, costUsd: number, mutatedFiles: Set<string>): Checkpoint {
    const id = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();

    let cp: Checkpoint;
    if (this.isGitRepo) {
      const stashRef = tryGit('git stash create', this.workingDir);
      if (stashRef) {
        const preHead = tryGit('git rev-parse HEAD', this.workingDir);
        cp = {
          id, turnNumber, timestamp, mode: 'git',
          stashRef, preHead, filesChanged: [...mutatedFiles], summary, costUsd, userMessage,
        };
      } else {
        cp = this.createFileCheckpoint(id, timestamp, turnNumber, summary, userMessage, costUsd, mutatedFiles);
      }
    } else {
      cp = this.createFileCheckpoint(id, timestamp, turnNumber, summary, userMessage, costUsd, mutatedFiles);
    }

    this.checkpoints.push(cp);
    this.saveIndex();
    this.prune();
    return cp;
  }

  private createFileCheckpoint(
    id: string, timestamp: string, turnNumber: number,
    summary: string, userMessage: string, costUsd: number,
    mutatedFiles: Set<string>,
  ): Checkpoint {
    const dir = join(this.storageDir, id, 'files');
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const rel of mutatedFiles) {
      const source = join(this.workingDir, rel);
      if (!existsSync(source)) { files.push(rel); continue; }
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      try { copyFileSync(source, dest); files.push(rel); } catch { /* skip */ }
    }
    return { id, turnNumber, timestamp, mode: 'file', filesChanged: files, summary, costUsd, userMessage };
  }

  /**
   * Restore to the given checkpoint. If `target` is a negative number, restore
   * to the Nth checkpoint from the tail (so -1 == latest).
   */
  restore(target: string | number): { restored: Checkpoint; filesRestored: string[]; errors: string[] } {
    let cp: Checkpoint | undefined;
    if (typeof target === 'number') {
      const idx = this.checkpoints.length + target; // e.g. -1 -> last index
      cp = this.checkpoints[idx];
    } else {
      cp = this.get(target);
    }
    if (!cp) throw new Error(`Checkpoint not found: ${target}`);

    const errors: string[] = [];
    const filesRestored: string[] = [];

    if (cp.mode === 'git' && cp.stashRef) {
      // Stash current state first so user can recover it manually if desired.
      tryGit('git stash push -u -m "kondi-chat pre-undo"', this.workingDir);
      const out = tryGit(`git stash apply ${cp.stashRef}`, this.workingDir);
      if (!out && tryGit('git status --porcelain', this.workingDir) === '') {
        errors.push('Apply returned no output — stash may be empty');
      }
      filesRestored.push(...cp.filesChanged);
    } else {
      const dir = join(this.storageDir, cp.id, 'files');
      for (const rel of cp.filesChanged) {
        const source = join(dir, rel);
        const dest = join(this.workingDir, rel);
        try {
          if (existsSync(source)) {
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(source, dest);
            filesRestored.push(rel);
          } else if (existsSync(dest)) {
            // File was created in that turn; delete it
            rmSync(dest, { force: true });
            filesRestored.push(rel);
          }
        } catch (e) {
          errors.push(`${rel}: ${(e as Error).message}`);
        }
      }
    }

    return { restored: cp, filesRestored, errors };
  }

  /** Remove the oldest checkpoints beyond MAX_CHECKPOINTS. */
  prune(): number {
    if (this.checkpoints.length <= MAX_CHECKPOINTS) return 0;
    const removeCount = this.checkpoints.length - MAX_CHECKPOINTS;
    const removed = this.checkpoints.splice(0, removeCount);
    for (const cp of removed) {
      if (cp.mode === 'file') {
        try { rmSync(join(this.storageDir, cp.id), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    this.saveIndex();
    return removeCount;
  }

  format(): string {
    if (this.checkpoints.length === 0) return 'No checkpoints yet.';
    const lines = ['Checkpoints (newest first):'];
    for (const cp of this.list()) {
      lines.push(
        `  ${cp.id}  turn ${cp.turnNumber}  ${cp.mode}  ${cp.filesChanged.length} files  $${cp.costUsd.toFixed(4)}`
        + `\n    "${cp.summary}"`,
      );
    }
    return lines.join('\n');
  }

  private loadIndex(): void {
    if (!existsSync(this.indexPath)) { this.checkpoints = []; return; }
    try {
      this.checkpoints = JSON.parse(readFileSync(this.indexPath, 'utf-8'));
    } catch {
      this.checkpoints = [];
    }
  }

  private saveIndex(): void {
    atomicWrite(this.indexPath, JSON.stringify(this.checkpoints, null, 2));
  }
}
