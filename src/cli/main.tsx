#!/usr/bin/env npx tsx
/**
 * kondi-chat — Interactive multi-model coding CLI (Ink TUI)
 *
 * An agent loop with a proper terminal UI: scrollable chat,
 * collapsible tool output, token stats, and @mentions.
 */

import React from 'react';
import { render } from 'ink';
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
import { App } from './ui/App.js';
import type { ChatMessage, ToolCallDisplay, MessageStats } from './ui/types.js';

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
      case '--repl':
        // Fall back to old REPL mode
        import('./main-repl.ts');
        return opts;
      case '--help': case '-h':
        console.log(`
kondi-chat — Interactive coding assistant with tool use

Usage: npx tsx src/cli/main.tsx [options]

Options:
  --provider <name>   openai | anthropic | deepseek | google | xai | ollama | nvidia-router
  --model <name>      Model override
  --dir <path>        Working directory for codebase context
  --deep              Load full source (default: light tree + key files)
  --budget <tokens>   Context budget (default: 30000)
  --system <prompt>   System prompt override
  --no-bootstrap      Skip codebase loading
  --no-verify         Skip auto-verification after task execution
  --repl              Use old readline REPL instead of TUI

Keyboard:
  Enter         Send message
  Ctrl+N        New line (multi-line input)
  Ctrl+O        Toggle tool output (collapsed by default)
  Ctrl+T        Toggle token/cost stats
  Ctrl+C        Exit
  Escape        Clear input

@mentions:
  @<alias> <message>   Send directly to a specific model
  Use /models to see available aliases.
`);
        process.exit(0);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// UI bridge — connects the agent loop to the Ink UI
// ---------------------------------------------------------------------------

interface UIBridge {
  addMessage: (msg: ChatMessage) => void;
  setStatus: (text: string) => void;
  updateLastAssistant: (update: Partial<ChatMessage>) => void;
  addActivity: (entry: import('./ui/types.js').ActivityEntry) => void;
  clearActivity: () => void;
}

function getUI(): UIBridge {
  return (globalThis as any).__kondiUI;
}

// ---------------------------------------------------------------------------
// Agent loop (same logic, different output)
// ---------------------------------------------------------------------------

async function handleInput(
  input: string,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  router: RuleRouter,
  collector: RoutingCollector,
  registry: ModelRegistry,
  toolCtx: ToolContext,
): Promise<void> {
  const ui = getUI();

  // Slash commands
  if (input.startsWith('/')) {
    const output = await handleCommand(input, session, contextManager, ledger, registry, collector, toolCtx);
    ui.addMessage({
      id: `msg-${Date.now()}`,
      role: 'system',
      content: output,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Check for @mention
  const mentionMatch = input.match(/^@(\S+)\s+([\s\S]+)/);
  if (mentionMatch) {
    const alias = mentionMatch[1];
    const message = mentionMatch[2];
    const targetModel = registry.getByAlias(alias);

    if (!targetModel) {
      const available = registry.getAliases().map(a => `@${a}`).join(', ');
      ui.addMessage({
        id: `msg-${Date.now()}`,
        role: 'system',
        content: `Unknown model: @${alias}. Available: ${available}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    contextManager.addUserMessage(input);
    const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();

    ui.setStatus(`@${alias} thinking...`);

    const response = await callLLM({
      provider: targetModel.provider,
      model: targetModel.id,
      systemPrompt,
      userMessage,
      maxOutputTokens: 8192,
      cacheablePrefix,
    });

    const cost = estimateCost(response.model, response.inputTokens, response.outputTokens);
    session.totalInputTokens += response.inputTokens;
    session.totalOutputTokens += response.outputTokens;
    session.totalCostUsd += cost;
    contextManager.addAssistantMessage(response);
    ledger.record('discuss', response, message.slice(0, 200));

    ui.addMessage({
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: response.content,
      modelLabel: targetModel.alias || targetModel.name,
      modelId: response.model,
      timestamp: new Date().toISOString(),
      stats: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: cost,
        iterations: 1,
        models: [response.model],
      },
    });

    await contextManager.maybeCompress();
    await contextManager.updateSessionState();
    return;
  }

  // Regular agent loop
  contextManager.addUserMessage(input);
  const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();

  const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let finalContent = '';
  let respondingModel = '';
  const allToolCalls: ToolCallDisplay[] = [];
  const modelsUsed = new Set<string>();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const decision = router.select('discuss');
    respondingModel = decision.model.alias || decision.model.name;
    ui.setStatus(`${respondingModel} thinking${iteration > 0 ? ` (step ${iteration + 1})` : ''}...`);
    ui.addActivity({
      text: `${respondingModel} — ${decision.reason}`,
      type: 'step',
      timestamp: new Date().toISOString(),
    });

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
    modelsUsed.add(response.model);

    ledger.record('discuss', response, messages[messages.length - 1]?.content?.slice(0, 200) || '(tool continuation)');

    collector.recordWithEmbedding({
      timestamp: new Date().toISOString(),
      phase: 'discuss', promptLength: userMessage.length,
      contextTokens: response.inputTokens, failures: 0, promoted: false,
      modelId: response.model, provider: decision.model.provider,
      succeeded: true, wasFallback: response.wasFallback,
      inputTokens: response.inputTokens, outputTokens: response.outputTokens,
      costUsd: iterCost, latencyMs: response.latencyMs,
      routeReason: decision.reason,
    }, userMessage).catch(() => {});

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

    // No tool calls — final response
    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content;
      break;
    }

    // Tool calls
    messages.push({
      role: 'assistant',
      content: response.content || undefined,
      toolCalls: response.toolCalls,
    });

    // Compact older tool results
    compactOlderToolResults(messages);

    const toolResults = [];
    for (const tc of response.toolCalls) {
      const toolArgs = formatToolArgs(tc);
      ui.setStatus(`${respondingModel} > ${tc.name}(${toolArgs.slice(0, 40)})`);
      ui.addActivity({
        text: `${tc.name}(${toolArgs})`,
        type: 'tool',
        timestamp: new Date().toISOString(),
      });

      const result = await executeTool(tc.name, tc.arguments, toolCtx);
      const capped = result.content.length > 3000
        ? result.content.slice(0, 3000) + `\n... (${result.content.length - 3000} chars truncated)`
        : result.content;

      ui.addActivity({
        text: result.isError
          ? `${tc.name} failed: ${result.content.slice(0, 80)}`
          : `${tc.name} → ${result.content.slice(0, 80).replace(/\n/g, ' ')}`,
        type: result.isError ? 'error' : 'result',
        timestamp: new Date().toISOString(),
      });

      allToolCalls.push({
        name: tc.name,
        args: toolArgs,
        result: capped.slice(0, 300),
        isError: result.isError,
      });

      toolResults.push({
        toolCallId: tc.id,
        content: capped,
        isError: result.isError,
      });
    }

    messages.push({ role: 'tool', toolResults });

    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      finalContent = response.content || '(max tool iterations reached)';
    }
  }

  // Add final message to UI
  session.totalInputTokens += totalInputTokens;
  session.totalOutputTokens += totalOutputTokens;
  session.totalCostUsd += totalCost;

  contextManager.addAssistantMessage({
    content: finalContent,
    model: respondingModel,
    provider: 'anthropic' as ProviderId, // placeholder
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    latencyMs: 0,
  });

  const iterationCount = messages.filter(m => m.role === 'assistant').length || 1;

  ui.addMessage({
    id: `msg-${Date.now()}`,
    role: 'assistant',
    content: finalContent,
    modelLabel: respondingModel,
    timestamp: new Date().toISOString(),
    toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    stats: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCost,
      iterations: iterationCount,
      models: [...modelsUsed],
    },
  });

  await contextManager.maybeCompress();
  await contextManager.updateSessionState();
}

// ---------------------------------------------------------------------------
// Slash commands (return output as string instead of console.log)
// ---------------------------------------------------------------------------

async function handleCommand(
  input: string,
  session: Session,
  contextManager: ContextManager,
  ledger: Ledger,
  registry: ModelRegistry,
  collector: RoutingCollector,
  toolCtx: ToolContext,
): Promise<string> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/switch': {
      const newProvider = parts[1] as ProviderId | undefined;
      const newModel = parts[2];
      if (!newProvider) return 'Usage: /switch <provider> [model]';
      session.activeProvider = newProvider;
      session.activeModel = newModel;
      toolCtx.pipelineConfig.provider = newProvider;
      toolCtx.pipelineConfig.model = newModel;
      return `Switched to ${newProvider}${newModel ? '/' + newModel : ''}`;
    }

    case '/models': {
      const subcmd = parts[1];
      if (!subcmd) return registry.format();
      if (subcmd === 'enable' && parts[2]) {
        return registry.enable(parts[2]) ? `Enabled ${parts[2]}` : 'Model not found';
      }
      if (subcmd === 'disable' && parts[2]) {
        return registry.disable(parts[2]) ? `Disabled ${parts[2]}` : 'Model not found';
      }
      if (subcmd === 'add' && parts.length >= 7) {
        const alias = parts[7];
        registry.add({
          id: parts[2], name: parts[2], alias,
          provider: parts[3] as ProviderId,
          capabilities: parts[4].split(','),
          inputCostPer1M: parseFloat(parts[5]),
          outputCostPer1M: parseFloat(parts[6]),
          contextWindow: 128_000, enabled: true,
        });
        return `Added ${parts[2]}${alias ? ` (@${alias})` : ''}`;
      }
      return 'Usage: /models [enable|disable|add|remove] [args]';
    }

    case '/health': {
      await registry.checkHealth();
      return registry.formatHealth();
    }

    case '/routing':
      return collector.formatStats();

    case '/status': {
      const turns = session.messages.filter(m => m.role === 'user').length;
      const lines = [
        `Session: ${session.id.slice(0, 8)}`,
        `Provider: ${session.activeProvider}/${session.activeModel || 'default'}`,
        `Turns: ${turns} | Messages: ${session.messages.length} | Tasks: ${session.tasks.length}`,
        `Tokens: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out`,
        `Cost: $${session.totalCostUsd.toFixed(4)}`,
      ];
      if (session.state.goal) lines.push(`Goal: ${session.state.goal}`);
      if (session.state.currentPlan.length > 0) lines.push(`Plan: ${session.state.currentPlan.join(' > ')}`);
      return lines.join('\n');
    }

    case '/tasks': {
      if (session.tasks.length === 0) return 'No tasks yet.';
      return session.tasks.map(t => {
        const dur = t.completedAt
          ? `${((new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()) / 1000).toFixed(0)}s`
          : 'running';
        return `${t.id} [${t.status}] ${t.kind}: ${t.goal.slice(0, 60)} (${dur}, ${t.failures} fails)`;
      }).join('\n');
    }

    case '/ledger': {
      const phaseFilter = parts[1];
      const entries = phaseFilter
        ? ledger.getAll().filter(e => e.phase === phaseFilter)
        : ledger.getAll();
      if (entries.length === 0) return phaseFilter ? `No entries for "${phaseFilter}".` : 'Ledger is empty.';
      const header = `${'#'.padEnd(4)} ${'Phase'.padEnd(14)} ${'Model'.padEnd(30)} ${'In'.padEnd(8)} ${'Out'.padEnd(8)} ${'Cost'.padEnd(8)}`;
      const rows = entries.map(e =>
        `${e.id.slice(-4).padEnd(4)} ${e.phase.padEnd(14)} ${e.model.slice(0, 28).padEnd(30)} ${e.inputTokens.toString().padEnd(8)} ${e.outputTokens.toString().padEnd(8)} $${e.costUsd.toFixed(4)}`
      );
      return [header, '-'.repeat(80), ...rows].join('\n');
    }

    case '/cost': {
      const totals = ledger.getTotals();
      if (totals.calls === 0) return 'No calls recorded yet.';
      const lines = [`Total: ${totals.calls} calls | ${totals.inputTokens.toLocaleString()}in / ${totals.outputTokens.toLocaleString()}out | $${totals.costUsd.toFixed(4)}`, '', 'By phase:'];
      for (const [phase, data] of Object.entries(totals.byPhase).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
        lines.push(`  ${phase.padEnd(16)} ${data.calls} calls  $${data.costUsd.toFixed(4)}`);
      }
      lines.push('', 'By model:');
      for (const [model, data] of Object.entries(totals.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
        lines.push(`  ${model.slice(0, 28).padEnd(30)} ${data.calls} calls  $${data.costUsd.toFixed(4)}`);
      }
      return lines.join('\n');
    }

    case '/export': {
      const exportData = { session, ledger: ledger.getAll(), exportedAt: new Date().toISOString() };
      const filename = `kondi-chat-${session.id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(filename, JSON.stringify(exportData, null, 2));
      return `Exported to ${filename}`;
    }

    case '/help':
      return [
        'Commands:',
        '  /switch <provider> [model]   Switch provider/model',
        '  /models                      List models and aliases',
        '  /health                      Check model availability',
        '  /routing                     Routing stats and training data',
        '  /status                      Session stats and cost',
        '  /tasks                       List task cards',
        '  /ledger [phase]              Audit ledger',
        '  /cost                        Cost breakdown',
        '  /export                      Export session to JSON',
        '',
        '@mentions:',
        '  @<alias> <message>           Send to a specific model',
        '',
        'Keyboard:',
        '  Ctrl+Enter  Send  |  Ctrl+O  Toggle tools  |  Ctrl+T  Toggle stats  |  Ctrl+C  Exit',
      ].join('\n');

    case '/quit':
    case '/exit': {
      const sessionPath = resolve(toolCtx.workingDir, '.kondi-chat', `${session.id}-session.json`);
      writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      process.exit(0);
    }

    default:
      return `Unknown command: ${cmd}. Type /help for commands.`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compactOlderToolResults(messages: LLMMessage[]): void {
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs();
  const workingDir = args.dir ? resolve(args.dir) : process.cwd();
  const storageDir = resolve(workingDir, '.kondi-chat');
  mkdirSync(storageDir, { recursive: true });

  const session = createSession(args.provider, args.model, workingDir);
  const ledger = new Ledger(session.id, storageDir);
  const registry = new ModelRegistry(storageDir);
  const router = new RuleRouter(registry);
  const embeddingService = new EmbeddingService(storageDir);
  const collector = new RoutingCollector(storageDir, embeddingService);

  // Bootstrap
  if (!args.noBootstrap) {
    const depth: BootstrapDepth = args.deep ? 'deep' : 'light';
    process.stderr.write(`[bootstrap] Scanning ${workingDir} (${depth})...\n`);
    const ctx = await bootstrapDirectory(workingDir, depth);
    if (ctx) {
      session.groundingContext = ctx;
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

  // Health check
  await registry.checkHealth();
  const available = registry.getAvailable();
  const aliases = available.filter(m => m.alias).map(m => m.alias!);

  const initialStatus = `${available.length} models available | /help for commands`;

  // Render Ink app
  const onSubmit = async (input: string) => {
    await handleInput(input, session, contextManager, ledger, router, collector, registry, toolCtx);
  };

  render(<App onSubmit={onSubmit} initialStatus={initialStatus} aliases={aliases} />);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
