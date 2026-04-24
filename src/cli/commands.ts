/**
 * Slash command dispatcher for the TUI backend.
 *
 * Split out of backend.ts to shrink the god-object. Every command handler
 * is a branch of one switch statement; the runtime dependencies it
 * reaches for are bundled into a single `CommandDeps` param instead of
 * 20 positional args. Keep this file free of startup wiring and stdin
 * plumbing — its only job is: given the typed deps and a command
 * string, return the string to display.
 *
 * Two side effects the handlers can produce beyond their return value:
 *   - Calling `deps.emit(...)` to push a TUI event (used by /use and
 *     /mode so the model indicator refreshes without a turn).
 *   - Mutating shared state on `deps.profiles`, `deps.router`,
 *     `deps.checkpointManager`, etc. — these are live references, not
 *     snapshots, so changes persist for the rest of the session.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session, ImageAttachment } from '../types.ts';
import type { Ledger } from '../audit/ledger.ts';
import type { ContextManager } from '../context/manager.ts';
import type { ModelRegistry } from '../router/registry.ts';
import type { RoutingCollector } from '../router/collector.ts';
import type { ProfileManager } from '../router/profiles.ts';
import type { Router as UnifiedRouter } from '../router/index.ts';
import type { CouncilProfileManager } from '../council/profiles.ts';
import { executeCouncil } from '../council/tool.ts';
import type { Analytics } from '../audit/analytics.ts';
import type { CheckpointManager } from '../engine/checkpoints.ts';
import type { SessionStore } from '../session/store.ts';
import type { RateLimiter } from '../providers/rate-limiter.ts';
import type { TelemetryEmitter } from '../audit/telemetry.ts';
import type { ToolContext } from '../engine/tools.ts';
import type { McpClientManager } from '../mcp/client.ts';
import type { ToolManager } from '../mcp/tool-manager.ts';
import { saveMcpServer, removeMcpServer } from '../mcp/config.ts';
import { formatHelp } from './help.ts';
import { writeActiveProfile } from './wizard.ts';
import { pickCompressionModel } from './submit-helpers.ts';

export interface CommandDeps {
  session: Session;
  contextManager: ContextManager;
  ledger: Ledger;
  registry: ModelRegistry;
  collector: RoutingCollector;
  toolCtx: ToolContext;
  mcpClient: McpClientManager;
  toolManager: ToolManager;
  workingDir: string;
  profiles: ProfileManager;
  router: UnifiedRouter;
  councilProfiles: CouncilProfileManager;
  councilPath: string;
  analytics: Analytics;
  checkpointManager: CheckpointManager;
  sessionStore: SessionStore;
  rateLimiter: RateLimiter;
  pendingImages: ImageAttachment[];
  telemetry: TelemetryEmitter;
  /** Push a live event back to the TUI. */
  emit: (event: Record<string, unknown>) => void;
}

export async function handleCommand(input: string, deps: CommandDeps): Promise<string> {
  const {
    session, contextManager, ledger, registry, collector, toolCtx,
    mcpClient, toolManager, workingDir,
    profiles, router, councilProfiles, councilPath, analytics,
    checkpointManager, sessionStore, rateLimiter, pendingImages, telemetry, emit,
  } = deps;

  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/mode-details': {
      // Show full config for a profile. No arg = active profile.
      const name = parts[1] || profiles.getActive().name;
      const all = profiles.getAll();
      const p = all[name];
      if (!p) return `Unknown profile: ${name}. Available: ${profiles.getNames().join(', ')}`;

      // Build a model roster: collect all unique models from rolePinning
      // and resolve their registry entries for display.
      const modelIds = new Set<string>();
      if (p.rolePinning) {
        for (const id of Object.values(p.rolePinning)) modelIds.add(id as string);
      }
      // Also find models from allowed providers that aren't pinned.
      const allowed = p.allowedProviders;
      if (allowed && allowed.length > 0) {
        for (const m of registry.getEnabled()) {
          if (allowed.includes(m.provider)) modelIds.add(m.id);
        }
      }

      const lines: string[] = [
        `═══ ${p.name}${p.name === profiles.getActive().name ? ' (active)' : ''} ═══`,
        p.description,
        '',
      ];

      // Models in this profile
      if (modelIds.size > 0) {
        lines.push('── Models ────────────────────────────────────────────');
        for (const id of modelIds) {
          const m = registry.getById(id);
          if (m) {
            const alias = m.alias ? `@${m.alias}` : '';
            const cost = m.inputCostPer1M === 0 && m.outputCostPer1M === 0
              ? 'free'
              : `$${m.inputCostPer1M}/$${m.outputCostPer1M} per 1M`;
            // Find which phases this model is pinned to
            const phases: string[] = [];
            if (p.rolePinning) {
              for (const [phase, pinId] of Object.entries(p.rolePinning)) {
                if (pinId === id) phases.push(phase);
              }
            }
            const phaseStr = phases.length > 0 ? ` ← ${phases.join(', ')}` : '';
            lines.push(`  ${m.name} ${alias} (${m.provider}, ${cost})${phaseStr}`);
            lines.push(`    capabilities: ${m.capabilities.join(', ')}`);
          } else {
            lines.push(`  ${id} (not in registry)`);
          }
        }
        lines.push('');
      }

      // Role assignments
      if (p.rolePinning && Object.keys(p.rolePinning).length > 0) {
        lines.push('── Phase → Model ─────────────────────────────────────');
        for (const [phase, modelId] of Object.entries(p.rolePinning)) {
          const m = registry.getById(modelId as string);
          const label = m ? `${m.name} @${m.alias || m.id}` : modelId;
          lines.push(`  ${(phase as string).padEnd(14)} → ${label}`);
        }
        lines.push('');
      }

      // Settings
      lines.push('── Settings ──────────────────────────────────────────');
      lines.push(`  Context budget:    ${p.contextBudget.toLocaleString()} tokens`);
      lines.push(`  Loop caps:         ${p.loopIterationCap} iterations, $${p.loopCostCap.toFixed(2)}`);
      lines.push(`  Max output tokens: ${p.maxOutputTokens.toLocaleString()}`);
      lines.push(`  Prefer local:      ${p.preferLocal ? 'yes' : 'no'}`);
      lines.push(`  Reflection:        ${p.includeReflection ? 'yes' : 'no'}`);
      lines.push(`  Verification:      ${p.includeVerification ? 'yes' : 'no'}`);
      lines.push(`  Promotion after:   ${p.promotionThreshold} failures`);
      if (allowed && allowed.length > 0) {
        lines.push(`  Allowed providers: ${allowed.join(', ')}`);
      }

      // Capability preferences
      lines.push('');
      lines.push('── Capability Preferences ────────────────────────────');
      lines.push(`  Planning:  [${p.planningPreference.join(', ')}]`);
      lines.push(`  Execution: [${p.executionPreference.join(', ')}]`);
      lines.push(`  Review:    [${p.reviewPreference.join(', ')}]`);

      return lines.join('\n');
    }
    case '/mode': {
      const mode = parts[1];
      if (!mode) return profiles.format();
      try {
        profiles.setProfile(mode);
        router.rules.setProfile(profiles.getActive());
        // Reapply profile scope to intent router + compression model so
        // switching to/from zai updates everything in one shot.
        const p = profiles.getActive();
        const cheap = pickCompressionModel(registry, p);
        if (cheap) contextManager.setCompressionModel(cheap.provider, cheap.id);
        router.setProfileScope({
          allowedProviders: p.allowedProviders,
          classifier: cheap ? { provider: cheap.provider, model: cheap.id } : undefined,
          rolePinning: p.rolePinning,
        });
        writeActiveProfile(resolve(workingDir, '.kondi-chat'), profiles.getActive().name);
        // If there's no manual override, let the indicator reflect the
        // new profile name until the next turn resolves a concrete model.
        if (!router.rules.getOverride()) {
          emit({ type: 'model_override', label: profiles.getActive().name, pinned: false });
        }
        return `Mode: ${profiles.getActive().name}`;
      } catch (e) { return (e as Error).message; }
    }
    case '/use': {
      const alias = parts[1];
      if (!alias) return router.rules.getOverride()
        ? `Using: ${router.rules.getOverride()!.alias || router.rules.getOverride()!.id}`
        : 'Router: auto';
      if (alias === 'auto') {
        router.rules.setOverride(undefined);
        emit({ type: 'model_override', label: profiles.getActive().name, pinned: false });
        return 'Router: auto';
      }
      const model = registry.getByAlias(alias);
      if (!model) {
        const candidates: string[] = registry.findAliasCandidates(alias);
        const hint = candidates.length > 1
          ? ` — ambiguous, could be: ${candidates.map((a: string) => `@${a}`).join(', ')}`
          : ` — available: ${registry.getAliases().join(', ')}`;
        return `Unknown: ${alias}${hint}`;
      }
      router.rules.setOverride(model);
      emit({ type: 'model_override', label: model.alias || model.id, pinned: true });
      return `Using: ${model.name} (@${model.alias})`;
    }
    case '/consultants': {
      const roster = toolCtx.consultants ?? [];
      if (roster.length === 0) return 'No consultants configured. Edit .kondi-chat/consultants.json to add some.';
      const lines: string[] = ['Available consultants:', ''];
      for (const c of roster) {
        lines.push(`  ${c.role}`);
        lines.push(`    ${c.name} (${c.provider}/${c.model})`);
        lines.push(`    ${c.description}`);
        lines.push('');
      }
      lines.push('Edit .kondi-chat/consultants.json to add, remove, or tune them.');
      return lines.join('\n');
    }
    case '/models': return registry.format();
    case '/health': { await registry.checkHealth(); return registry.formatHealth(); }
    case '/routing': return collector.formatStats();
    case '/status': {
      const budget = contextManager.getBudgetStatus();
      return [
        `Session: ${session.id.slice(0, 8)}`,
        `Tokens: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out`,
        `Cost: $${session.totalCostUsd.toFixed(4)}`,
        `Context: ${budget.currentContextSize.toLocaleString()}/${budget.modelContextWindow.toLocaleString()} (${(budget.contextUtilization * 100).toFixed(0)}%)`,
      ].join('\n');
    }
    case '/cost': {
      const totals = ledger.getTotals();
      if (totals.calls === 0) return 'No calls yet.';
      const lines = [`Total: ${totals.calls} calls | $${totals.costUsd.toFixed(4)}`];
      type ModelTotal = { calls: number; costUsd: number };
      const byModel = totals.byModel as Record<string, ModelTotal>;
      for (const [m, d] of Object.entries(byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
        lines.push(`  ${m}: ${d.calls} calls $${d.costUsd.toFixed(4)}`);
      }
      return lines.join('\n');
    }
    case '/council': {
      if (!parts[1] || parts[1] === 'list') return councilProfiles.format();
      if (parts[1] === 'run' && parts[2]) {
        const brief = parts.slice(3).join(' ');
        if (!brief) return 'Usage: /council run <profile> <brief>';
        const result = await executeCouncil(parts[2], brief, [], workingDir, councilPath, councilProfiles);
        return result.content;
      }
      return 'Usage: /council [list|run <profile> <brief>]';
    }
    case '/analytics': {
      const days = parts[1] ? parseInt(parts[1]) : 30;
      if (parts[1] === 'rebuild') { analytics.rebuild(); return 'Analytics rebuilt from all ledger files.'; }
      if (parts[1] === 'export') { return analytics.exportAll(); }
      return analytics.format(days);
    }
    case '/attach': {
      const p = parts.slice(1).join(' ');
      if (!p) return 'Usage: /attach <path to image>';
      try {
        const abs = resolve(workingDir, p);
        const buf = readFileSync(abs);
        const MAX_BYTES = 10 * 1024 * 1024;
        if (buf.byteLength > MAX_BYTES) return `Image too large: ${buf.byteLength} > 10MB`;
        if (pendingImages.length >= 5) return 'Already 5 images queued for next message.';
        const ext = (p.split('.').pop() || '').toLowerCase();
        const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
        const mimeType = mime[ext];
        if (!mimeType) return `Unsupported image type: .${ext}`;
        pendingImages.push({
          mimeType,
          base64: buf.toString('base64'),
          originalPath: p,
          sizeBytes: buf.byteLength,
        });
        return `Attached ${p} (${mimeType}, ${buf.byteLength} bytes). Queued ${pendingImages.length}/5 for next message.`;
      } catch (e) {
        return `Attach failed: ${(e as Error).message}`;
      }
    }
    case '/telemetry': {
      const sub = parts[1] || 'status';
      if (sub === 'enable') { telemetry.enable(); return 'Telemetry: local-only (no network). Run /telemetry details to see the schema.'; }
      if (sub === 'disable') { telemetry.disable(); return 'Telemetry: disabled (local events cleared).'; }
      if (sub === 'delete') { telemetry.deleteAll(); return 'Telemetry: all local events deleted.'; }
      if (sub === 'export') { return telemetry.export(); }
      if (sub === 'details') {
        return [
          'Telemetry records anonymous counters only. Allowed kinds:',
          '  feature_used   — enum counter (session_started, undo_invoked, …)',
          '  tool_called    — counter by category (filesystem_read, git, web, …)',
          '  error_occurred — counter by class (llm_timeout, permission_denied, …)',
          'NEVER recorded: prompts, responses, tool args, file paths, URLs, API keys.',
          'Storage: .kondi-chat/telemetry.json (local only). No network in v1.',
        ].join('\n');
      }
      return telemetry.format();
    }
    case '/rate-limits': return rateLimiter.format();
    case '/sessions': return sessionStore.format(workingDir);
    case '/resume': {
      if (!parts[1]) return 'Usage: /resume <session-id>';
      const p = sessionStore.load(parts[1]);
      if (!p) return `Session not found: ${parts[1]}`;
      return `To resume ${p.session.id.slice(0, 8)}, restart with:\n  kondi-chat --resume ${p.session.id}`;
    }
    case '/checkpoints': return checkpointManager.format();
    case '/undo': {
      const arg = parts[1];
      try {
        if (!arg) {
          const r = checkpointManager.restore(-1);
          return `Reverted ${r.restored.id} (turn ${r.restored.turnNumber}): ${r.restored.summary}\n  files: ${r.filesRestored.length}${r.errors.length ? `  errors: ${r.errors.join('; ')}` : ''}`;
        }
        if (/^\d+$/.test(arg)) {
          const n = parseInt(arg, 10);
          const r = checkpointManager.restore(-n);
          return `Reverted ${n} checkpoint(s) to ${r.restored.id} (turn ${r.restored.turnNumber}). Files: ${r.filesRestored.length}`;
        }
        const cp = checkpointManager.get(arg);
        if (!cp) return `Unknown checkpoint: ${arg}. Run /checkpoints to list.`;
        const r = checkpointManager.restore(arg);
        return `Restored ${r.restored.id}. Files: ${r.filesRestored.join(', ') || '(none)'}`;
      } catch (e) {
        return `Undo failed: ${(e as Error).message}`;
      }
    }
    case '/mcp': {
      const sub = parts[1];
      if (!sub) return mcpClient.format();
      if (sub === 'add' && parts[2]) {
        // /mcp add <name> <command> [args...]
        // /mcp add <name> http <url>
        const name = parts[2];
        if (parts[3] === 'http' || parts[3] === 'https') {
          const url = parts[4];
          if (!url) return 'Usage: /mcp add <name> http <url>';
          saveMcpServer(workingDir, name, { type: 'http', url } as any);
          await mcpClient.connect(name, { type: 'http', url, scope: 'project' } as any);
          return `Added HTTP MCP server: ${name} → ${url}`;
        }
        const command = parts[3];
        const args = parts.slice(4);
        if (!command) return 'Usage: /mcp add <name> <command> [args...]';
        saveMcpServer(workingDir, name, { command, args });
        await mcpClient.connect(name, { command, args, scope: 'project' } as any);
        return `Added stdio MCP server: ${name} → ${command} ${args.join(' ')}`;
      }
      if (sub === 'remove' && parts[2]) {
        const name = parts[2];
        await mcpClient.disconnect(name);
        const removed = removeMcpServer(workingDir, name) || removeMcpServer(workingDir, name, 'user');
        return removed ? `Removed MCP server: ${name}` : `Server not found in config: ${name}`;
      }
      if (sub === 'reconnect') {
        const name = parts[2];
        if (name) {
          const server = mcpClient.getServer(name);
          if (!server) return `Unknown server: ${name}`;
          await mcpClient.disconnect(name);
          await mcpClient.connect(name, server.config);
          return `Reconnected: ${name}`;
        }
        // Reconnect all
        const servers = mcpClient.getServers();
        for (const s of servers) {
          await mcpClient.disconnect(s.name);
          await mcpClient.connect(s.name, s.config);
        }
        return `Reconnected ${servers.length} server(s)`;
      }
      return 'Usage: /mcp [add <name> <command> [args...] | remove <name> | reconnect [name]]';
    }
    case '/tools': {
      const all = toolManager.getTools();
      const summary = toolManager.getSummary();
      const lines = [
        `Tools: ${all.length} total (${summary.builtIn} built-in, ${summary.mcp} MCP across ${summary.servers} server(s))`,
        '',
        ...all.map(t => `  ${t.name.padEnd(20)} ${(t.description || '').slice(0, 60)}`),
      ];
      return lines.join('\n');
    }
    case '/help': return formatHelp(parts[1]);
    default: return `Unknown: ${cmd}. Try /help`;
  }
}
