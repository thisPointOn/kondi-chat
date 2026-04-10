/**
 * Telemetry — opt-in, local-only, schema-enforced usage metrics.
 *
 * v1 does not ship any network code. Events accumulate in
 * `.kondi-chat/telemetry.json` (separate from analytics.json). Users must
 * explicitly run `/telemetry enable` before any event is recorded.
 *
 * The schema is a closed union; unknown fields are rejected at emit time to
 * uphold the privacy claim. No prompts, paths, URLs, or free text allowed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type FeatureId =
  | 'session_started' | 'session_resumed' | 'undo_invoked'
  | 'checkpoint_created' | 'checkpoint_restored'
  | 'sub_agent_spawned' | 'hook_executed' | 'web_search'
  | 'image_uploaded' | 'memory_loaded' | 'memory_updated'
  | 'council_invoked' | 'non_interactive_run' | 'profile_changed';

export type ToolCategoryId =
  | 'filesystem_read' | 'filesystem_write' | 'filesystem_edit'
  | 'search_code' | 'run_command' | 'create_task' | 'update_plan'
  | 'git' | 'web' | 'mcp' | 'council' | 'update_memory' | 'spawn_agent';

export type ErrorCategoryId =
  | 'llm_timeout' | 'llm_rate_limit' | 'llm_auth'
  | 'network' | 'permission_denied' | 'tool_error' | 'config_error'
  | 'provider_fallback' | 'backend_crash';

export type TelemetryEvent =
  | { kind: 'feature_used'; feature: FeatureId; timestamp: string }
  | { kind: 'tool_called'; tool: ToolCategoryId; succeeded: boolean; timestamp: string }
  | { kind: 'error_occurred'; category: ErrorCategoryId; recoverable: boolean; timestamp: string };

export type TelemetryState = 'disabled' | 'local-only' | 'remote-enabled';

interface PersistedTelemetry {
  state: TelemetryState;
  installationId?: string;
  events: TelemetryEvent[];
}

const FEATURE_SET = new Set<FeatureId>([
  'session_started', 'session_resumed', 'undo_invoked',
  'checkpoint_created', 'checkpoint_restored',
  'sub_agent_spawned', 'hook_executed', 'web_search',
  'image_uploaded', 'memory_loaded', 'memory_updated',
  'council_invoked', 'non_interactive_run', 'profile_changed',
]);

const TOOL_SET = new Set<ToolCategoryId>([
  'filesystem_read', 'filesystem_write', 'filesystem_edit',
  'search_code', 'run_command', 'create_task', 'update_plan',
  'git', 'web', 'mcp', 'council', 'update_memory', 'spawn_agent',
]);

const ERROR_SET = new Set<ErrorCategoryId>([
  'llm_timeout', 'llm_rate_limit', 'llm_auth',
  'network', 'permission_denied', 'tool_error', 'config_error',
  'provider_fallback', 'backend_crash',
]);

const MAX_EVENTS = 10_000;

export class TelemetryEmitter {
  private path: string;
  private data: PersistedTelemetry;

  constructor(storageDir: string) {
    this.path = join(storageDir, 'telemetry.json');
    this.data = this.load();
    // Environment override (Spec 15 clarifications): force disabled + delete.
    if (process.env.KONDI_CHAT_NO_TELEMETRY === '1') {
      this.data.state = 'disabled';
      this.data.events = [];
      this.save();
    }
  }

  getState(): TelemetryState { return this.data.state; }

  setState(state: TelemetryState): void {
    this.data.state = state;
    if (state === 'disabled') this.data.events = [];
    this.save();
  }

  enable(): void { this.setState('local-only'); }
  disable(): void { this.setState('disabled'); }

  /** Record an event if telemetry is not disabled. Unknown fields are rejected. */
  record(event: TelemetryEvent): void {
    if (this.data.state === 'disabled') return;
    if (!this.validate(event)) {
      process.stderr.write(`[telemetry] rejected malformed event: ${JSON.stringify(event)}\n`);
      return;
    }
    this.data.events.push(event);
    if (this.data.events.length > MAX_EVENTS) {
      this.data.events = this.data.events.slice(-MAX_EVENTS);
    }
    this.save();
  }

  export(): string {
    return JSON.stringify(this.data, null, 2);
  }

  deleteAll(): void {
    this.data.events = [];
    this.save();
  }

  format(): string {
    const lines = [`Telemetry state: ${this.data.state}`];
    if (this.data.state === 'disabled') {
      lines.push('  (no events recorded)');
      lines.push('  enable with: /telemetry enable');
      return lines.join('\n');
    }
    const counts: Record<string, number> = {};
    for (const e of this.data.events) {
      const key = e.kind === 'feature_used' ? `feature:${e.feature}`
                : e.kind === 'tool_called' ? `tool:${e.tool}`
                : `error:${e.category}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    lines.push(`Total events: ${this.data.events.length}`);
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${k.padEnd(40)} ${v}`);
    }
    return lines.join('\n');
  }

  private validate(event: TelemetryEvent): boolean {
    switch (event.kind) {
      case 'feature_used': return FEATURE_SET.has(event.feature);
      case 'tool_called': return TOOL_SET.has(event.tool) && typeof event.succeeded === 'boolean';
      case 'error_occurred': return ERROR_SET.has(event.category) && typeof event.recoverable === 'boolean';
    }
    return false;
  }

  private load(): PersistedTelemetry {
    if (!existsSync(this.path)) {
      return { state: 'disabled', events: [] };
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.state) return raw as PersistedTelemetry;
    } catch { /* fall through */ }
    return { state: 'disabled', events: [] };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch (e) {
      process.stderr.write(`[telemetry] save failed: ${(e as Error).message}\n`);
    }
  }
}
