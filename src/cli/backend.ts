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
import { loadConsultants } from '../engine/consultants.ts';
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
import type { ModelRegistry } from '../router/registry.ts';
import { pickCompressionModel } from './submit-helpers.ts';
import { handleCommand } from './commands.ts';
import { handleSubmit } from './submit.ts';
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
  // The TUI passes --cwd <dir> with the user's actual working directory
  // (where they ran `kondi-chat`). Without it, fall back to process.cwd().
  const cwdIdx = process.argv.indexOf('--cwd');
  const workingDir = (cwdIdx >= 0 && process.argv[cwdIdx + 1])
    ? resolve(process.argv[cwdIdx + 1])
    : process.cwd();
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

  // Web tools — always registered. Uses DuckDuckGo by default (no API key
  // needed). Upgrades to Brave Search if BRAVE_SEARCH_API_KEY is set.
  const webTools = new WebToolsManager();
  for (const tool of webTools.getTools()) {
    toolManager.registerTool(tool, async (args) => webTools.executeTool(tool.name, args));
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
      rolePinning: p.rolePinning,
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
      // Stream per-phase activity events into the same emit sink the
      // agent loop uses, so create_task is visibly transparent to the TUI
      // instead of blocking as one opaque tool line.
      emit,
    },
    memoryManager,
    setActiveFile: (p: string) => contextManager.setActiveFile(p),
    permissionManager,
    consultants: loadConsultants(storageDir),
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

  // Tell the TUI what the routing state is at startup so the bottom
  // indicator renders correctly before the first turn arrives. If a
  // prior session restored a /use override, we surface that; otherwise
  // we show the profile name under "routing:".
  {
    const override = router.rules.getOverride();
    if (override) {
      emit({ type: 'model_override', label: override.alias || override.id, pinned: true });
    } else {
      emit({ type: 'model_override', label: profiles.getActive().name, pinned: false });
    }
  }

  // Telemetry-disabled startup banner removed — it rendered on every launch
  // and cluttered the status line. Users can discover /telemetry via /help.

  sessionStore.setActive(session.id);
  sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id);
  const saveInterval = setInterval(() => {
    try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); }
    catch (e) { process.stderr.write(`[session-save] ${(e as Error).message}\n`); }
  }, AUTO_SAVE_MS);
  // Idempotent shutdown path. Signal + crash handlers route through here
  // so the session is flushed AND MCP child transports get a chance to
  // close cleanly before the process exits. A hard 2s deadline backs up
  // the async cleanup — if MCP is wedged we'd rather kill the process
  // than hang the user's terminal forever.
  let shuttingDown = false;
  const saveAndExit = (exitCode: number = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(saveInterval);
    try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); } catch { /* ignore */ }
    // Hard deadline: force-exit if cleanup doesn't finish in 2 seconds.
    const deadline = setTimeout(() => process.exit(exitCode), 2000);
    deadline.unref();
    // Tear down MCP client connections so stdio child processes get a
    // real close() instead of becoming zombies on SIGKILL of the parent.
    mcpClient.disconnectAll()
      .catch(() => { /* best-effort cleanup */ })
      .finally(() => process.exit(exitCode));
  };
  process.on('SIGTERM', () => saveAndExit(0));
  process.on('SIGINT', () => saveAndExit(0));

  // Spec 13 — fatal handlers flush session state before crashing out
  process.on('uncaughtException', (err) => {
    try { emit({ type: 'error', message: `Uncaught: ${err.message}`, recoverable: false }); } catch { /* ignore */ }
    saveAndExit(1);
  });
  process.on('unhandledRejection', (reason) => {
    try { emit({ type: 'error', message: `Unhandled rejection: ${String(reason)}`, recoverable: false }); } catch { /* ignore */ }
    saveAndExit(1);
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
      // saveAndExit handles both the session flush and MCP teardown
      // behind a 2s hard deadline. No need for redundant disconnects here.
      saveAndExit(0);
      return;
    }

    if (cmd.type === 'permission_response') {
      permissionManager.handleResponse(cmd.id, cmd.decision);
      return;
    }

    if (cmd.type === 'command') {
      // `/loop <goal>` is not a simple string-returning slash command —
      // it spawns a multi-iteration agent loop that needs the streaming
      // event path of handleSubmit. Route it there instead of
      // handleCommand so the TUI sees tool_call / activity / message
      // events in real time.
      const loopMatch = (cmd.text as string).match(/^\/loop\s+([\s\S]+)/);
      if (loopMatch) {
        const goal = loopMatch[1].trim();
        refreshGit();
        toolCtx.mutatedFiles = new Set();
        const boot = `Autonomous loop — goal: ${goal}\n\n` +
          `Work toward this goal using the available tools. Do not stop at the ` +
          `first pass. Keep iterating: investigate, edit, verify, refine.\n\n` +
          `IMPORTANT: for any unit of real coding work, call the create_task ` +
          `tool with a clear goal + constraints. create_task runs the full ` +
          `dispatch → execute → verify → reflect pipeline, which routes each ` +
          `phase to a different role-appropriate model from the active ` +
          `profile (planning model for dispatch, coding model for execute, ` +
          `reflect model for the final critique) and verifies the result ` +
          `against local tools. Prefer create_task over ad-hoc read_file + ` +
          `write_file loops whenever the task has a clear goal you can state.\n\n` +
          `When the goal is fully accomplished, respond with DONE on its own ` +
          `line followed by a brief summary of what changed. If you are blocked ` +
          `and cannot proceed, respond with STUCK: <reason>.`;
        await handleSubmit(boot, {
          session, contextManager, ledger, router, collector,
          toolCtx, toolManager, profiles, checkpointManager, emit,
        }, { loop: true, loopGoal: goal });
        try { sessionStore.save(session, profiles.getActive().name, router.rules.getOverride()?.id); } catch { /* ignore */ }
        emit({ type: 'command_result', output: `Loop finished.` });
        refreshGit();
        emitGitInfo();
        return;
      }
      const output = await handleCommand(cmd.text, {
        session, contextManager, ledger, registry, collector, toolCtx,
        mcpClient, toolManager,
        workingDir, profiles, router, councilProfiles, councilPath,
        analytics, checkpointManager, sessionStore, rateLimiter,
        pendingImages, telemetry, emit,
      });
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
      await handleSubmit(input, {
        session, contextManager, ledger, router, collector,
        toolCtx, toolManager, profiles, checkpointManager, emit,
      });
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
// Helpers (collapseOldToolResults, compactInLoop, pickCompressionModel,
// classifyPhase) live in ./submit-helpers.ts and are imported at the top.


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
  // Non-interactive auto-approve flag. We consult the original `check`
  // FIRST so always-confirm patterns (rm -rf, sudo, curl|sh, etc.) can
  // never be silently bypassed by listing a tool on the CLI allow-list.
  // The flag only downgrades non-dangerous tiers. Shell chain operators
  // are still upgraded to `confirm` by the underlying check — in
  // non-interactive mode a confirm request will fail fast (no TUI to
  // answer it), so chained commands are effectively blocked unless the
  // operator explicitly passes --dangerously-skip-permissions.
  if (flags.autoApprove.size > 0 && toolCtx.permissionManager) {
    const pm = toolCtx.permissionManager;
    const origCheck = pm.check.bind(pm);
    pm.check = (tool: string, args: Record<string, unknown>) => {
      const original = origCheck(tool, args);
      if (original === 'always-confirm') return 'always-confirm';
      if (flags.autoApprove.has(tool)) return 'auto-approve';
      return original;
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
    await handleSubmit(input, {
      session, contextManager, ledger, router, collector: router.collector,
      toolCtx, toolManager, profiles, checkpointManager, emit,
    });
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
