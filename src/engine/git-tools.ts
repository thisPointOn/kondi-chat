/**
 * Git Tools — first-class git awareness.
 *
 * detectGitRepo() shells out to git and returns a plain snapshot the
 * backend caches for prompt injection and the TUI status bar.
 * Mutating tools refresh the snapshot after execution.
 */

import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.ts';
import { computeUnifiedDiff } from './diff.ts';

const GIT_TIMEOUT_MS = 15_000;

export interface GitContext {
  isGitRepo: boolean;
  branch: string;
  dirtyCount: number;
  untrackedCount: number;
  stagedCount: number;
  lastCommitHash: string;
  lastCommitMessage: string;
  hasRemote: boolean;
  remoteUrl?: string;
  isWorktree: boolean;
}

function gitQ(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function tryGit(cmd: string, cwd: string): string {
  try { return gitQ(cmd, cwd); } catch { return ''; }
}

export function detectGitRepo(workingDir: string): GitContext {
  const empty: GitContext = {
    isGitRepo: false, branch: '', dirtyCount: 0, untrackedCount: 0, stagedCount: 0,
    lastCommitHash: '', lastCommitMessage: '', hasRemote: false, isWorktree: false,
  };
  const isRepo = tryGit('git rev-parse --is-inside-work-tree', workingDir);
  if (isRepo !== 'true') return empty;

  const branch = tryGit('git rev-parse --abbrev-ref HEAD', workingDir) || 'HEAD';
  const status = tryGit('git status --porcelain', workingDir);
  let dirty = 0, untracked = 0, staged = 0;
  for (const line of status.split('\n')) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') untracked++;
    else {
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ') dirty++;
    }
  }

  const lastHash = tryGit('git rev-parse --short HEAD', workingDir);
  const lastMsg = tryGit('git log -1 --pretty=%s', workingDir);
  const remoteUrl = tryGit('git config --get remote.origin.url', workingDir);
  const gitDir = tryGit('git rev-parse --git-dir', workingDir);
  const commonDir = tryGit('git rev-parse --git-common-dir', workingDir);
  const isWorktree = gitDir !== '' && commonDir !== '' && gitDir !== commonDir && gitDir !== '.git';

  return {
    isGitRepo: true,
    branch,
    dirtyCount: dirty,
    untrackedCount: untracked,
    stagedCount: staged,
    lastCommitHash: lastHash,
    lastCommitMessage: lastMsg,
    hasRemote: remoteUrl !== '',
    remoteUrl: remoteUrl || undefined,
    isWorktree,
  };
}

export function formatGitContextForPrompt(ctx: GitContext): string {
  if (!ctx.isGitRepo) return '';
  const parts: string[] = [];
  parts.push(`Branch: ${ctx.branch}${ctx.isWorktree ? ' (worktree)' : ''}`);
  parts.push(`Status: ${ctx.stagedCount} staged, ${ctx.dirtyCount} modified, ${ctx.untrackedCount} untracked`);
  if (ctx.lastCommitHash) parts.push(`Last commit: ${ctx.lastCommitHash} ${ctx.lastCommitMessage}`);
  if (ctx.remoteUrl) parts.push(`Remote: ${ctx.remoteUrl}`);
  return `## Git\n${parts.join('\n')}`;
}

export const GIT_TOOLS: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Show the current git status: branch, modified files, staged files, untracked files.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Show the git diff for staged or unstaged changes. Optionally filter to a single file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to diff (optional)' },
        staged: { type: 'boolean', description: 'Show staged changes only (default false)' },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Create a git commit. Stages the listed files first; errors if no files provided.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files to stage before committing' },
      },
      required: ['message', 'files'],
    },
  },
  {
    name: 'git_log',
    description: 'Show recent git log entries.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits to show (default 10)' },
      },
    },
  },
  {
    name: 'git_branch',
    description: 'List branches, or create/switch to a branch.',
    parameters: {
      type: 'object',
      properties: {
        create: { type: 'string', description: 'Create and switch to this new branch' },
        switch: { type: 'string', description: 'Switch to this existing branch' },
      },
    },
  },
  {
    name: 'git_create_pr',
    description: 'Create a GitHub pull request for the current branch via the gh CLI.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR body' },
        base: { type: 'string', description: 'Base branch (default main)' },
        draft: { type: 'boolean', description: 'Create as draft PR' },
      },
      required: ['title'],
    },
  },
];

export async function executeGitTool(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  ctx: GitContext,
): Promise<{ content: string; isError?: boolean; diff?: string }> {
  if (!ctx.isGitRepo) {
    return { content: 'Not a git repository', isError: true };
  }
  try {
    switch (name) {
      case 'git_status': {
        const out = gitQ('git status --short --branch', workingDir);
        return { content: out || '(clean)' };
      }
      case 'git_diff': {
        const path = args.path ? ` -- ${JSON.stringify(String(args.path))}` : '';
        const staged = args.staged ? ' --cached' : '';
        const out = gitQ(`git diff${staged}${path}`, workingDir);
        if (!out) return { content: '(no changes)' };
        const truncated = out.length > 5000 ? out.slice(0, 5000) + '\n... (truncated)' : out;
        return { content: truncated, diff: truncated };
      }
      case 'git_log': {
        const count = Math.max(1, Math.min(50, (args.count as number) || 10));
        const out = gitQ(`git log -n ${count} --oneline --decorate`, workingDir);
        return { content: out || '(no commits)' };
      }
      case 'git_branch': {
        const create = args.create as string | undefined;
        const sw = args.switch as string | undefined;
        if (create) {
          if (!/^[\w./-]+$/.test(create)) return { content: `Invalid branch name: ${create}`, isError: true };
          gitQ(`git checkout -b ${JSON.stringify(create)}`, workingDir);
          return { content: `Created and switched to ${create}` };
        }
        if (sw) {
          if (!/^[\w./-]+$/.test(sw)) return { content: `Invalid branch name: ${sw}`, isError: true };
          gitQ(`git checkout ${JSON.stringify(sw)}`, workingDir);
          return { content: `Switched to ${sw}` };
        }
        const out = gitQ('git branch -vv', workingDir);
        return { content: out };
      }
      case 'git_commit': {
        const message = String(args.message || '').trim();
        if (!message) return { content: 'Empty commit message', isError: true };
        if (message.split('\n')[0].length > 500) {
          return { content: 'Commit subject exceeds 500 characters', isError: true };
        }
        const files = args.files as string[] | undefined;
        if (!files || files.length === 0) {
          return { content: 'git_commit requires a non-empty `files` list', isError: true };
        }
        // Stage explicitly listed files (deletions included).
        const quoted = files.map(f => JSON.stringify(f)).join(' ');
        gitQ(`git add -- ${quoted}`, workingDir);
        // Use --cleanup=strip and -F - via env-free execSync: pass message via -m (single arg, escaped).
        gitQ(`git commit -m ${JSON.stringify(message)}`, workingDir);
        const hash = tryGit('git rev-parse --short HEAD', workingDir);
        return { content: `Committed ${hash}: ${message.split('\n')[0]}` };
      }
      case 'git_create_pr': {
        if (ctx.branch === 'main' || ctx.branch === 'master') {
          return { content: `Refusing to PR from ${ctx.branch}. Create a feature branch first.`, isError: true };
        }
        try { gitQ('gh --version', workingDir); }
        catch { return { content: 'gh CLI not found. Install from https://cli.github.com/', isError: true }; }
        const title = String(args.title || '').trim();
        if (!title) return { content: 'PR title required', isError: true };
        const body = String(args.body || '');
        const base = String(args.base || 'main');
        const draft = args.draft ? ' --draft' : '';
        const out = gitQ(
          `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --base ${JSON.stringify(base)}${draft}`,
          workingDir,
        );
        return { content: out };
      }
    }
    return { content: `Unknown git tool: ${name}`, isError: true };
  } catch (e) {
    const err = e as any;
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    return { content: `${err.message}\n${stderr || stdout}`.trim(), isError: true };
  }
}

// `computeUnifiedDiff` is re-exported for callers that think of git diffs
// as a single namespace. The canonical implementation lives in ./diff.ts.
export { computeUnifiedDiff };
