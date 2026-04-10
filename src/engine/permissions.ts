/**
 * Permission System — safety gate in front of every tool execution.
 *
 * Tiers:
 *   - auto-approve   : execute immediately
 *   - confirm        : ask the user once; may be escalated to session-approve
 *   - always-confirm : ask every time, cannot be auto-approved from config
 *
 * The backend calls `check()` to classify, then `requestPermission()` to
 * emit a `permission_request` to the TUI and await a response. Responses
 * come back through `handleResponse()` from the TUI's `permission_response`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export type PermissionTier = 'auto-approve' | 'confirm' | 'always-confirm';
export type PermissionDecision = 'approved' | 'denied' | 'approved-session';

export interface PermissionConfig {
  defaultTier: PermissionTier;
  tools: Record<string, PermissionTier>;
  alwaysConfirmPatterns: string[];
  sessionOverrides?: Record<string, PermissionTier>;
}

const DEFAULT_TOOL_TIERS: Record<string, PermissionTier> = {
  read_file: 'auto-approve',
  list_files: 'auto-approve',
  search_code: 'auto-approve',
  update_plan: 'auto-approve',
  write_file: 'confirm',
  edit_file: 'confirm',
  run_command: 'confirm',
  create_task: 'confirm',
  update_memory: 'confirm',
  git_status: 'auto-approve',
  git_diff: 'auto-approve',
  git_log: 'auto-approve',
  git_commit: 'confirm',
  git_branch: 'confirm',
  git_create_pr: 'confirm',
  spawn_agent: 'confirm',
  web_search: 'auto-approve',
  web_fetch: 'confirm',
};

const DEFAULT_ALWAYS_CONFIRM_PATTERNS: string[] = [
  'rm\\s+(-[rfR]+\\s+|--recursive)',
  'git\\s+push\\s+(-f|--force|--force-with-lease)',
  'git\\s+push\\s+.*\\b(main|master)\\b',
  'git\\s+reset\\s+--hard',
  'chmod\\s+(777|000)',
  'sudo(\\s|$)',
  'curl.*\\|\\s*(sh|bash)',
  'dd\\s+',
  '>\\s*/dev/',
];

const DEFAULT_CONFIG: PermissionConfig = {
  defaultTier: 'confirm',
  tools: { ...DEFAULT_TOOL_TIERS },
  alwaysConfirmPatterns: DEFAULT_ALWAYS_CONFIRM_PATTERNS,
};

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  resolve: (d: PermissionDecision) => void;
  timeout: NodeJS.Timeout;
}

function fingerprint(tool: string, args: Record<string, unknown>): string {
  // Stable JSON by sorted keys
  const keys = Object.keys(args).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) normalized[k] = args[k];
  const s = tool + '::' + JSON.stringify(normalized);
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export class PermissionManager {
  private config: PermissionConfig;
  private skip: boolean;
  private patterns: RegExp[];
  private pending = new Map<string, Pending>();
  /** Session approvals: fingerprint -> approved */
  private sessionApprovals = new Set<string>();
  /** Auto-generated sequential id */
  private nextId = 0;

  constructor(configPath: string, skipPermissions = false) {
    this.skip = skipPermissions;
    this.config = loadConfig(configPath);
    this.patterns = this.config.alwaysConfirmPatterns.map(p => {
      try { return new RegExp(p); } catch { return null; }
    }).filter((r): r is RegExp => r !== null);
    if (skipPermissions) {
      process.stderr.write('[permissions] --dangerously-skip-permissions active; all tools auto-approved\n');
    }
  }

  /** Classify a tool call without prompting. */
  check(tool: string, args: Record<string, unknown>): PermissionTier {
    if (this.skip) return 'auto-approve';

    // always-confirm patterns apply to run_command's `command` arg
    if (tool === 'run_command') {
      const cmd = normalizeCommand(String(args.command ?? ''));
      for (const re of this.patterns) {
        if (re.test(cmd)) return 'always-confirm';
      }
    }

    // Session override wins for the tool
    const sessionTier = this.config.sessionOverrides?.[tool];
    if (sessionTier) return sessionTier;

    const toolTier = this.config.tools[tool];
    if (toolTier) return toolTier;
    return this.config.defaultTier;
  }

  /**
   * Request permission: if tier is auto-approve or session-approved, resolve
   * immediately; otherwise emit a permission_request and await a response.
   */
  async requestPermission(
    tool: string,
    args: Record<string, unknown>,
    emit: (event: any) => void,
  ): Promise<PermissionDecision> {
    if (this.skip) return 'approved';
    const tier = this.check(tool, args);
    if (tier === 'auto-approve') return 'approved';

    const fp = fingerprint(tool, args);
    if (tier !== 'always-confirm' && this.sessionApprovals.has(fp)) return 'approved';

    const id = `perm-${Date.now()}-${this.nextId++}`;
    emit({
      type: 'permission_request',
      id,
      tool,
      args: JSON.stringify(args).slice(0, 2000),
      summary: summarize(tool, args),
      tier,
    });

    return new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        emit({ type: 'permission_timeout', id, tool });
        resolve('denied');
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timeout });
    }).then(decision => {
      if (decision === 'approved-session' && tier !== 'always-confirm') {
        this.sessionApprovals.add(fp);
      }
      return decision;
    });
  }

  /** Handle a response from the TUI. Duplicate/unknown ids are ignored. */
  handleResponse(id: string, decision: PermissionDecision): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(id);
    p.resolve(decision);
  }
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

function summarize(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'run_command': return `Run shell command: ${String(args.command || '').slice(0, 200)}`;
    case 'write_file': return `Write file: ${String(args.path || '')}`;
    case 'edit_file': return `Edit file: ${String(args.path || '')}`;
    case 'create_task': return `Dispatch task: ${String(args.description || '').slice(0, 160)}`;
    case 'update_memory': return `Update ${String(args.scope || '')} memory (${String(args.operation || '')})`;
    default: return `${tool}(${JSON.stringify(args).slice(0, 160)})`;
  }
}

function loadConfig(configPath: string): PermissionConfig {
  if (!existsSync(configPath)) {
    // Write out defaults on first run so users can customize
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    } catch { /* non-fatal */ }
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      defaultTier: raw.defaultTier || DEFAULT_CONFIG.defaultTier,
      tools: { ...DEFAULT_TOOL_TIERS, ...(raw.tools || {}) },
      alwaysConfirmPatterns: raw.alwaysConfirmPatterns || DEFAULT_ALWAYS_CONFIRM_PATTERNS,
      sessionOverrides: raw.sessionOverrides,
    };
  } catch (e) {
    process.stderr.write(`[permissions] Failed to parse ${configPath}: ${(e as Error).message}; using defaults\n`);
    return { ...DEFAULT_CONFIG };
  }
}
