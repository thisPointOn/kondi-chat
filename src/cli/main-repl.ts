#!/usr/bin/env npx tsx
/**
 * kondi-chat — Interactive multi-model coding CLI
 *
 * An agent loop: the frontier model talks with you and uses tools
 * (read files, search code, run commands, create task cards) to
 * accomplish coding work. All calls are recorded in an audit ledger.
 *
 * Usage:
 *   npx tsx src/cli/main.ts [options]
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { ProviderId, Session, LLMMessage, ToolCall } from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';
import { ContextManager, createSession } from '../context/manager.ts';
import { bootstrapDirectory, type BootstrapDepth } from '../context/bootstrap.ts';
import { estimateTokens } from '../context/budget.ts';
import { Ledger, estimateCost } from '../audit/ledger.ts';
import { AGENT_TOOLS, executeTool, type ToolContext } from '../engine/tools.ts';
import { ModelRegistry } from '../router/registry.ts';
import { RuleRouter } from '../router/rules.ts';
import { RoutingCollector } from '../router/collector.ts';
import { EmbeddingService } from '../router/embeddings.ts';

const MAX_TOOL_ITERATIONS = 20;

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  provider: ProviderId;
  model?: string;
  dir?: string;
  deep: boolean;
  budget: number;
  systemPrompt?: string;
  noBootstrap: boolean;
  autoVerify: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    provider: 'openai',
    deep: false,
    budget: 30_000,
    noBootstrap: false,
    autoVerify: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--provider': opts.provider = args[++i] as ProviderId; break;
      case '--model': opts.model = args[++i]; break;
      case '--dir': opts.dir = args[++i]; break;
      case '--deep': opts.deep = true; break;
      case '--budget': opts.budget = parseInt(args[++i], 10); break;
      case '--system': opts.systemPrompt = args[++i]; break;
      case '--no-bootstrap': opts.noBootstrap = true; break;
      case '--no-verify': opts.autoVerify = false; break;
      case '--help': case '-h':
        console.log(`
kondi-chat — Interactive coding assistant with tool use

Usage: npx tsx src/cli/main.ts [options]

Options:
  --provider <name>   anthropic | openai | deepseek | google | xai | ollama | nvidia-router
  --model <name>      Model override (or "auto" for router)
  --dir <path>        Working directory for codebase context
  --deep              Load full source (default: light tree + key files)
  --budget <tokens>   Context budget (default: 30000)
  --system <prompt>   System prompt override
  --no-bootstrap      Skip codebase loading
  --no-verify         Skip auto-verification after task execution

Commands (in chat):
  /switch <provider> [model]   Switch provider/model
  /status                      Session stats and cost
  /tasks                       List all task cards
  /ledger [phase]              Show audit ledger (optionally filter by phase)
  /cost                        Detailed cost breakdown by phase and model
  /export                      Export full session + ledger to JSON
  /help                        Show this help
  /quit                        Exit
`);
        process.exit(0);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs();
  const workingDir = args.dir ? resolve(args.dir) : process.cwd();

  // Storage directory for ledger
  const storageDir = resolve(workingDir, '.kondi-chat');
  mkdirSync(storageDir, { recursive: true });

  // Create session
  const session = createSession(args.provider, args.model, workingDir);
  const ledger = new Ledger(session.id, storageDir);
  const registry = new ModelRegistry(storageDir);
  const router = new RuleRouter(registry);
  const embeddingService = new EmbeddingService(storageDir);
  const collector = new RoutingCollector(storageDir, embeddingService);

  // Bootstrap directory context
  if (!args.noBootstrap) {
    const depth: BootstrapDepth = args.deep ? 'deep' : 'light';
    process.stderr.write(`[bootstrap] Scanning ${workingDir} (${depth})...\n`);
    const ctx = await bootstrapDirectory(workingDir, depth);
    if (ctx) {
      session.groundingContext = ctx;
      process.stderr.write(`[bootstrap] Loaded ${estimateTokens(ctx).toLocaleString()} tokens of context\n`);
    }
  }

  const contextManager = new ContextManager(
    session,
    {
      contextBudget: args.budget,
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    },
    ledger,
  );

  // Tool context for the agent loop
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
      autoVerify: args.autoVerify,
    },
  };

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nYou: ',
  });

  const modelLabel = () => args.model || session.activeModel || 'default';

  // Check model availability on startup
  process.stderr.write('[startup] Checking model availability...\n');
  await registry.checkHealth();
  const available = registry.getAvailable();
  const unavailable = registry.getEnabled().filter(m => registry.getStatus(m.id).status === 'unavailable');

  console.log(`\nkondi-chat — ${session.activeProvider}/${modelLabel()}`);
  console.log(`Models: ${available.length} available${unavailable.length > 0 ? `, ${unavailable.length} unavailable` : ''} | Router: rule-based`);
  if (unavailable.length > 0) {
    for (const m of unavailable) {
      const s = registry.getStatus(m.id);
      console.log(`  ! ${m.name}: ${s.error}`);
    }
  }
  console.log(`Context budget: ${args.budget.toLocaleString()} tokens | Verify: ${args.autoVerify ? 'on' : 'off'}`);
  const aliases = available.filter(m => m.alias).map(m => '@' + m.alias);
  if (aliases.length > 0) {
    console.log(`Mention: ${aliases.join(', ')}`);
  }
  if (session.groundingContext) {
    console.log(`Codebase: ${estimateTokens(session.groundingContext).toLocaleString()} tokens`);
  }
  console.log(`Ledger: ${storageDir}`);
  console.log('Type /help for commands.\n');

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, session, contextManager, ledger, args, workingDir, toolCtx, registry, collector);
      rl.prompt();
      return;
    }

    // Check for @mention — direct a message to a specific model
    const mentionMatch = input.match(/^@(\S+)\s+([\s\S]+)/);
    if (mentionMatch) {
      const alias = mentionMatch[1];
      const message = mentionMatch[2];
      const targetModel = registry.getByAlias(alias);

      if (!targetModel) {
        const available = registry.getAliases().map(a => `@${a}`).join(', ');
        console.log(`Unknown model: @${alias}. Available: ${available}`);
        rl.prompt();
        return;
      }

      contextManager.addUserMessage(input);
      const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();

      try {
        await runDirectMessage(
          systemPrompt,
          userMessage,
          cacheablePrefix,
          message,
          targetModel,
          session,
          contextManager,
          ledger,
          collector,
        );
      } catch (error) {
        console.error(`\nError: ${(error as Error).message}`);
      }

      await contextManager.maybeCompress();
      await contextManager.updateSessionState();
      rl.prompt();
      return;
    }

    // Agent loop — send to frontier model with tools
    contextManager.addUserMessage(input);
    const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();

    try {
      await runAgentLoop(
        systemPrompt,
        userMessage,
        cacheablePrefix,
        session,
        contextManager,
        ledger,
        toolCtx,
        router,
        collector,
      );
    } catch (error) {
      console.error(`\nError: ${(error as Error).message}`);
    }

    // Background maintenance
    await contextManager.maybeCompress();
    await contextManager.updateSessionState();

    rl.prompt();
  });

  rl.on('close', () => {
    printCostSummary(ledger);
    const sessionPath = resolve(storageDir, `${session.id}-session.json`);
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    process.stderr.write(`[session] Saved to ${sessionPath}\n`);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Agent loop — runs tool calls until the model produces final text
// ---------------------------------------------------------------------------

async function runAgentLoop(
  systemPrompt: string,
  userMessage: string,
  cacheablePrefix: string | undefined,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  toolCtx: ToolContext,
  router: RuleRouter,
  collector: RoutingCollector,
): Promise<void> {
  // Build the conversation messages for this agent turn
  const messages: LLMMessage[] = [
    { role: 'user', content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let finalContent = '';
  let respondingModel = '';

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    // Route the discuss phase through the router
    const decision = router.select('discuss');
    respondingModel = decision.model.alias || decision.model.name;
    process.stderr.write(`  ╭─ discuss${iteration > 0 ? ` (iteration ${iteration + 1})` : ''} [${decision.reason}]\n`);

    const response = await callLLM({
      provider: decision.model.provider,
      model: decision.model.id,
      systemPrompt,
      messages,
      tools: AGENT_TOOLS,
      maxOutputTokens: 8192,
      cacheablePrefix,
    });

    const iterCost = estimateCost(response.model, response.inputTokens, response.outputTokens);
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    totalCost += iterCost;

    process.stderr.write(
      `  │  model: ${response.model}  ${response.inputTokens}in/${response.outputTokens}out  $${iterCost.toFixed(4)}` +
      `${response.cached ? ' (cached)' : ''}\n`
    );

    // Record in ledger and collector (with embedding)
    ledger.record('discuss', response, messages[messages.length - 1]?.content?.slice(0, 200) || '(tool continuation)');

    // Record the successful call
    collector.recordWithEmbedding({
      timestamp: new Date().toISOString(),
      phase: 'discuss', promptLength: userMessage.length,
      contextTokens: response.inputTokens, failures: 0, promoted: false,
      modelId: response.model, provider: response.provider,
      succeeded: true, wasFallback: response.wasFallback,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: iterCost, latencyMs: response.latencyMs,
      routeReason: decision.reason,
    }, userMessage).catch(() => {});

    // If this was a fallback, also record a failure for the originally requested model
    // so the NN learns it's unreliable
    if (response.wasFallback && response.requestedModel) {
      collector.record({
        timestamp: new Date().toISOString(),
        phase: 'discuss', promptLength: userMessage.length,
        contextTokens: 0, failures: 0, promoted: false,
        modelId: response.requestedModel, provider: decision.model.provider,
        succeeded: false, apiError: true,
        inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0,
        routeReason: `failed — fell back to ${response.model}`,
      });
    }

    // If no tool calls, we're done — this is the final response
    if (!response.toolCalls || response.toolCalls.length === 0) {
      process.stderr.write(`  ╰─ done\n`);
      finalContent = response.content;
      break;
    }

    // Model wants to use tools — show any preamble text
    if (response.content) {
      console.log(`\n${response.content}`);
    }

    // Append assistant message with tool calls to conversation
    messages.push({
      role: 'assistant',
      content: response.content || undefined,
      toolCalls: response.toolCalls,
    });

    // Truncate older tool results to save tokens on re-send.
    // The model already saw them — keep just enough for reference.
    compactOlderToolResults(messages);

    // Execute each tool and collect results
    const toolResults = [];
    for (const tc of response.toolCalls) {
      const toolArgs = formatToolArgs(tc);
      process.stderr.write(`  ├─ tool: ${tc.name}(${toolArgs})\n`);
      const result = await executeTool(tc.name, tc.arguments, toolCtx);
      if (result.isError) {
        process.stderr.write(`  │  └─ error: ${result.content.slice(0, 100)}\n`);
      }
      // Cap individual tool results at 3000 chars to limit token growth
      const capped = result.content.length > 3000
        ? result.content.slice(0, 3000) + `\n... (${result.content.length - 3000} chars truncated)`
        : result.content;
      toolResults.push({
        toolCallId: tc.id,
        content: capped,
        isError: result.isError,
      });
    }

    // Append tool results to conversation
    messages.push({
      role: 'tool',
      toolResults,
    });

    // Safety: if we're at the last iteration, break
    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      finalContent = response.content || '(max tool iterations reached)';
    }
  }

  // Display final response with model label
  if (finalContent) {
    console.log(`\n[${respondingModel}]: ${finalContent}`);
  }

  // Track in session
  session.totalInputTokens += totalInputTokens;
  session.totalOutputTokens += totalOutputTokens;
  session.totalCostUsd += totalCost;

  // Add final response to conversation history
  contextManager.addAssistantMessage({
    content: finalContent,
    model: session.activeModel || 'default',
    provider: session.activeProvider,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    latencyMs: 0,
  });

  // Show total cost with iteration count for transparency
  const iterationCount = messages.filter(m => m.role === 'assistant').length || 1;
  process.stderr.write(
    `  total: ${totalInputTokens.toLocaleString()}in/${totalOutputTokens.toLocaleString()}out` +
    ` $${totalCost.toFixed(4)}` +
    `${iterationCount > 1 ? ` (${iterationCount} iterations)` : ''}\n`
  );
}

// ---------------------------------------------------------------------------
// Direct message — @mention sends to a specific model (no tools, just chat)
// ---------------------------------------------------------------------------

async function runDirectMessage(
  systemPrompt: string,
  assembledUserMessage: string,
  cacheablePrefix: string | undefined,
  rawMessage: string,
  targetModel: import('../router/registry.ts').ModelEntry,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  collector: RoutingCollector,
): Promise<void> {
  process.stderr.write(`  ╭─ @${targetModel.alias || targetModel.id}\n`);

  const response = await callLLM({
    provider: targetModel.provider,
    model: targetModel.id,
    systemPrompt,
    userMessage: assembledUserMessage,
    maxOutputTokens: 8192,
    cacheablePrefix,
  });

  const cost = estimateCost(response.model, response.inputTokens, response.outputTokens);

  process.stderr.write(
    `  │  model: ${response.model}  ${response.inputTokens}in/${response.outputTokens}out  $${cost.toFixed(4)}` +
    `${response.cached ? ' (cached)' : ''}\n`
  );
  process.stderr.write(`  ╰─ done\n`);

  console.log(`\n[${targetModel.alias || targetModel.name}]: ${response.content}`);

  // Track
  session.totalInputTokens += response.inputTokens;
  session.totalOutputTokens += response.outputTokens;
  session.totalCostUsd += cost;

  contextManager.addAssistantMessage(response);
  ledger.record('discuss', response, rawMessage.slice(0, 200));

  collector.recordWithEmbedding({
    timestamp: new Date().toISOString(),
    phase: 'discuss', promptLength: rawMessage.length,
    contextTokens: response.inputTokens, failures: 0, promoted: false,
    modelId: response.model, provider: targetModel.provider,
    succeeded: true, inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: cost, latencyMs: response.latencyMs,
    routeReason: `@mention: ${targetModel.alias}`,
  }, rawMessage).catch(() => {});
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function handleCommand(
  input: string,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  args: CliArgs,
  workingDir: string,
  toolCtx: ToolContext,
  registry: ModelRegistry,
  collector: RoutingCollector,
): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    // -- Provider switch --
    case '/switch': {
      const newProvider = parts[1] as ProviderId | undefined;
      const newModel = parts[2];
      if (!newProvider) {
        console.log('Usage: /switch <provider> [model]');
        console.log('Providers: anthropic, openai, deepseek, google, xai, ollama, nvidia-router');
        return;
      }
      session.activeProvider = newProvider;
      session.activeModel = newModel;
      args.provider = newProvider;
      args.model = newModel;
      toolCtx.pipelineConfig.provider = newProvider;
      toolCtx.pipelineConfig.model = newModel;
      console.log(`Switched to ${newProvider}${newModel ? '/' + newModel : ''}`);
      return;
    }

    // -- Status --
    case '/status': {
      const turns = session.messages.filter((m: { role: string }) => m.role === 'user').length;
      console.log(`Session: ${session.id.slice(0, 8)}`);
      console.log(`Provider: ${session.activeProvider}/${session.activeModel || 'default'}`);
      console.log(`Turns: ${turns} | Messages: ${session.messages.length} | Tasks: ${session.tasks.length}`);
      console.log(`Tokens: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out`);
      console.log(`Cost: $${session.totalCostUsd.toFixed(4)}`);
      if (session.state.goal) console.log(`Goal: ${session.state.goal}`);
      if (session.state.currentPlan.length > 0) console.log(`Plan: ${session.state.currentPlan.join(' → ')}`);
      return;
    }

    // -- Task list --
    case '/tasks': {
      if (session.tasks.length === 0) {
        console.log('No tasks yet. The assistant will create tasks when code changes are needed.');
        return;
      }
      for (const t of session.tasks) {
        const dur = t.completedAt
          ? `${((new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()) / 1000).toFixed(0)}s`
          : 'running';
        console.log(`  ${t.id} [${t.status}] ${t.kind}: ${t.goal.slice(0, 60)} (${dur}, ${t.failures} failures)`);
      }
      return;
    }

    // -- Audit ledger --
    case '/ledger': {
      const phaseFilter = parts[1];
      const entries = phaseFilter
        ? ledger.getAll().filter(e => e.phase === phaseFilter)
        : ledger.getAll();

      if (entries.length === 0) {
        console.log(phaseFilter ? `No ledger entries for phase "${phaseFilter}".` : 'Ledger is empty.');
        return;
      }

      console.log(`\n${'#'.padEnd(4)} ${'Phase'.padEnd(14)} ${'Model'.padEnd(30)} ${'In'.padEnd(8)} ${'Out'.padEnd(8)} ${'Cost'.padEnd(8)} ${'Task'.padEnd(12)}`);
      console.log('-'.repeat(90));
      for (const e of entries) {
        console.log(
          `${e.id.slice(-4).padEnd(4)} ` +
          `${e.phase.padEnd(14)} ` +
          `${e.model.slice(0, 28).padEnd(30)} ` +
          `${e.inputTokens.toString().padEnd(8)} ` +
          `${e.outputTokens.toString().padEnd(8)} ` +
          `$${e.costUsd.toFixed(4).padEnd(7)} ` +
          `${(e.taskId || '-').slice(0, 12)}`
        );
      }
      return;
    }

    // -- Cost breakdown --
    case '/cost': {
      const totals = ledger.getTotals();
      if (totals.calls === 0) {
        console.log('No calls recorded yet.');
        return;
      }

      console.log(`\nTotal: ${totals.calls} calls | ${totals.inputTokens.toLocaleString()}in / ${totals.outputTokens.toLocaleString()}out | $${totals.costUsd.toFixed(4)}`);

      console.log('\nBy phase:');
      for (const [phase, data] of Object.entries(totals.byPhase).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
        console.log(`  ${phase.padEnd(16)} ${data.calls} calls  ${data.inputTokens.toLocaleString().padStart(10)}in  ${data.outputTokens.toLocaleString().padStart(10)}out  $${data.costUsd.toFixed(4)}`);
      }

      console.log('\nBy model:');
      for (const [model, data] of Object.entries(totals.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
        console.log(`  ${model.slice(0, 28).padEnd(30)} ${data.calls} calls  $${data.costUsd.toFixed(4)}`);
      }
      return;
    }

    // -- Export --
    case '/export': {
      const exportData = {
        session,
        ledger: ledger.getAll(),
        exportedAt: new Date().toISOString(),
      };
      const filename = `kondi-chat-${session.id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(filename, JSON.stringify(exportData, null, 2));
      console.log(`Exported to ${filename}`);
      return;
    }

    // -- Models --
    case '/models': {
      const subcmd = parts[1];
      if (!subcmd) {
        console.log(registry.format());
        return;
      }
      if (subcmd === 'enable' && parts[2]) {
        registry.enable(parts[2]) ? console.log(`Enabled ${parts[2]}`) : console.log('Model not found');
      } else if (subcmd === 'disable' && parts[2]) {
        registry.disable(parts[2]) ? console.log(`Disabled ${parts[2]}`) : console.log('Model not found');
      } else if (subcmd === 'add') {
        if (parts.length < 7) {
          console.log('Usage: /models add <id> <provider> <capabilities> <in_cost> <out_cost> [alias]');
          console.log('Example: /models add gpt-4o openai reasoning,writing 2.5 10 gpt');
          return;
        }
        const alias = parts[7];
        registry.add({
          id: parts[2],
          name: parts[2],
          alias,
          provider: parts[3] as ProviderId,
          capabilities: parts[4].split(','),
          inputCostPer1M: parseFloat(parts[5]),
          outputCostPer1M: parseFloat(parts[6]),
          contextWindow: 128_000,
          enabled: true,
        });
        console.log(`Added ${parts[2]}${alias ? ` (@${alias})` : ''}`);
      } else if (subcmd === 'remove' && parts[2]) {
        registry.remove(parts[2]) ? console.log(`Removed ${parts[2]}`) : console.log('Model not found');
      } else {
        console.log('Usage: /models [enable|disable|add|remove] [model_id]');
      }
      return;
    }

    // -- Health check --
    case '/health': {
      process.stderr.write('[health] Checking model availability...\n');
      await registry.checkHealth();
      console.log(registry.formatHealth());
      return;
    }

    // -- Routing stats --
    case '/routing': {
      console.log(collector.formatStats());
      return;
    }

    // -- Help --
    case '/help':
      console.log(`
Commands:
  /switch <provider> [model]   Switch fallback provider/model
  /models                      List available models and capabilities
  /models enable|disable <id>  Enable/disable a model
  /models add <id> <provider> <caps> <in_cost> <out_cost> [alias]  Add a model
  /health                      Check which models are available and working
  /routing                     Show routing stats and training data readiness
  /status                      Session stats, cost, and current state
  /tasks                       List all task cards with status
  /ledger [phase]              Audit ledger (filter: discuss, dispatch, execute, verify, reflect)
  /cost                        Cost breakdown by phase and model
  /export                      Export session + ledger to JSON
  /quit                        Exit

@mentions — direct a message to a specific model:
  @<alias> <message>    Send to a specific model by its alias
  Use /models to see available aliases. Set aliases with /models add.

Tools (used automatically by the assistant):
  create_task    Create and execute a coding task (dispatch → execute → verify → reflect)
  read_file      Read a file from the project
  write_file     Write a file to the project
  edit_file      Edit a file (search/replace)
  list_files     List directory contents
  search_code    Search for patterns in code
  run_command    Run a shell command
  update_plan    Update the session goal, plan, and decisions
`);
      return;

    // -- Quit --
    case '/quit':
    case '/exit':
      printCostSummary(ledger);
      const sessionPath = resolve(workingDir, '.kondi-chat', `${session.id}-session.json`);
      writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      process.stderr.write(`[session] Saved to ${sessionPath}\n`);
      process.exit(0);

    default:
      console.log(`Unknown command: ${cmd}. Type /help for commands.`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compact older tool results to reduce tokens on subsequent iterations.
 * The model already consumed these results — we keep a short summary
 * so it remembers what it learned, but drop the full content.
 */
function compactOlderToolResults(messages: LLMMessage[]): void {
  // Only compact tool results that are at least 2 messages old
  // (keep the most recent tool results intact)
  for (let i = 0; i < messages.length - 2; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && msg.toolResults) {
      for (const tr of msg.toolResults) {
        if (tr.content.length > 500) {
          tr.content = tr.content.slice(0, 200) + `\n... (compacted, was ${tr.content.length} chars)`;
        }
      }
    }
  }
}

function formatToolArgs(tc: ToolCall): string {
  const args = tc.arguments;
  // Show the most relevant arg for each tool, keep it short
  switch (tc.name) {
    case 'read_file': return String(args.path || '');
    case 'list_files': return String(args.path || '.');
    case 'search_code': return `"${args.pattern}"${args.path ? ` in ${args.path}` : ''}`;
    case 'run_command': return String(args.command || '').slice(0, 60);
    case 'create_task': return String(args.description || '').slice(0, 60);
    case 'update_plan': return args.goal ? `goal="${String(args.goal).slice(0, 40)}"` : '...';
    default: return JSON.stringify(args).slice(0, 60);
  }
}

function printCostSummary(ledger: Ledger): void {
  const totals = ledger.getTotals();
  console.log(`\nSession total: ${totals.calls} calls | ${totals.inputTokens.toLocaleString()}in / ${totals.outputTokens.toLocaleString()}out | $${totals.costUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
