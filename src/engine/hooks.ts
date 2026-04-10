/**
 * Hooks — run shell commands or tool calls before/after any agent tool.
 *
 * Config lives at `.kondi-chat/hooks.json`. Keys: `before_<tool>` / `after_<tool>`.
 * Each hook is either a shorthand shell command string, a shell object, or a
 * tool-call object. Before-hooks can block execution; after-hooks augment the
 * tool result.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolExecutionResult } from './tools.ts';

export type HookFailureMode = 'block' | 'warn' | 'ignore';

export type HookDefinition =
  | string
  | {
      type?: 'shell' | 'tool';
      command?: string;
      tool?: string;
      args?: Record<string, unknown>;
      onFailure?: HookFailureMode;
      timeoutMs?: number;
    };

export interface HooksConfig {
  hooks?: Record<string, HookDefinition | HookDefinition[]>;
  builtin?: { autoFormat?: boolean };
  defaultFailureMode?: HookFailureMode;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAILURE_MODE: HookFailureMode = 'warn';
const MAX_HOOK_DEPTH = 3;

type ToolExecutor = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecutionResult>;

function shellQuote(s: string): string {
  // Single-quote everything, escape embedded single quotes.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    return shellQuote(String(v));
  });
}

export class HookRunner {
  private config: HooksConfig;
  private workingDir: string;
  private toolExecutor: ToolExecutor | null = null;
  private depth = 0;

  constructor(configPath: string, workingDir: string) {
    this.workingDir = workingDir;
    this.config = loadConfig(configPath);
    if (this.config.builtin?.autoFormat) this.installBuiltinFormatters();
  }

  setToolExecutor(fn: ToolExecutor): void { this.toolExecutor = fn; }

  async runBefore(tool: string, args: Record<string, unknown>, ctx: ToolContext, emit?: (e: any) => void): Promise<{ blocked: boolean; messages: string[] }> {
    const hooks = this.getHooks(`before_${tool}`);
    if (hooks.length === 0 || this.depth >= MAX_HOOK_DEPTH) return { blocked: false, messages: [] };
    const messages: string[] = [];
    for (const hook of hooks) {
      const outcome = await this.runHook(hook, tool, args, undefined, ctx, emit);
      if (outcome.blocked) return { blocked: true, messages: [outcome.message] };
      if (outcome.message) messages.push(outcome.message);
    }
    return { blocked: false, messages };
  }

  async runAfter(
    tool: string,
    args: Record<string, unknown>,
    result: ToolExecutionResult,
    ctx: ToolContext,
    emit?: (e: any) => void,
  ): Promise<ToolExecutionResult> {
    const hooks = this.getHooks(`after_${tool}`);
    if (hooks.length === 0 || this.depth >= MAX_HOOK_DEPTH) return result;
    let out = { ...result };
    for (const hook of hooks) {
      const outcome = await this.runHook(hook, tool, args, out, ctx, emit);
      if (outcome.blocked) {
        out = { ...out, isError: true, content: `${out.content}\n[after-hook blocked] ${outcome.message}` };
      } else if (outcome.message) {
        out = { ...out, content: `${out.content}\n[hook] ${outcome.message}` };
      }
    }
    return out;
  }

  private getHooks(key: string): HookDefinition[] {
    const raw = this.config.hooks?.[key];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  private async runHook(
    hook: HookDefinition,
    tool: string,
    args: Record<string, unknown>,
    result: ToolExecutionResult | undefined,
    ctx: ToolContext,
    emit?: (e: any) => void,
  ): Promise<{ blocked: boolean; message: string }> {
    const normalized = typeof hook === 'string' ? { type: 'shell' as const, command: hook } : hook;
    const onFailure: HookFailureMode = normalized.onFailure ?? this.config.defaultFailureMode ?? DEFAULT_FAILURE_MODE;
    const timeoutMs = normalized.timeoutMs ?? this.config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const vars: Record<string, unknown> = { ...args, cwd: this.workingDir };
    if (result) vars.result = result.content.slice(0, 2000);

    const started = Date.now();
    try {
      if (normalized.type === 'tool' || (!normalized.type && normalized.tool)) {
        if (!this.toolExecutor) throw new Error('Tool executor not wired');
        const toolName = normalized.tool!;
        this.depth++;
        try { await this.toolExecutor(toolName, normalized.args || {}, ctx); }
        finally { this.depth--; }
        emit?.({ type: 'activity', text: `${toolName} (${Date.now() - started}ms)`, activity_type: 'hook' });
        return { blocked: false, message: `tool:${toolName}` };
      }

      const template = normalized.command || (typeof hook === 'string' ? hook : '');
      if (!template) return { blocked: false, message: '' };
      const command = interpolate(template, vars);
      execSync(command, {
        cwd: this.workingDir,
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      emit?.({ type: 'activity', text: `${tool} (${Date.now() - started}ms)`, activity_type: 'hook' });
      return { blocked: false, message: `ok (${Date.now() - started}ms)` };
    } catch (e) {
      const msg = (e as Error).message;
      if (onFailure === 'block') return { blocked: true, message: `blocked: ${msg}` };
      if (onFailure === 'warn') return { blocked: false, message: `warn: ${msg}` };
      return { blocked: false, message: '' };
    }
  }

  private installBuiltinFormatters(): void {
    const wd = this.workingDir;
    const hooks: Record<string, HookDefinition | HookDefinition[]> = { ...(this.config.hooks || {}) };
    const add = (key: string, cmd: string) => {
      if (!hooks[key]) hooks[key] = cmd;
    };
    if (existsSync(join(wd, '.prettierrc')) || existsSync(join(wd, '.prettierrc.json'))) {
      add('after_write_file', 'npx prettier --write {path}');
      add('after_edit_file', 'npx prettier --write {path}');
    } else if (existsSync(join(wd, 'pyproject.toml'))) {
      add('after_write_file', 'black {path}');
      add('after_edit_file', 'black {path}');
    } else if (existsSync(join(wd, 'Cargo.toml'))) {
      add('after_write_file', 'rustfmt {path}');
      add('after_edit_file', 'rustfmt {path}');
    }
    this.config.hooks = hooks;
  }
}

function loadConfig(path: string): HooksConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HooksConfig;
  } catch (e) {
    process.stderr.write(`[hooks] failed to parse ${path}: ${(e as Error).message}\n`);
    return {};
  }
}
