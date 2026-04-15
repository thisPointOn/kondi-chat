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
import { RateLimiter, loadRateLimitConfig, setRateLimiter } from '../providers/rate-limiter.ts';
import { HookRunner } from '../engine/hooks.ts';
import { runSubAgent, formatSubAgentResult } from '../engine/sub-agents.ts';
import { WebToolsManager } from '../web/manager.ts';
import type { ImageAttachment } from '../types.ts';
import { Router as UnifiedRouter } from '../router/index.ts';
import { ProfileManager, type BudgetProfile } from '../router/profiles.ts';
import { LoopGuard } from '../engine/loop-guard.ts';
import { McpClientManager } from '../mcp/client.ts';
import { loadMcpConfig } from '../mcp/config.ts';
import { ToolManager } from '../mcp/tool-manager.ts';
import { CouncilProfileManager } from '../council/profiles.ts';
import { executeCouncil } from '../council/tool.ts';
import { RoutingCollector } from '../router/collector.ts';
import { Analytics } from '../audit/analytics.ts';
import { TelemetryEmitter } from '../audit/telemetry.ts';
import { runFirstRunWizard, checkForUpdate, readActiveProfile, writeActiveProfile } from './wizard.ts';
import { formatHelp } from './help.ts';

// Spec 08 — MAX_TOOL_ITERATIONS deleted; handleSubmit now uses LoopGuard
// driven by the active budget profile.

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

  // Spec 16 — first-run setup wizard (non-interactive; safe on every start).
  runFirstRunWizard(storageDir);
  // Spec 16 — async update check; swallow failures. Don't block startup.
  checkForUpdate('0.1.0').then(b => { if (b) emit({ type: 'status', text: b }); }).catch(() => {});

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
  const telemetry = new TelemetryEmitter(storageDir);
  telemetry.record({ kind: 'feature_used', feature: resumed ? 'session_resumed' : 'session_started', timestamp: new Date().toISOString() });
  const router = new UnifiedRouter(storageDir, { useIntent: true });
  const registry = router.registry;
  const collector = router.collector;
  // Profile precedence: --resume session > config.json default > 'balanced'.
  const initialProfile = restoredProfile || readActiveProfile(storageDir);
  const profiles = new ProfileManager(initialProfile as any, storageDir);
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
  const hookRunner = new HookRunner(join(storageDir, 'hooks.json'), workingDir);
  toolManager.setHookRunner(hookRunner);

  // Spec 11 — web tools (only enabled when BRAVE_SEARCH_API_KEY is present)
  const webTools = new WebToolsManager();
  if (webTools.isEnabled()) {
    for (const tool of webTools.getTools()) {
      toolManager.registerTool(tool, async (args) => webTools.executeTool(tool.name, args));
    }
  }

  const councilProfiles = new CouncilProfileManager(storageDir);
  const councilPath = resolve(workingDir, '../kondi-council');
  // Councils are expensive (fan out to multiple frontier models for
  // multi-round deliberation) and blocking (synchronous subprocess).
  // They must NEVER be auto-invokable by the agent — the model must not
  // see COUNCIL_TOOL in its toolset. Users reach councils only via the
  // explicit /council slash command in handleCommand.

  // Bootstrap
  const ctx = await bootstrapDirectory(workingDir, 'light');
  if (ctx) session.groundingContext = ctx;

  const memoryManager = new MemoryManager(workingDir);
  const contextManager = new ContextManager(
    session,
    { contextBudget: profiles.getActive().contextBudget },
    ledger,
    memoryManager,
  );
  // Pick a cheap, profile-appropriate compression model. When the active
  // profile restricts providers (e.g. zai), the compaction LLM call should
  // stay inside the filter. For unrestricted profiles, fall back to the
  // cheapest `summarization` model in the registry.
  const applyProfileScope = () => {
    const p = profiles.getActive();
    const cheap = pickCompressionModel(registry, p);
    if (cheap) contextManager.setCompressionModel(cheap.provider, cheap.id);
    router.setProfileScope({
      allowedProviders: p.allowedProviders,
      classifier: cheap ? { provider: cheap.provider, model: cheap.id } : undefined,
    });
  };
  applyProfileScope();

  // Spec 02 — git context (refreshed after mutating tools and once per turn).
  let gitCtx: GitContext = detectGitRepo(workingDir);
  contextManager.setGitContextText(formatGitContextForPrompt(gitCtx));
  const refreshGit = () => {
    gitCtx = detectGitRepo(workingDir);
    contextManager.setGitContextText(formatGitContextForPrompt(gitCtx));
  };
  // Push a git_info status event to the TUI so it can update the status bar.
  const emitGitInfo = () => {
    if (!gitCtx.isGitRepo) return;
    emit({
      type: 'status',
      text: '', // clear any stale status text
      git_info: {
        branch: gitCtx.branch,
        dirty_count: gitCtx.dirtyCount + gitCtx.untrackedCount,
        last_commit: gitCtx.lastCommitHash,
      },
    });
  };
  // Refresh git status every 5 seconds so external changes (editor saves,
  // git commands in another terminal) show up without waiting for a turn.
  if (gitCtx.isGitRepo) {
    setInterval(() => { refreshGit(); emitGitInfo(); }, 5000);
  }
  for (const tool of GIT_TOOLS) {
    toolManager.registerTool(tool, async (args, _toolCtx) => {
      const res = await executeGitTool(tool.name, args, workingDir, gitCtx);
      refreshGit();
      return res;
    });
  }

  // Spec 14 — rate limiter is a global singleton consulted from llm-caller.
  const rateLimiter = new RateLimiter(loadRateLimitConfig(storageDir));
  setRateLimiter(rateLimiter);

  const checkpointManager = new CheckpointManager(workingDir, session.id, storageDir);

  // Spec 09 — pending image attachments (from /attach). Flushed on next submit.
  const pendingImages: ImageAttachment[] = [];

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
    spawnSubAgent: async (type, instruction) => {
      emit({ type: 'activity', text: `spawn_agent(${type}): ${instruction.slice(0, 80)}`, activity_type: 'sub_agent' });
      const r = await runSubAgent(type, instruction, { router, toolManager, toolCtx, session });
      emit({ type: 'activity', text: `sub-agent ${type} done: ${r.iterations}it $${r.costUsd.toFixed(4)}`, activity_type: 'sub_agent' });
      return formatSubAgentResult(r);
    },
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

  // Telemetry-disabled startup banner removed — it rendered on every launch
  // and cluttered the status line. Users can discover /telemetry via /help.

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

  // ── Non-interactive mode (Spec 10) ─────────────────────────────────
  // When --prompt/--pipe/--json/--sessions are set, we run a single turn
  // and exit instead of entering the JSON-RPC event loop.
  const nonInteractive = parseNonInteractiveFlags(process.argv);
  if (nonInteractive) {
    const code = await runNonInteractiveTurn(
      nonInteractive, workingDir, session, contextManager, ledger, router,
      toolCtx, toolManager, profiles, checkpointManager, sessionStore,
      skipPermissions,
    );
    clearInterval(saveInterval);
    process.exit(code);
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
      const output = await handleCommand(cmd.text, session, contextManager, ledger, registry, collector, toolCtx, mcpClient, toolManager, workingDir, profiles, router, councilProfiles, councilPath, analytics, checkpointManager, sessionStore, rateLimiter, pendingImages, telemetry);
      emit({ type: 'command_result', output });
      refreshGit();
      emitGitInfo();
      return;
    }

    if (cmd.type === 'submit') {
      refreshGit();
      toolCtx.mutatedFiles = new Set();
      // Spec 09 — images arrive as an array of {mimeType, base64, originalPath?}
      // on the submit command. For v1 we just note them in the text so the
      // user's intent is visible to the model; full multimodal dispatch is
      // deferred (see IMPLEMENTATION-LOG.md).
      let input = cmd.text as string;
      const submitImages: ImageAttachment[] = [
        ...(Array.isArray(cmd.images) ? cmd.images : []),
        ...pendingImages,
      ];
      pendingImages.length = 0;
      if (submitImages.length > 0) {
        const notes = submitImages.map((img, i) =>
          `[image ${i + 1}${img.originalPath ? ` from ${img.originalPath}` : ''}: ${img.mimeType}, ${img.sizeBytes || 0} bytes]`
        ).join('\n');
        input = `${input}\n\n${notes}`;
      }
      await handleSubmit(input, session, contextManager, ledger, router, collector, toolCtx, toolManager, profiles, checkpointManager);
      try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); } catch { /* ignore */ }
      return;
    }
  });
}

// ── Submit handler (agent loop) ──────────────────────────────────────

/**
 * Classify a user message into a router phase. 'execute' picks a coding
 * model via the budget profile's executionPreference; 'discuss' picks a
 * reasoning/planning model. The intent router (LLM-based) will further
 * refine this inside Router.select(), but the phase decides which
 * preference list applies.
 */
/**
 * Stub tool results older than `keepLatest` iterations in place so they stop
 * costing input tokens on every subsequent LLM call inside an agent loop.
 *
 * Rationale: the ledger showed one user turn going 10k → 23k input tokens as
 * `read_file` / `search_code` results piled up in the messages array. Most
 * of that content is no longer load-bearing two iterations later — the model
 * has already read whatever mattered and moved on. We keep the last
 * `keepLatest` tool turns verbatim and collapse older ones into one-line
 * placeholders. Errors are never stubbed. `messages` is mutated in place;
 * it's a local buffer to handleSubmit, so there's no cross-turn leakage.
 */
function collapseOldToolResults(messages: LLMMessage[], keepLatest = 2, minLen = 300): number {
  let saved = 0;
  let keptToolTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool' || !m.toolResults) continue;
    if (keptToolTurns < keepLatest) {
      keptToolTurns++;
      continue;
    }
    for (const tr of m.toolResults) {
      if (tr.isError) continue;
      const origLen = (tr.content || '').length;
      if (origLen < minLen) continue;
      const stub = `[collapsed: ${origLen} chars from earlier iteration — content pruned to save context]`;
      saved += origLen - stub.length;
      tr.content = stub;
    }
  }
  return saved;
}

/** Cheap estimate of total message tokens (4 chars ≈ 1 token). */
function estimateMessagesTokens(messages: LLMMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    if (m.toolResults) for (const tr of m.toolResults) chars += (tr.content || '').length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Adaptive in-loop compaction. Escalates aggressiveness until the token
 * estimate is under the profile's contextBudget:
 *
 *   pass 1: keep 2 tool turns, stub anything ≥ 300 chars
 *   pass 2: keep 1 tool turn, stub anything ≥ 100 chars
 *   pass 3: keep 1 tool turn, stub anything ≥ 50 chars
 *
 * No LLM calls — pure local string manipulation. Returns the final token
 * estimate so the caller can emit it as an activity line.
 */
function compactInLoop(messages: LLMMessage[], budget: number): { before: number; after: number; savedBytes: number } {
  const before = estimateMessagesTokens(messages);
  if (before <= budget) return { before, after: before, savedBytes: 0 };

  let savedBytes = collapseOldToolResults(messages, 2, 300);
  if (estimateMessagesTokens(messages) > budget) {
    savedBytes += collapseOldToolResults(messages, 1, 100);
  }
  if (estimateMessagesTokens(messages) > budget) {
    savedBytes += collapseOldToolResults(messages, 1, 50);
  }
  return { before, after: estimateMessagesTokens(messages), savedBytes };
}

/**
 * Pick the cheapest enabled model for compaction-style LLM calls.
 * Respects the active profile's allowedProviders so `zai` mode compacts
 * with glm-4.5-flash (free) instead of bleeding out to claude-haiku.
 * Returns undefined if nothing suitable is enabled — caller keeps the
 * hardcoded ContextManager default in that case.
 */
function pickCompressionModel(registry: any, profile: BudgetProfile): { provider: ProviderId; id: string } | undefined {
  const allowed = profile.allowedProviders;
  const candidates: any[] = registry.getAvailable();
  const inScope = allowed && allowed.length > 0
    ? candidates.filter((m: any) => allowed.includes(m.provider))
    : candidates;
  const withSummarization = inScope.filter((m: any) => m.capabilities.includes('summarization'));
  const pool = withSummarization.length > 0 ? withSummarization : inScope;
  if (pool.length === 0) return undefined;
  pool.sort((a: any, b: any) => a.inputCostPer1M - b.inputCostPer1M);
  return { provider: pool[0].provider, id: pool[0].id };
}

function classifyPhase(input: string): 'execute' | 'discuss' {
  const s = input.toLowerCase();
  // Strong coding-intent verbs paired with code-y nouns / file extensions / language names.
  if (/\b(write|make|create|build|implement|generate|add|fix|debug|refactor|optimize|update|change|modify|edit|remove|rewrite|port|translate|save|store|persist|dump|export|append)\b[^\n]{0,80}\b(code|script|function|class|method|file|test|module|app|component|endpoint|api|page|cli|tool|server|client|parser|wrapper|helper|util|util(?:s|ity)|service|model|database|schema|migration|response|answer|reply|output|log|notes?|disk|report|review|summary|transcript)\b/.test(s)) return 'execute';
  if (/\bin\s+(python|javascript|typescript|rust|go(lang)?|java|c\+\+|c#|ruby|php|swift|kotlin|bash|shell|sql)\b/.test(s)) return 'execute';
  if (/\.(py|js|ts|tsx|jsx|rs|go|java|cpp|cc|h|hpp|cs|rb|php|swift|kt|sh|sql|html|css|scss|json|yml|yaml|toml|md|txt)\b/.test(s)) return 'execute';
  if (/\b(write|make|create|build|implement)\s+(a|an|the)?\s*(python|js|ts|rust|go|bash|shell|sql)\b/.test(s)) return 'execute';
  // File-oriented imperative: "save X to disk/file" or "write X to <path>".
  if (/\b(save|write|store|dump|export|persist|append)\b[^\n]{0,40}\b(to|as|into|in)\b[^\n]{0,80}\b(disk|file|folder|directory|path)\b/.test(s)) return 'execute';
  return 'discuss';
}

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
  // Spec 08 — profile-driven bounds replace the old MAX_TOOL_ITERATIONS=20.
  const loopGuard = new LoopGuard(profiles.getActive());
  toolCtx.loopGuard = loopGuard;
  // @mention check
  const mentionMatch = input.match(/^@(\S+)\s+([\s\S]+)/);
  if (mentionMatch) {
    const alias = mentionMatch[1];
    const message = mentionMatch[2];
    const targetModel = router.registry.getByAlias(alias);
    if (!targetModel) {
      const candidates = router.registry.findAliasCandidates(alias);
      const hint = candidates.length > 1
        ? ` — ambiguous, could be: ${candidates.map(a => `@${a}`).join(', ')}`
        : candidates.length === 0
          ? ` — available: ${router.registry.getAliases().map(a => `@${a}`).join(', ')}`
          : '';
      emit({ type: 'error', message: `Unknown model: @${alias}${hint}` });
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

    emit({ type: 'message', id: msgId, role: 'assistant', content: response.content, model_label: targetModel.alias || targetModel.name, reasoning_content: response.reasoningContent });
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
  const reasoningChunks: string[] = [];

  const msgId = `msg-${Date.now()}`;
  emit({ type: 'message', id: msgId, role: 'assistant', content: '', model_label: '...' });

  // Classify the user's request once. The phase drives the budget profile's
  // preference list inside the router (executionPreference vs planningPreference).
  const phase = classifyPhase(input);
  // Emit visible routing evidence as the very first activity line so the
  // user can see "router classified this as a coding task" before any model
  // is even called.
  emit({
    type: 'activity',
    text: `router: phase=${phase} (${phase === 'execute' ? 'coding intent detected' : 'discussion / reasoning'})`,
    activity_type: 'step',
  });

  while (true) {
    const iteration = loopGuard.check().iteration;
    const decision = await router.select(phase, userMessage, undefined, iteration);
    respondingModel = decision.model.alias || decision.model.name;
    respondingProvider = decision.model.provider;
    respondingReason = decision.reason;
    emit({ type: 'status', text: `${respondingModel} thinking${iteration > 0 ? ` (step ${iteration + 1})` : ''}...` });
    emit({
      type: 'activity',
      text: `→ ${respondingModel} (${decision.tier}: ${decision.reason})`,
      activity_type: 'step',
    });
    emit({ type: 'message_update', id: msgId, model_label: respondingModel });

    // Before each model call, enforce the profile's contextBudget by
    // stubbing old tool results in place. No LLM calls — zero cost. If the
    // stub-stub-stub passes can't get us under budget, we proceed anyway
    // and rely on the LLM's own context window as the final backstop.
    const budget = profiles.getActive().contextBudget;
    const compaction = compactInLoop(messages, budget);
    if (compaction.savedBytes > 0) {
      emit({
        type: 'activity',
        text: `context: ${compaction.before.toLocaleString()} → ${compaction.after.toLocaleString()} tokens (${compaction.savedBytes.toLocaleString()} chars pruned)`,
        activity_type: 'step',
      });
    }

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

    if (response.reasoningContent) {
      const header = reasoningChunks.length === 0
        ? `── ${response.model} ──`
        : `\n── ${response.model} (step ${reasoningChunks.length + 1}) ──`;
      reasoningChunks.push(`${header}\n${response.reasoningContent}`);
    }

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

    // Spec 08 — drive the loop with LoopGuard. Feed the first tool error so
    // stuck detection works on ordinary turns.
    const firstError = toolResults.find(r => r.isError)?.content;
    loopGuard.recordIteration(iterCost, firstError);
    const guard = loopGuard.check();
    if (guard.shouldStop) {
      // Give the model one final no-tools iteration to summarize what it
      // found. This is the difference between "Loop stopped: iteration
      // limit" with zero useful output and a real summary of progress.
      try {
        emit({ type: 'status', text: `${respondingModel} summarizing (cap reached)...` });
        const finalResponse = await callLLM({
          provider: decision.model.provider,
          model: decision.model.id,
          systemPrompt,
          messages: [
            ...messages,
            { role: 'user', content: `You have reached the iteration limit (${guard.stopReason || 'bounds reached'}). Do not call any more tools. Summarize what you found, what you produced, and what remains to be done, in 10 lines or fewer.` },
          ],
          maxOutputTokens: 2048,
          cacheablePrefix,
        });
        totalInputTokens += finalResponse.inputTokens;
        totalOutputTokens += finalResponse.outputTokens;
        totalCost += estimateCost(finalResponse.model, finalResponse.inputTokens, finalResponse.outputTokens);
        finalContent = (finalResponse.content || response.content || '').trim()
          + `\n\n_(loop stopped: ${guard.stopReason || 'bounds reached'})_`;
      } catch {
        finalContent = (response.content || `(no final output)`) + `\n\n_(loop stopped: ${guard.stopReason || 'bounds reached'})_`;
      }
      break;
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
    reasoning_content: reasoningChunks.length > 0 ? reasoningChunks.join('\n') : undefined,
    stats: {
      input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      cost_usd: totalCost, models: [...modelsUsed],
      provider: respondingProvider,
      route_reason: respondingReason,
      iterations: messages.filter(m => m.role === 'assistant').length || 1,
    },
  });

  emit({ type: 'status', text: '' });
  toolCtx.permissionManager?.endTurn();
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
  rateLimiter: RateLimiter,
  pendingImages: ImageAttachment[],
  telemetry: TelemetryEmitter,
): Promise<string> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/mode': {
      const mode = parts[1];
      if (!mode) return profiles.format();
      try {
        profiles.setProfile(mode as any);
        router.rules.setProfile(profiles.getActive());
        // Reapply profile scope to intent router + compression model so
        // switching to/from zai updates everything in one shot.
        const p = profiles.getActive();
        const cheap = pickCompressionModel(registry, p);
        if (cheap) contextManager.setCompressionModel(cheap.provider, cheap.id);
        router.setProfileScope({
          allowedProviders: p.allowedProviders,
          classifier: cheap ? { provider: cheap.provider, model: cheap.id } : undefined,
        });
        writeActiveProfile(resolve(workingDir, '.kondi-chat'), profiles.getActive().name);
        // If there's no manual override, let the indicator reflect the
        // new profile name until the next turn resolves a concrete model.
        if (!router.rules.getOverride()) {
          emit({ type: 'model_override', label: profiles.getActive().name });
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
        emit({ type: 'model_override', label: profiles.getActive().name });
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
      emit({ type: 'model_override', label: model.alias || model.id });
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
    case '/help': return formatHelp(parts[1]);
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

// ── Non-interactive helpers (Spec 10) ───────────────────────────────

interface NonInteractiveFlags {
  prompt?: string;
  pipe: boolean;
  json: boolean;
  sessions: boolean;
  maxIterations?: number;
  maxCostUsd?: number;
  autoApprove: Set<string>;
}

function parseNonInteractiveFlags(argv: string[]): NonInteractiveFlags | null {
  const has = (f: string) => argv.includes(f);
  if (!(has('--prompt') || has('--pipe') || has('--json') || has('--sessions'))) return null;
  const flags: NonInteractiveFlags = {
    pipe: has('--pipe'),
    json: has('--json'),
    sessions: has('--sessions'),
    autoApprove: new Set(),
  };
  const promptIdx = argv.indexOf('--prompt');
  if (promptIdx >= 0) flags.prompt = argv[promptIdx + 1];
  const iterIdx = argv.indexOf('--max-iterations');
  if (iterIdx >= 0) flags.maxIterations = parseInt(argv[iterIdx + 1], 10);
  const costIdx = argv.indexOf('--max-cost');
  if (costIdx >= 0) flags.maxCostUsd = parseFloat(argv[costIdx + 1]);
  const aaIdx = argv.indexOf('--auto-approve');
  if (aaIdx >= 0) flags.autoApprove = new Set((argv[aaIdx + 1] || '').split(',').filter(Boolean));
  return flags;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', c => chunks.push(Buffer.from(c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function runNonInteractiveTurn(
  flags: NonInteractiveFlags,
  workingDir: string,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  router: UnifiedRouter,
  toolCtx: ToolContext,
  toolManager: ToolManager,
  profiles: ProfileManager,
  checkpointManager: CheckpointManager,
  sessionStore: SessionStore,
  skipPermissions: boolean,
): Promise<number> {
  if (flags.sessions) {
    process.stdout.write(sessionStore.format(workingDir) + '\n');
    return 0;
  }
  // Non-TTY permission guard
  if (!skipPermissions && flags.autoApprove.size === 0 && toolCtx.permissionManager) {
    // Wrap emit as a no-op so confirm-tier tools fail fast with a clear error
    // instead of hanging forever waiting for a TUI response.
    toolCtx.emit = () => {};
  }
  // Install simple auto-approve overrides by bypassing check for listed tools
  if (flags.autoApprove.size > 0 && toolCtx.permissionManager) {
    const pm = toolCtx.permissionManager;
    const origCheck = pm.check.bind(pm);
    pm.check = (tool: string, args: Record<string, unknown>) => {
      if (flags.autoApprove.has(tool)) return 'auto-approve';
      return origCheck(tool, args);
    };
  }

  let input = flags.prompt;
  if (!input && flags.pipe) input = (await readStdin()).trim();
  if (!input) {
    process.stderr.write('Error: no prompt provided. Use --prompt "…" or --pipe.\n');
    return 1;
  }

  toolCtx.mutatedFiles = new Set();

  // Capture events that the agent loop writes to stdout via emit() — we need
  // to replay them in the final JSON or drop them entirely in text mode.
  const events: any[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]): boolean => {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const line = s.endsWith('\n') ? s.slice(0, -1) : s;
      if (line.startsWith('{')) {
        try { events.push(JSON.parse(line)); return true; } catch { /* fallthrough */ }
      }
    } catch { /* fallthrough */ }
    return origStdoutWrite(chunk, ...rest);
  };

  const start = Date.now();
  let exitCode = 0;
  try {
    await handleSubmit(input, session, contextManager, ledger, router, (router as any).collector, toolCtx, toolManager, profiles, checkpointManager);
  } catch (e) {
    exitCode = 1;
    process.stderr.write(`Error: ${(e as Error).message}\n`);
  }
  (process.stdout as any).write = origStdoutWrite;

  // Locate the final assistant message
  const lastAssistant = session.messages.filter(m => m.role === 'assistant').pop();
  const finalMessage = lastAssistant?.content || '';
  const stats = events.find(e => e.type === 'message_update' && e.stats)?.stats;
  const filesModified = [...(toolCtx.mutatedFiles || [])];
  const durationMs = Date.now() - start;

  // Cost cap check
  if (flags.maxCostUsd !== undefined && stats && stats.cost_usd > flags.maxCostUsd) {
    exitCode = 3;
  }

  // Tool calls from the captured message_update events
  const lastUpdate = [...events].reverse().find(e => e.type === 'message_update' && e.tool_calls);
  const toolCalls = lastUpdate?.tool_calls || [];

  if (flags.json) {
    const payload = {
      success: exitCode === 0,
      exitCode,
      finalMessage,
      iterations: stats?.iterations ?? 0,
      toolCalls,
      stats: {
        inputTokens: stats?.input_tokens ?? 0,
        outputTokens: stats?.output_tokens ?? 0,
        costUsd: stats?.cost_usd ?? 0,
        modelsUsed: stats?.models ?? [],
        durationMs,
      },
      session: { id: session.id, messageCount: session.messages.length },
      filesModified,
    };
    origStdoutWrite(JSON.stringify(payload, null, 2) + '\n');
  } else {
    if (finalMessage) origStdoutWrite(finalMessage + '\n');
    if (stats) {
      process.stderr.write(
        `Done: ${stats.iterations ?? 1} iterations, $${(stats.cost_usd || 0).toFixed(4)}\n`,
      );
    }
  }
  return exitCode;
}

main().catch(err => {
  emit({ type: 'error', message: err.message });
  process.exit(1);
});
