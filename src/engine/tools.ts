/**
 * Agent Tools — tools available to the frontier model during conversation.
 *
 * The orchestrator calls executeTool() when the model emits a tool_use.
 * Each tool is a bounded operation: read a file, search code, run a command,
 * create a task card, or update the session plan.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';

/** Safely check if a path is within a base directory */
function isPathSafe(base: string, fullPath: string): boolean {
  const rel = relative(base, fullPath);
  return !rel.startsWith('..') && !resolve(fullPath).includes('\0');
}
import { execSync, execFileSync } from 'node:child_process';
import type { ToolDefinition, Session, TaskKind } from '../types.ts';
import type { Ledger } from '../audit/ledger.ts';
import { runPipeline, type PipelineConfig } from './pipeline.ts';
import { computeUnifiedDiff } from './diff.ts';
import type { MemoryManager } from '../context/memory.ts';
import type { PermissionManager } from './permissions.ts';
import type { LoopGuard } from './loop-guard.ts';

// ---------------------------------------------------------------------------
// Tool definitions (provider-agnostic JSON Schema)
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'create_task',
    description: 'Create a task card for a coding change and execute it. Use this when the user wants code written, fixed, refactored, or tested. The task goes through: dispatch → execute → verify → reflect.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Clear description of what code change to make',
        },
        kind: {
          type: 'string',
          description: 'Type of task (e.g., implementation, fix, refactor, test, analysis — or any custom kind)',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'consult',
    description:
      'Ask a specialized domain expert (aerospace engineer, security auditor, database ' +
      'architect, etc.) for an opinion on a specific question. Use this when the problem ' +
      'has a clear domain angle that would benefit from an expert perspective — DO NOT use ' +
      'it for routine coding questions, trivia, or tasks you can handle yourself. ' +
      'Consultants are pure text-in/text-out: they see only the question and optional ' +
      'context you pass, not the full conversation or your tool history. ' +
      'Call with an empty role to list available consultants. Consultant definitions live ' +
      'in .kondi-chat/consultants.json and can be edited by the user.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description:
            'Machine id of the consultant (e.g. "aerospace-engineer", "security-auditor"). ' +
            'Omit or pass empty string to list every available consultant and their descriptions.',
        },
        question: {
          type: 'string',
          description:
            'The specific question you want the expert to answer. Be concrete — "is this retraction sequence safe under loss-of-hydraulic-pressure?" beats "is this safe?".',
        },
        context: {
          type: 'string',
          description:
            'Optional extra context: relevant code snippet, design summary, constraints, ' +
            'prior decisions. Keep it focused — the consultant cannot read files itself.',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the working directory.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the working directory',
        },
        max_lines: {
          type: 'number',
          description: 'Maximum number of lines to return (default: 200)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in the working directory.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to list (default: root)',
        },
        recursive: {
          type: 'boolean',
          description: 'List recursively (default: false)',
        },
      },
    },
  },
  {
    name: 'search_code',
    description: 'Search for a pattern in code files using grep.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Relative path to search in (default: .)',
        },
        glob: {
          type: 'string',
          description: 'File glob filter (e.g., "*.ts", "*.py")',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the working directory. Use for tests, builds, linting, or other local operations.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to run',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'update_plan',
    description: 'Update the session plan and working state. Use this to track goals, decisions, and constraints as the conversation evolves.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Current high-level goal' },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key decisions made',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Constraints to respect',
        },
        plan: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered steps in the current plan',
        },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Use for creating new files or full replacements.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the working directory',
        },
        content: {
          type: 'string',
          description: 'The full file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'spawn_agent',
    description: 'Spawn a bounded sub-agent to handle a focused sub-task. `research` can read and search; `worker` can read/write/edit/run commands; `planner` has no tools and just reasons about the instruction. Sub-agents do not nest.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['research', 'worker', 'planner'], description: 'Sub-agent role' },
        instruction: { type: 'string', description: 'Clear, bounded task for the sub-agent' },
      },
      required: ['type', 'instruction'],
    },
  },
  {
    name: 'update_memory',
    description: 'Update a KONDI.md memory file to record project conventions, decisions, or preferences. Scope "project" writes to <workingDir>/KONDI.md; "user" writes to ~/.kondi-chat/KONDI.md.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'user'], description: 'Which memory file to update' },
        operation: { type: 'string', enum: ['append', 'replace'], description: 'Append to the existing file or overwrite it' },
        content: { type: 'string', description: 'Markdown content to append or write' },
      },
      required: ['scope', 'operation', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing a specific string with new content. The old_string must match exactly (including whitespace).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from the working directory',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to find and replace',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution context
// ---------------------------------------------------------------------------

export interface ToolContext {
  workingDir: string;
  session: Session;
  ledger: Ledger;
  pipelineConfig: PipelineConfig;
  /** Spec 04 — optional memory store for KONDI.md files. */
  memoryManager?: MemoryManager;
  /** Spec 04 — callback to update ContextManager's active-file anchor for subdir memory. */
  setActiveFile?: (path: string) => void;
  /** Spec 01 — permission gate, consulted before every tool dispatch. */
  permissionManager?: PermissionManager;
  /** Spec 01 — used by permission requests to push events to the TUI. */
  emit?: (event: any) => void;
  /** Spec 05 — files mutated during the current turn (write_file / edit_file). */
  mutatedFiles?: Set<string>;
  /** Spec 07 — used by spawn_agent to run bounded child agent loops. */
  spawnSubAgent?: (type: 'research' | 'worker' | 'planner', instruction: string) => Promise<string>;
  /** Spec 08 — current-turn loop guard for tools that want to inspect status. */
  loopGuard?: LoopGuard;
  /** Domain-expert consultants loaded from .kondi-chat/consultants.json. */
  consultants?: import('./consultants.ts').Consultant[];
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  /** Spec 03 — unified diff populated by write_file / edit_file. */
  diff?: string;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    switch (name) {
      case 'create_task':
        return await toolCreateTask(args, ctx);
      case 'consult': {
        const { executeConsult } = await import('./consultants.ts');
        return await executeConsult(args, ctx.consultants ?? [], ctx.ledger, ctx.workingDir);
      }
      case 'read_file':
        return await toolReadFile(args, ctx);
      case 'list_files':
        return toolListFiles(args, ctx);
      case 'search_code':
        return toolSearchCode(args, ctx);
      case 'run_command':
        return toolRunCommand(args, ctx);
      case 'update_plan':
        return toolUpdatePlan(args, ctx);
      case 'write_file':
        return await toolWriteFile(args, ctx);
      case 'edit_file':
        return await toolEditFile(args, ctx);
      case 'update_memory':
        return toolUpdateMemory(args, ctx);
      case 'spawn_agent':
        return await toolSpawnAgent(args, ctx);
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { content: `Tool error: ${(error as Error).message}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolCreateTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const description = args.description as string;

  let result;
  try {
    result = await runPipeline(description, ctx.session, ctx.ledger, ctx.pipelineConfig);
  } catch (e) {
    const { PipelineError } = await import('./errors.ts');
    if (e instanceof PipelineError) {
      // Structured pipeline failure — tell the model which stage broke
      // and whether it's worth retrying.
      return {
        content:
          `create_task failed at stage "${e.stage}" (${e.severity}): ${e.message}\n\n` +
          (e.severity === 'recoverable'
            ? 'This is recoverable — consider adjusting the task description or reading related files first.'
            : 'This is fatal — the pipeline cannot complete this task as described. Consider a different approach.'),
        isError: true,
      };
    }
    return {
      content: `create_task failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }

  const summary = [
    `Task ${result.task.id} (${result.task.kind}): ${result.task.status}`,
    result.promoted ? '(promoted to frontier after failures)' : '',
    '',
    result.reflection,
    '',
    result.verification
      ? `Verification: ${result.verification.passed ? 'PASSED' : 'FAILED'}`
      : 'Verification: skipped',
  ].filter(Boolean).join('\n');

  return { content: summary };
}

async function toolReadFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const relPath = args.path as string;
  const maxLines = (args.max_lines as number) || 200;
  const base = resolve(ctx.workingDir);
  const fullPath = resolve(join(ctx.workingDir, relPath));

  if (!isPathSafe(base, fullPath)) {
    return { content: `Path traversal blocked: ${relPath}`, isError: true };
  }

  ctx.setActiveFile?.(relPath);
  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { content: `File not found: ${relPath}`, isError: true };
    return { content: `Read failed: ${e?.message || String(e)}`, isError: true };
  }
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    return {
      content: lines.slice(0, maxLines).join('\n') + `\n\n... (${lines.length - maxLines} more lines)`,
    };
  }
  return { content };
}

function toolListFiles(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { content: string; isError?: boolean } {
  const relPath = (args.path as string) || '.';
  const recursive = (args.recursive as boolean) || false;
  const base = resolve(ctx.workingDir);
  const fullPath = resolve(join(ctx.workingDir, relPath));

  if (!isPathSafe(base, fullPath)) {
    return { content: `Path traversal blocked: ${relPath}`, isError: true };
  }
  if (!existsSync(fullPath)) {
    return { content: `Directory not found: ${relPath}`, isError: true };
  }

  // process.stderr.write(`[tool] list_files: ${relPath}${recursive ? ' (recursive)' : ''}\n`);

  if (recursive) {
    try {
      const output = execSync(
        `find . -maxdepth 4 -type f ` +
        `-not -path '*/node_modules/*' -not -path '*/.git/*' ` +
        `-not -path '*/target/*' -not -path '*/__pycache__/*' ` +
        `-not -path '*/.next/*' -not -path '*/dist/*' ` +
        `| sort | head -100`,
        { cwd: fullPath, encoding: 'utf-8', timeout: 10_000 },
      ).trim();
      return { content: output || '(empty directory)' };
    } catch {
      return { content: '(failed to list files)', isError: true };
    }
  }

  const entries = readdirSync(fullPath);
  const formatted = entries.map(entry => {
    const entryPath = join(fullPath, entry);
    try {
      const stat = statSync(entryPath);
      return stat.isDirectory() ? `${entry}/` : entry;
    } catch {
      return entry;
    }
  });
  return { content: formatted.join('\n') || '(empty directory)' };
}

function toolSearchCode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { content: string; isError?: boolean } {
  const pattern = args.pattern as string;
  const relPath = (args.path as string) || '.';
  const glob = args.glob as string | undefined;
  const base = resolve(ctx.workingDir);
  const searchPath = resolve(join(ctx.workingDir, relPath));

  if (!isPathSafe(base, searchPath)) {
    return { content: `Path traversal blocked: ${relPath}`, isError: true };
  }

  // process.stderr.write(`[tool] search_code: "${pattern}" in ${relPath}\n`);

  // Sanitize glob (defense-in-depth even though execFileSync skips the shell).
  const safeGlob = glob ? glob.replace(/[^a-zA-Z0-9.*?_\-\/]/g, '') : '';
  const grepArgs: string[] = [
    '-rnE',                       // recursive, line numbers, extended regex
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
  ];
  if (safeGlob) grepArgs.push(`--include=${safeGlob}`);
  grepArgs.push('-e', pattern, searchPath);

  try {
    const raw = execFileSync('grep', grepArgs, {
      encoding: 'utf-8',
      timeout: 15_000,
      cwd: ctx.workingDir,
      maxBuffer: 4 * 1024 * 1024,
    });
    const lines = raw.split('\n');
    const head = lines.slice(0, 50).join('\n').trim();
    return { content: head || 'No matches found.' };
  } catch (error: any) {
    // grep returns exit code 1 for no matches.
    if (error.status === 1) {
      return { content: 'No matches found.' };
    }
    // Exit 2 = invalid regex / IO error. Surface a useful message rather
    // than the raw shell complaint so the model can correct its pattern.
    if (error.status === 2) {
      return {
        content: `Invalid regex: ${pattern} — grep -E rejected it. Try escaping special chars or use search_files for a literal lookup.`,
        isError: true,
      };
    }
    return { content: `Search error: ${error.message}`, isError: true };
  }
}

function toolRunCommand(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { content: string; isError?: boolean } {
  const command = args.command as string;
  const timeout = (args.timeout as number) || 30_000;

  // process.stderr.write(`[tool] run_command: ${command}\n`);

  try {
    const output = execSync(command, {
      cwd: ctx.workingDir,
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = output.trim().slice(-4000);
    return { content: trimmed || '(no output)' };
  } catch (error: any) {
    const stdout = error.stdout?.toString() || '';
    const stderr = error.stderr?.toString() || '';
    const combined = `${stdout}\n${stderr}`.trim().slice(-4000);
    return { content: `Exit code ${error.status ?? 'unknown'}:\n${combined || error.message}`, isError: true };
  }
}

function toolUpdatePlan(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { content: string } {
  const state = ctx.session.state;

  if (args.goal !== undefined) state.goal = args.goal as string;
  if (args.decisions !== undefined) state.decisions = args.decisions as string[];
  if (args.constraints !== undefined) state.constraints = args.constraints as string[];
  if (args.plan !== undefined) state.currentPlan = args.plan as string[];

  // process.stderr.write(`[tool] update_plan: goal="${state.goal}"\n`);

  const summary = [
    `Goal: ${state.goal || '(not set)'}`,
    `Plan: ${state.currentPlan.join(' → ') || '(none)'}`,
    `Decisions: ${state.decisions.join('; ') || '(none)'}`,
    `Constraints: ${state.constraints.join('; ') || '(none)'}`,
  ].join('\n');

  return { content: `Plan updated.\n${summary}` };
}

async function toolWriteFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const relPath = args.path as string;
  const content = args.content as string;
  const base = resolve(ctx.workingDir);
  const fullPath = resolve(join(ctx.workingDir, relPath));

  if (!isPathSafe(base, fullPath)) {
    return { content: `Path traversal blocked: ${relPath}`, isError: true };
  }

  const existed = existsSync(fullPath);
  let originalContent = '';
  if (existed) {
    try { originalContent = await readFile(fullPath, 'utf-8'); } catch { originalContent = ''; }
    const backupDir = join(ctx.workingDir, '.kondi-chat', 'backups', 'latest');
    const backupPath = join(backupDir, relPath);
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(fullPath, backupPath);
  }

  try {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  } catch (e: any) {
    return { content: `Write failed: ${e?.message || String(e)}`, isError: true };
  }
  ctx.setActiveFile?.(relPath);
  ctx.mutatedFiles?.add(relPath);

  const d = computeUnifiedDiff(relPath, originalContent, content);
  return {
    content: `${existed ? 'Updated' : 'Created'} ${relPath} (+${d.linesAdded}/-${d.linesRemoved})`,
    diff: d.diff || undefined,
  };
}

async function toolEditFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const relPath = args.path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const base = resolve(ctx.workingDir);
  const fullPath = resolve(join(ctx.workingDir, relPath));

  if (!isPathSafe(base, fullPath)) {
    return { content: `Path traversal blocked: ${relPath}`, isError: true };
  }

  let original: string;
  try {
    original = await readFile(fullPath, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { content: `File not found: ${relPath}`, isError: true };
    return { content: `Read failed: ${e?.message || String(e)}`, isError: true };
  }

  // Check the old_string exists
  const idx = original.indexOf(oldString);
  if (idx === -1) {
    return { content: `old_string not found in ${relPath}. Make sure it matches exactly (including whitespace).`, isError: true };
  }

  // Check it's unique
  const secondIdx = original.indexOf(oldString, idx + 1);
  if (secondIdx !== -1) {
    return { content: `old_string matches multiple locations in ${relPath}. Provide more context to make it unique.`, isError: true };
  }

  // Backup
  const backupDir = join(ctx.workingDir, '.kondi-chat', 'backups', 'latest');
  const backupPath = join(backupDir, relPath);
  try {
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(fullPath, backupPath);
  } catch (e: any) {
    return { content: `Backup failed: ${e?.message || String(e)}`, isError: true };
  }

  // Apply edit
  const updated = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
  try {
    await writeFile(fullPath, updated);
  } catch (e: any) {
    return { content: `Write failed: ${e?.message || String(e)}`, isError: true };
  }
  ctx.setActiveFile?.(relPath);
  ctx.mutatedFiles?.add(relPath);

  const d = computeUnifiedDiff(relPath, original, updated);
  return {
    content: `Edited ${relPath} (+${d.linesAdded}/-${d.linesRemoved})`,
    diff: d.diff || undefined,
  };
}

async function toolSpawnAgent(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const type = args.type as 'research' | 'worker' | 'planner';
  const instruction = args.instruction as string;
  if (!ctx.spawnSubAgent) {
    return { content: 'spawn_agent is not available in this context (no sub-agent runner)', isError: true };
  }
  if (!['research', 'worker', 'planner'].includes(type)) {
    return { content: `Invalid sub-agent type: ${type}`, isError: true };
  }
  if (!instruction) {
    return { content: 'spawn_agent requires a non-empty instruction', isError: true };
  }
  try {
    const result = await ctx.spawnSubAgent(type, instruction);
    return { content: result };
  } catch (e) {
    return { content: `spawn_agent failed: ${(e as Error).message}`, isError: true };
  }
}

function toolUpdateMemory(
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolExecutionResult {
  const scope = args.scope as 'project' | 'user';
  const operation = args.operation as 'append' | 'replace';
  const content = args.content as string;
  if (!ctx.memoryManager) {
    return { content: 'Memory manager not available', isError: true };
  }
  if (scope !== 'project' && scope !== 'user') {
    return { content: `Invalid scope: ${scope} (expected 'project' or 'user')`, isError: true };
  }
  if (operation !== 'append' && operation !== 'replace') {
    return { content: `Invalid operation: ${operation} (expected 'append' or 'replace')`, isError: true };
  }
  const { path } = ctx.memoryManager.updateMemory(scope, operation, content);
  // Track memory file mutations for checkpoint coverage (Spec 05 clarification).
  if (ctx.mutatedFiles) {
    try {
      const rel = relative(ctx.workingDir, path);
      if (!rel.startsWith('..')) ctx.mutatedFiles.add(rel);
    } catch { /* ignore */ }
  }
  return { content: `Memory ${operation} → ${path}` };
}
