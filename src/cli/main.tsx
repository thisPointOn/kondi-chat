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
import { AGENT_TOOLS, type ToolContext } from '../engine/tools.ts';
import { ModelRegistry } from '../router/registry.ts';
import { RuleRouter } from '../router/rules.ts';
import { RoutingCollector } from '../router/collector.ts';
import { EmbeddingService } from '../router/embeddings.ts';
import { ProfileManager, type ProfileName } from '../router/profiles.ts';
import { LoopGuard } from '../engine/loop-guard.ts';
import { McpClientManager } from '../mcp/client.ts';
import { loadMcpConfig, saveMcpServer, removeMcpServer } from '../mcp/config.ts';
import { ToolManager } from '../mcp/tool-manager.ts';
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
        // Fall back to old REPL mode — handled in main()
        opts.provider = 'repl' as ProviderId;
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
  toolManager: ToolManager,
  mcpClient: McpClientManager,
  workingDir: string,
  profiles: ProfileManager,
): Promise<void> {
  const ui = getUI();

  // Slash commands
  if (input.startsWith('/')) {
    const output = await handleCommand(input, session, contextManager, ledger, registry, collector, toolCtx, mcpClient, toolManager, workingDir, profiles, router);
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

    await contextManager.maybeCompact();
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

    // Add a streaming placeholder message
    const streamMsgId = `msg-stream-${Date.now()}`;
    let streamContent = '';

    // Only stream the first text response (not tool-use iterations where we need the full response)
    const shouldStream = iteration === 0;

    if (shouldStream) {
      ui.addMessage({
        id: streamMsgId,
        role: 'assistant',
        content: '',
        modelLabel: respondingModel,
        timestamp: new Date().toISOString(),
      });
    }

    const response = await callLLM({
      provider: decision.model.provider,
      model: decision.model.id,
      systemPrompt,
      messages,
      tools: toolManager.getTools('discuss'),
      maxOutputTokens: 8192,
      cacheablePrefix,
      stream: true,
      onToken: shouldStream ? (token: string) => {
        streamContent += token;
        ui.updateLastAssistant({ content: streamContent });
      } : undefined,
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
    }, userMessage).catch(e => {
      process.stderr.write(`[embedding] ${(e as Error).message}\n`);
    });

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

    // No tool calls — final response (streaming message already shows it)
    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content;
      // Update the streaming message with final stats
      if (shouldStream) {
        ui.updateLastAssistant({
          content: finalContent,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          stats: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd: totalCost,
            iterations: messages.filter(m => m.role === 'assistant').length || 1,
            models: [...modelsUsed],
          },
        });
      }
      break;
    }

    // Tool calls — remove the streaming placeholder (model isn't done yet)
    if (shouldStream) {
      // Replace streaming message content with what we have so far
      ui.updateLastAssistant({ content: response.content || '(using tools...)' });
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

      const result = await toolManager.execute(tc.name, tc.arguments, toolCtx);
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

  // Track in session
  session.totalInputTokens += totalInputTokens;
  session.totalOutputTokens += totalOutputTokens;
  session.totalCostUsd += totalCost;

  contextManager.addAssistantMessage({
    content: finalContent,
    model: respondingModel,
    provider: 'openai' as ProviderId,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    latencyMs: 0,
  });

  const iterationCount = messages.filter(m => m.role === 'assistant').length || 1;
  const finalStats = {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: totalCost,
    iterations: iterationCount,
    models: [...modelsUsed],
  };

  // If we didn't stream (multi-iteration with tools), add the final message now
  // If we did stream, the message was already added and updated above
  if (iterationCount > 1) {
    // Multi-iteration: add a fresh final message with everything
    ui.addMessage({
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: finalContent,
      modelLabel: respondingModel,
      timestamp: new Date().toISOString(),
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      stats: finalStats,
    });
  } else {
    // Single iteration: streaming message already exists, just update stats
    ui.updateLastAssistant({
      stats: finalStats,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    });
  }

  await contextManager.maybeCompact();
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
  mcpClient: McpClientManager,
  toolManager: ToolManager,
  workingDir: string,
  profiles: ProfileManager,
  router: RuleRouter,
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
      const budget = contextManager.getBudgetStatus();
      const lines = [
        `Session: ${session.id.slice(0, 8)}`,
        `Provider: ${session.activeProvider}/${session.activeModel || 'default'}`,
        `Turns: ${turns} | Messages: ${session.messages.length} | Tasks: ${session.tasks.length}`,
        `Tokens: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out`,
        `Cost: $${session.totalCostUsd.toFixed(4)}`,
        `Context: ${budget.currentContextSize.toLocaleString()}/${budget.modelContextWindow.toLocaleString()} tokens (${(budget.contextUtilization * 100).toFixed(0)}%)`,
        `Compactions: ${budget.compactionCount} | Cache hit rate: ${(budget.cacheHitRate * 100).toFixed(0)}%`,
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

    case '/mode': {
      const mode = parts[1] as ProfileName | undefined;
      if (!mode) return profiles.format();
      try {
        profiles.setProfile(mode);
        router.setProfile(profiles.getActive());
        const p = profiles.getActive();
        return `Mode: ${p.name} — ${p.description}\nContext: ${p.contextBudget.toLocaleString()} | Loop: ${p.loopIterationCap} iters, $${p.loopCostCap.toFixed(2)} cap | Local: ${p.preferLocal ? 'yes' : 'no'}`;
      } catch (e) {
        return (e as Error).message;
      }
    }

    case '/loop': {
      // /loop [mode] "task description"
      let loopMode: ProfileName = profiles.getActive().name;
      let taskDesc = parts.slice(1).join(' ');

      // Check if first arg is a mode name
      if (['quality', 'balanced', 'cheap'].includes(parts[1])) {
        loopMode = parts[1] as ProfileName;
        taskDesc = parts.slice(2).join(' ');
      }

      if (!taskDesc) {
        return 'Usage: /loop [mode] <task description>\nModes: quality, balanced, cheap';
      }

      const loopProfile = profiles.getProfile(loopMode);
      const guard = new LoopGuard(loopProfile);

      // Save current profile, switch to loop profile
      const savedProfile = profiles.getActive().name;
      profiles.setProfile(loopMode);
      router.setProfile(profiles.getActive());

      const ui = getUI();
      ui.addMessage({
        id: `msg-${Date.now()}`,
        role: 'system',
        content: `Starting loop (${loopMode}): ${taskDesc}\nLimits: ${loopProfile.loopIterationCap} iterations, $${loopProfile.loopCostCap.toFixed(2)} cost cap`,
        timestamp: new Date().toISOString(),
      });

      let lastResult = '';
      while (true) {
        const status = guard.check();
        if (status.shouldStop) {
          ui.addMessage({
            id: `msg-${Date.now()}`,
            role: 'system',
            content: `Loop stopped: ${status.stopReason}\n${guard.getSummary()}\n\nLast result:\n${lastResult.slice(0, 500)}`,
            timestamp: new Date().toISOString(),
          });
          break;
        }

        ui.setStatus(`loop ${status.iteration + 1}/${status.maxIterations} ($${status.costUsd.toFixed(4)})`);

        const iterStart = session.totalCostUsd;
        try {
          // Run one iteration of the agent
          contextManager.addUserMessage(
            status.iteration === 0
              ? taskDesc
              : `Continue working on: ${taskDesc}\n\nPrevious result: ${lastResult.slice(0, 1000)}\nIteration ${status.iteration + 1}. Fix any remaining issues.`
          );
          const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();

          const decision = router.select('discuss');
          const response = await callLLM({
            provider: decision.model.provider,
            model: decision.model.id,
            systemPrompt,
            userMessage,
            tools: toolManager.getTools('discuss'),
            maxOutputTokens: loopProfile.maxOutputTokens,
            cacheablePrefix,
            stream: true,
            onToken: (token) => {
              lastResult += token;
              ui.updateLastAssistant({ content: lastResult.slice(-2000) });
            },
          });

          lastResult = response.content;
          const iterCost = session.totalCostUsd - iterStart;

          contextManager.addAssistantMessage(response);
          ledger.record('discuss', response, taskDesc.slice(0, 200));

          // Check for errors in the response
          const hasError = response.content.toLowerCase().includes('error') ||
                          response.content.toLowerCase().includes('failed');
          guard.recordIteration(iterCost, hasError ? response.content.slice(0, 200) : undefined);

          ui.addMessage({
            id: `msg-${Date.now()}`,
            role: 'assistant',
            content: response.content,
            modelLabel: decision.model.alias || decision.model.name,
            timestamp: new Date().toISOString(),
            stats: {
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
              costUsd: iterCost,
              iterations: 1,
              models: [response.model],
            },
          });

          await contextManager.maybeCompact();
        } catch (error) {
          guard.recordIteration(session.totalCostUsd - iterStart, (error as Error).message);
          ui.addMessage({
            id: `msg-${Date.now()}`,
            role: 'system',
            content: `Loop iteration error: ${(error as Error).message}`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Restore previous profile
      profiles.setProfile(savedProfile);
      router.setProfile(profiles.getActive());

      return `Loop complete. ${guard.getSummary()}`;
    }

    case '/mcp': {
      const subcmd = parts[1];
      if (!subcmd || subcmd === 'list') {
        const summary = toolManager.getSummary();
        return [
          mcpClient.format(),
          '',
          `Tools: ${summary.builtIn} built-in + ${summary.mcp} MCP = ${summary.builtIn + summary.mcp} total`,
        ].join('\n');
      }
      if (subcmd === 'add' && parts[2]) {
        const name = parts[2];
        if (parts[3] === 'http' && parts[4]) {
          // Remote: /mcp add name http https://url
          const cfg = { type: 'http' as const, url: parts[4] };
          saveMcpServer(workingDir, name, cfg);
          const state = await mcpClient.connect(name, { ...cfg, scope: 'project' as const });
          return state.status === 'connected'
            ? `Added remote server ${name} (${state.tools.length} tools)`
            : `Added ${name} but connection failed: ${state.error}`;
        }
        if (parts[3]) {
          // Local: /mcp add name command [args...]
          const cfg = { command: parts[3], args: parts.slice(4) };
          saveMcpServer(workingDir, name, cfg);
          const state = await mcpClient.connect(name, { ...cfg, scope: 'project' as const });
          return state.status === 'connected'
            ? `Added local server ${name} (${state.tools.length} tools)`
            : `Added ${name} but connection failed: ${state.error}`;
        }
        return 'Usage: /mcp add <name> <command> [args...] or /mcp add <name> http <url>';
      }
      if (subcmd === 'remove' && parts[2]) {
        await mcpClient.disconnect(parts[2]);
        removeMcpServer(workingDir, parts[2]);
        return `Removed ${parts[2]}`;
      }
      if (subcmd === 'reconnect') {
        const configs = loadMcpConfig(workingDir);
        await mcpClient.disconnectAll();
        await mcpClient.connectAll(configs);
        return mcpClient.format();
      }
      return [
        'Usage:',
        '  /mcp                        List servers and tools',
        '  /mcp add <name> <cmd> [args]  Add local stdio server',
        '  /mcp add <name> http <url>    Add remote HTTP server',
        '  /mcp remove <name>            Remove a server',
        '  /mcp reconnect                Reconnect all servers',
      ].join('\n');
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
        '  /mode [quality|balanced|cheap]  Set cost/quality mode',
        '  /loop [mode] <task>          Run autonomous loop with guards',
        '  /mcp                         List MCP servers and tools',
        '  /mcp add <name> <cmd> [args]  Add local MCP server',
        '  /mcp add <name> http <url>    Add remote MCP server',
        '  /mcp remove <name>            Remove an MCP server',
        '  /export                      Export session to JSON',
        '',
        '@mentions:',
        '  @<alias> <message>           Send to a specific model',
        '',
        'Keyboard:',
        '  Enter:send  ^N:newline  ^O:tools  ^T:stats  ^M:message  ^A:activity  ^C:exit',
      ].join('\n');

    case '/quit':
    case '/exit': {
      const sessionPath = resolve(toolCtx.workingDir, '.kondi-chat', `${session.id}-session.json`);
      writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      await mcpClient.disconnectAll();
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

  // --repl flag: delegate to old REPL and exit
  if (args.provider === ('repl' as ProviderId)) {
    await import('./main-repl.ts');
    return;
  }

  const workingDir = args.dir ? resolve(args.dir) : process.cwd();
  const storageDir = resolve(workingDir, '.kondi-chat');
  mkdirSync(storageDir, { recursive: true });

  const session = createSession(args.provider, args.model, workingDir);
  const ledger = new Ledger(session.id, storageDir);
  const registry = new ModelRegistry(storageDir);
  const router = new RuleRouter(registry);
  const profiles = new ProfileManager('balanced');
  router.setProfile(profiles.getActive());
  const embeddingService = new EmbeddingService(storageDir);
  const collector = new RoutingCollector(storageDir, embeddingService);

  // MCP servers
  const mcpClient = new McpClientManager();
  const mcpConfigs = loadMcpConfig(workingDir);
  if (mcpConfigs.size > 0) {
    process.stderr.write(`[mcp] Connecting to ${mcpConfigs.size} server(s)...\n`);
    await mcpClient.connectAll(mcpConfigs);
  }
  const toolManager = new ToolManager(mcpClient);

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

  const initialStatus = `${available.length} models | mode: ${profiles.getActive().name} | /help for commands`;

  // Render Ink app
  const onSubmit = async (input: string) => {
    await handleInput(input, session, contextManager, ledger, router, collector, registry, toolCtx, toolManager, mcpClient, workingDir, profiles);
  };

  render(<App onSubmit={onSubmit} initialStatus={initialStatus} aliases={aliases} />);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
