#!/usr/bin/env npx tsx
/**
 * kondi-chat backend — communicates with the Rust TUI via JSON-RPC over stdio.
 *
 * Reads commands from stdin (one JSON per line).
 * Writes events to stdout (one JSON per line).
 * All the LLM routing, tools, MCP, council logic runs here.
 */

import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import type { ProviderId, Session, LLMMessage } from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';
import { ContextManager, createSession } from '../context/manager.ts';
import { MemoryManager } from '../context/memory.ts';
import { bootstrapDirectory } from '../context/bootstrap.ts';
import { Ledger, estimateCost } from '../audit/ledger.ts';
import { AGENT_TOOLS, type ToolContext } from '../engine/tools.ts';
import { PermissionManager } from '../engine/permissions.ts';
import { detectGitRepo, formatGitContextForPrompt, GIT_TOOLS, executeGitTool, type GitContext } from '../engine/git-tools.ts';
import { CheckpointManager, isMutatingToolCall, predictedMutations } from '../engine/checkpoints.ts';
import { SessionStore, AUTO_SAVE_MS } from '../session/store.ts';
import { Router as UnifiedRouter } from '../router/index.ts';
import { ProfileManager } from '../router/profiles.ts';
import { LoopGuard } from '../engine/loop-guard.ts';
import { McpClientManager } from '../mcp/client.ts';
import { loadMcpConfig } from '../mcp/config.ts';
import { ToolManager } from '../mcp/tool-manager.ts';
import { CouncilProfileManager } from '../council/profiles.ts';
import { COUNCIL_TOOL, executeCouncil } from '../council/tool.ts';
import { RoutingCollector } from '../router/collector.ts';
import { Analytics } from '../audit/analytics.ts';

const MAX_TOOL_ITERATIONS = 20;

// ── Helpers ──────────────────────────────────────────────────────────

function emit(event: any) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const workingDir = process.cwd();
  const storageDir = resolve(workingDir, '.kondi-chat');
  mkdirSync(storageDir, { recursive: true });

  // Spec 06 — session resume
  const sessionStore = new SessionStore(storageDir);
  sessionStore.cleanup();
  const resumeIdx = process.argv.indexOf('--resume');
  let session: Session;
  let resumed = false;
  let resumedSummary = '';
  let restoredProfile: string | undefined;
  let restoredOverrideModel: string | undefined;
  if (resumeIdx >= 0) {
    const nextArg = process.argv[resumeIdx + 1];
    const persisted = nextArg && !nextArg.startsWith('--')
      ? sessionStore.load(nextArg)
      : sessionStore.loadLatest(workingDir);
    if (persisted) {
      session = persisted.session;
      resumed = true;
      resumedSummary = `${session.messages.length} messages, $${session.totalCostUsd.toFixed(4)}`;
      restoredProfile = persisted.activeProfile;
      restoredOverrideModel = persisted.overrideModel;
    } else {
      session = createSession('openai' as ProviderId, undefined, workingDir);
    }
  } else {
    session = createSession('openai' as ProviderId, undefined, workingDir);
  }
  const ledger = new Ledger(session.id, storageDir);
  const analytics = new Analytics(storageDir);
  const router = new UnifiedRouter(storageDir, { useIntent: true });
  const registry = router.registry;
  const collector = router.collector;
  const profiles = new ProfileManager((restoredProfile as any) || 'balanced', storageDir);
  router.rules.setProfile(profiles.getActive());
  if (restoredOverrideModel) {
    const m = registry.getById(restoredOverrideModel) || registry.getByAlias(restoredOverrideModel);
    if (m) router.rules.setOverride(m);
  }

  const mcpClient = new McpClientManager();
  const mcpConfigs = loadMcpConfig(workingDir);
  if (mcpConfigs.size > 0) {
    await mcpClient.connectAll(mcpConfigs);
  }
  const toolManager = new ToolManager(mcpClient);

  const councilProfiles = new CouncilProfileManager(storageDir);
  const councilPath = resolve(workingDir, '../kondi-council');
  toolManager.registerTool(COUNCIL_TOOL, async (args) => {
    return executeCouncil(args.profile as string, args.brief as string, [], workingDir, councilPath, councilProfiles);
  });

  // Bootstrap
  const ctx = await bootstrapDirectory(workingDir, 'light');
  if (ctx) session.groundingContext = ctx;

  const memoryManager = new MemoryManager(workingDir);
  const contextManager = new ContextManager(session, { contextBudget: 30_000 }, ledger, memoryManager);

  // Spec 02 — git context (refreshed after mutating tools and once per turn).
  let gitCtx: GitContext = detectGitRepo(workingDir);
  contextManager.setGitContextText(formatGitContextForPrompt(gitCtx));
  const refreshGit = () => {
    gitCtx = detectGitRepo(workingDir);
    contextManager.setGitContextText(formatGitContextForPrompt(gitCtx));
  };
  for (const tool of GIT_TOOLS) {
    toolManager.registerTool(tool, async (args, _toolCtx) => {
      const res = await executeGitTool(tool.name, args, workingDir, gitCtx);
      refreshGit();
      return res;
    });
  }

  const checkpointManager = new CheckpointManager(workingDir, session.id, storageDir);

  const skipPermissions = process.argv.includes('--dangerously-skip-permissions');
  const permissionManager = new PermissionManager(
    join(storageDir, 'permissions.json'),
    skipPermissions,
  );

  const toolCtx: ToolContext = {
    workingDir,
    session,
    ledger,
    pipelineConfig: {
      provider: session.activeProvider,
      model: session.activeModel,
      router,
      collector,
      promotionThreshold: 2,
      workingDir,
      autoVerify: true,
    },
    memoryManager,
    setActiveFile: (p: string) => contextManager.setActiveFile(p),
    permissionManager,
    emit,
  };

  // Health check
  await registry.checkHealth();
  const available = registry.getAvailable();

  emit({
    type: 'ready',
    models: available.map(m => m.alias || m.id),
    mode: profiles.getActive().name,
    status: resumed
      ? `resumed ${session.id.slice(0, 8)} (${resumedSummary}) | mode: ${profiles.getActive().name}`
      : `${available.length} models | mode: ${profiles.getActive().name}`,
    git_info: gitCtx.isGitRepo ? {
      branch: gitCtx.branch,
      dirty_count: gitCtx.dirtyCount + gitCtx.untrackedCount,
      last_commit: gitCtx.lastCommitHash,
    } : null,
    resumed,
    resumed_session_id: resumed ? session.id : null,
    resumed_message_count: resumed ? session.messages.length : null,
  });

  sessionStore.setActive(session.id);
  sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id);
  const saveInterval = setInterval(() => {
    try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); }
    catch (e) { process.stderr.write(`[session-save] ${(e as Error).message}\n`); }
  }, AUTO_SAVE_MS);
  const saveAndExit = () => {
    try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); } catch { /* ignore */ }
    clearInterval(saveInterval);
  };
  process.on('SIGTERM', () => { saveAndExit(); process.exit(0); });
  process.on('SIGINT', () => { saveAndExit(); process.exit(0); });

  // Spec 13 — fatal handlers flush session state before crashing out
  process.on('uncaughtException', (err) => {
    try { emit({ type: 'error', message: `Uncaught: ${err.message}`, recoverable: false }); } catch { /* ignore */ }
    saveAndExit();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    try { emit({ type: 'error', message: `Unhandled rejection: ${String(reason)}`, recoverable: false }); } catch { /* ignore */ }
    saveAndExit();
    process.exit(1);
  });

  // Spec 13 — integrate any recovery partial left by a prior crashed run
  const recovered = sessionStore.checkForRecovery(session.id);
  if (recovered?.content) {
    session.messages.push({
      role: 'assistant',
      content: `${recovered.content}\n\n[recovered from crash]`,
      timestamp: recovered.savedAt,
    });
    sessionStore.clearRecovery(session.id);
  }

  // ── Handle commands from TUI ───────────────────────────────────────

  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line: string) => {
    let cmd: any;
    try { cmd = JSON.parse(line); } catch { return; }

    if (cmd.type === 'quit') {
      saveAndExit();
      await mcpClient.disconnectAll();
      process.exit(0);
    }

    if (cmd.type === 'permission_response') {
      permissionManager.handleResponse(cmd.id, cmd.decision);
      return;
    }

    if (cmd.type === 'command') {
      const output = await handleCommand(cmd.text, session, contextManager, ledger, registry, collector, toolCtx, mcpClient, toolManager, workingDir, profiles, router, councilProfiles, councilPath, analytics, checkpointManager, sessionStore);
      emit({ type: 'command_result', output });
      return;
    }

    if (cmd.type === 'submit') {
      refreshGit();
      toolCtx.mutatedFiles = new Set();
      await handleSubmit(cmd.text, session, contextManager, ledger, router, collector, toolCtx, toolManager, profiles, checkpointManager);
      try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); } catch { /* ignore */ }
      return;
    }
  });
}

// ── Submit handler (agent loop) ──────────────────────────────────────

async function handleSubmit(
  input: string,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  router: UnifiedRouter,
  collector: RoutingCollector,
  toolCtx: ToolContext,
  toolManager: ToolManager,
  profiles: ProfileManager,
  checkpointManager: CheckpointManager,
) {
  const turnNumber = session.messages.filter(m => m.role === 'user').length + 1;
  let checkpointCreated = false;
  // @mention check
  const mentionMatch = input.match(/^@(\S+)\s+([\s\S]+)/);
  if (mentionMatch) {
    const alias = mentionMatch[1];
    const message = mentionMatch[2];
    const targetModel = router.registry.getByAlias(alias);
    if (!targetModel) {
      emit({ type: 'error', message: `Unknown model: @${alias}` });
      return;
    }

    contextManager.addUserMessage(input);
    const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();
    emit({ type: 'status', text: `@${alias} thinking...` });

    const response = await callLLM({
      provider: targetModel.provider,
      model: targetModel.id,
      systemPrompt, userMessage,
      maxOutputTokens: 8192, cacheablePrefix,
    });

    const cost = estimateCost(response.model, response.inputTokens, response.outputTokens);
    const msgId = `msg-${Date.now()}`;
    contextManager.addAssistantMessage(response);
    ledger.record('discuss', response, message.slice(0, 200));

    emit({ type: 'message', id: msgId, role: 'assistant', content: response.content, model_label: targetModel.alias || targetModel.name });
    emit({ type: 'message_update', id: msgId, stats: {
      input_tokens: response.inputTokens, output_tokens: response.outputTokens,
      cost_usd: cost, models: [response.model], provider: targetModel.provider,
      route_reason: `@${targetModel.alias}`, iterations: 1,
    }});
    return;
  }

  // Regular agent loop
  contextManager.addUserMessage(input);
  const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();
  const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

  let totalInputTokens = 0, totalOutputTokens = 0, totalCost = 0;
  let finalContent = '';
  let respondingModel = '';
  let respondingProvider = '';
  let respondingReason = '';
  const allToolCalls: any[] = [];
  const modelsUsed = new Set<string>();

  const msgId = `msg-${Date.now()}`;
  emit({ type: 'message', id: msgId, role: 'assistant', content: '', model_label: '...' });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const decision = await router.select('discuss', userMessage, undefined, iteration);
    respondingModel = decision.model.alias || decision.model.name;
    respondingProvider = decision.model.provider;
    respondingReason = decision.reason;
    emit({ type: 'status', text: `${respondingModel} thinking${iteration > 0 ? ` (step ${iteration + 1})` : ''}...` });
    emit({ type: 'activity', text: `${respondingModel} — ${decision.reason}`, activity_type: 'step' });
    emit({ type: 'message_update', id: msgId, model_label: respondingModel });

    const response = await callLLM({
      provider: decision.model.provider,
      model: decision.model.id,
      systemPrompt, messages,
      tools: toolManager.getTools('discuss'),
      maxOutputTokens: 8192, cacheablePrefix,
    });

    const iterCost = estimateCost(response.model, response.inputTokens, response.outputTokens);
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    totalCost += iterCost;
    modelsUsed.add(response.model);

    ledger.record('discuss', response, messages[messages.length - 1]?.content?.slice(0, 200) || '');

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content;
      break;
    }

    messages.push({ role: 'assistant', content: response.content || undefined, toolCalls: response.toolCalls });

    const toolResults = [];
    for (const tc of response.toolCalls) {
      const toolArgs = formatToolArgs(tc);
      emit({ type: 'tool_call', name: tc.name, args: toolArgs, is_error: false });
      emit({ type: 'activity', text: `${tc.name}(${toolArgs})`, activity_type: 'tool' });

      // Spec 05 — create a checkpoint before the first mutating tool in this turn.
      if (!checkpointCreated && isMutatingToolCall(tc.name, tc.arguments)) {
        try {
          const predicted = new Set([
            ...(toolCtx.mutatedFiles ?? []),
            ...predictedMutations(tc.name, tc.arguments),
          ]);
          checkpointManager.create(
            `Turn ${turnNumber}: ${input.slice(0, 60)}`,
            input,
            turnNumber,
            totalCost,
            predicted,
          );
          checkpointCreated = true;
        } catch (e) {
          emit({ type: 'error', message: `Checkpoint failed: ${(e as Error).message}` });
        }
      }

      const result = await toolManager.execute(tc.name, tc.arguments, toolCtx);
      const capped = result.content.length > 3000 ? result.content.slice(0, 3000) + '...' : result.content;

      allToolCalls.push({
        name: tc.name,
        args: toolArgs,
        result: capped.slice(0, 300),
        is_error: result.isError || false,
        diff: result.diff,
      });
      emit({ type: 'message_update', id: msgId, content: response.content || '', tool_calls: [...allToolCalls] });

      toolResults.push({ toolCallId: tc.id, content: capped, isError: result.isError, diff: result.diff });
    }

    messages.push({ role: 'tool', toolResults });

    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      finalContent = response.content || `Completed ${allToolCalls.length} tool calls.`;
    }
  }

  // Append file modification summary
  const filesModified = allToolCalls
    .filter(tc => ['write_file', 'edit_file', 'create_task'].includes(tc.name) && !tc.is_error)
    .map(tc => {
      if (tc.name === 'create_task') return `  ✦ task: ${tc.args}`;
      return `  ${tc.name === 'write_file' ? '+' : '~'} ${tc.args}`;
    });
  if (filesModified.length > 0) {
    finalContent += '\n\nFiles:\n' + filesModified.join('\n');
  }

  contextManager.addAssistantMessage({
    content: finalContent, model: respondingModel,
    provider: 'openai' as ProviderId,
    inputTokens: totalInputTokens, outputTokens: totalOutputTokens, latencyMs: 0,
  });

  emit({ type: 'message_update', id: msgId,
    content: finalContent,
    model_label: respondingModel,
    tool_calls: allToolCalls.length > 0 ? allToolCalls : null,
    stats: {
      input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      cost_usd: totalCost, models: [...modelsUsed],
      provider: respondingProvider,
      route_reason: respondingReason,
      iterations: messages.filter(m => m.role === 'assistant').length || 1,
    },
  });

  emit({ type: 'status', text: '' });
  await contextManager.maybeCompact();
  await contextManager.updateSessionState();
}

// ── Slash commands ───────────────────────────────────────────────────

async function handleCommand(
  input: string, session: Session, contextManager: ContextManager,
  ledger: Ledger, registry: any, collector: any, toolCtx: ToolContext,
  mcpClient: McpClientManager, toolManager: ToolManager, workingDir: string,
  profiles: ProfileManager, router: UnifiedRouter,
  councilProfiles: CouncilProfileManager, councilPath: string,
  analytics: Analytics,
  checkpointManager: CheckpointManager,
  sessionStore: SessionStore,
): Promise<string> {
  // Import the actual command handler from main.tsx would be circular,
  // so we duplicate the essential commands here
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/mode': {
      const mode = parts[1];
      if (!mode) return profiles.format();
      try {
        profiles.setProfile(mode as any);
        router.rules.setProfile(profiles.getActive());
        return `Mode: ${profiles.getActive().name}`;
      } catch (e) { return (e as Error).message; }
    }
    case '/use': {
      const alias = parts[1];
      if (!alias) return router.rules.getOverride()
        ? `Using: ${router.rules.getOverride()!.alias || router.rules.getOverride()!.id}`
        : 'Router: auto';
      if (alias === 'auto') { router.rules.setOverride(undefined); return 'Router: auto'; }
      const model = registry.getByAlias(alias);
      if (!model) return `Unknown: ${alias}. Available: ${registry.getAliases().join(', ')}`;
      router.rules.setOverride(model);
      return `Using: ${model.name} (@${model.alias})`;
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
      for (const [m, d] of Object.entries(totals.byModel).sort((a, b) => (b[1] as any).costUsd - (a[1] as any).costUsd)) {
        lines.push(`  ${m}: ${(d as any).calls} calls $${(d as any).costUsd.toFixed(4)}`);
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
    case '/help': return [
      '/mode [quality|balanced|cheap|<custom>]', '/use <alias>', '/use auto',
      '/models', '/health', '/routing', '/status', '/cost',
      '/analytics [days|rebuild|export]',
      '/council [list|run <profile> <brief>]', '/mcp',
      '/checkpoints', '/undo [N|<id>]',
      '/help', '/quit',
    ].join('\n');
    default: return `Unknown: ${cmd}. Try /help`;
  }
}

function formatToolArgs(tc: any): string {
  const args = tc.arguments;
  switch (tc.name) {
    case 'read_file': return String(args.path || '');
    case 'list_files': return String(args.path || '.');
    case 'search_code': return `"${args.pattern}"`;
    case 'run_command': return String(args.command || '').slice(0, 60);
    case 'create_task': return String(args.description || '').slice(0, 60);
    case 'update_plan': return args.goal ? `goal="${String(args.goal).slice(0, 40)}"` : '...';
    default: return JSON.stringify(args).slice(0, 60);
  }
}

main().catch(err => {
  emit({ type: 'error', message: err.message });
  process.exit(1);
});
