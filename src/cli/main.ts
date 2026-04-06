#!/usr/bin/env npx tsx
/**
 * kondi-chat — Interactive multi-model chat CLI
 *
 * Seamless model routing with efficient context management.
 *
 * Usage:
 *   npx tsx src/cli/main.ts [options]
 *
 * Options:
 *   --provider <name>     Provider: anthropic, openai, deepseek, google, xai, ollama, nvidia-router
 *   --model <name>        Model override (default per provider)
 *   --dir <path>          Working directory for codebase context
 *   --deep                Load full source files (default: light tree + key files)
 *   --budget <tokens>     Context budget in tokens (default: 30000)
 *   --system <prompt>     Custom system prompt
 *   --no-bootstrap        Skip directory context bootstrapping
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ProviderId, Session } from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';
import { ContextManager, createSession } from '../context/manager.ts';
import { bootstrapDirectory, type BootstrapDepth } from '../context/bootstrap.ts';
import { estimateTokens } from '../context/budget.ts';

// ---------------------------------------------------------------------------
// .env loader (minimal, no deps)
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
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  provider: ProviderId;
  model?: string;
  dir?: string;
  deep: boolean;
  budget: number;
  systemPrompt: string;
  noBootstrap: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    provider: 'anthropic',
    deep: false,
    budget: 30_000,
    systemPrompt: 'You are a helpful assistant. Be concise and direct.',
    noBootstrap: false,
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
      case '--help': case '-h':
        console.log(`
kondi-chat — Multi-model chat with context management

Usage: npx tsx src/cli/main.ts [options]

Options:
  --provider <name>   anthropic | openai | deepseek | google | xai | ollama | nvidia-router
  --model <name>      Model override
  --dir <path>        Working directory for codebase context
  --deep              Load full source (default: light)
  --budget <tokens>   Context budget (default: 30000)
  --system <prompt>   System prompt
  --no-bootstrap      Skip codebase loading

Commands (in chat):
  /switch <provider> [model]   Switch provider/model
  /status                      Show session stats
  /context                     Show context budget breakdown
  /export                      Export session to JSON
  /quit                        Exit
`);
        process.exit(0);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'models/gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'grok-3': { input: 3, output: 15 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] || { input: 3, output: 15 }; // default to Sonnet pricing
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs();

  // Create session
  const workingDir = args.dir ? resolve(args.dir) : process.cwd();
  const session = createSession(args.provider, args.model, workingDir);

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

  const contextManager = new ContextManager(session, {
    contextBudget: args.budget,
    systemPrompt: args.systemPrompt,
  });

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nYou: ',
  });

  const modelLabel = () => args.model || session.activeModel || 'default';
  const providerLabel = () => session.activeProvider;

  console.log(`\nkondi-chat — ${providerLabel()}/${modelLabel()}`);
  console.log(`Context budget: ${args.budget.toLocaleString()} tokens`);
  if (session.groundingContext) {
    console.log(`Codebase loaded: ${estimateTokens(session.groundingContext).toLocaleString()} tokens`);
  }
  console.log('Type /help for commands.\n');

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, session, contextManager, args);
      rl.prompt();
      return;
    }

    // Add user message
    contextManager.addUserMessage(input);

    // Assemble context
    const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();

    // Call LLM
    try {
      process.stderr.write(`[${providerLabel()}/${modelLabel()}] thinking...\n`);

      const response = await callLLM({
        provider: session.activeProvider,
        model: session.activeModel,
        systemPrompt,
        userMessage,
        cacheablePrefix,
      });

      // Record response
      contextManager.addAssistantMessage(response);

      // Print response
      const cost = estimateCost(response.model, response.inputTokens, response.outputTokens);
      session.totalCostUsd += cost;

      console.log(`\n${response.content}`);
      process.stderr.write(
        `[${response.provider}/${response.model}] ` +
        `${response.inputTokens}in/${response.outputTokens}out ` +
        `${(response.latencyMs / 1000).toFixed(1)}s ` +
        `$${cost.toFixed(4)}` +
        `${response.cached ? ' (cached)' : ''}\n`
      );

      // Background maintenance: compress and update working state
      await contextManager.maybeCompress();
      await contextManager.updateWorkingState();

    } catch (error) {
      console.error(`\nError: ${(error as Error).message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\nSession total: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out — $${session.totalCostUsd.toFixed(4)}`);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function handleCommand(
  input: string,
  session: Session,
  contextManager: ContextManager,
  args: CliArgs,
): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
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
      console.log(`Switched to ${newProvider}${newModel ? '/' + newModel : ''}`);
      return;
    }

    case '/status': {
      const turns = session.messages.filter((m: { role: string }) => m.role === 'user').length;
      console.log(`Session: ${session.id.slice(0, 8)}`);
      console.log(`Provider: ${session.activeProvider}/${session.activeModel || 'default'}`);
      console.log(`Turns: ${turns}`);
      console.log(`Messages: ${session.messages.length}`);
      console.log(`Total tokens: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out`);
      console.log(`Total cost: $${session.totalCostUsd.toFixed(4)}`);
      if (session.workingState.summary) {
        console.log(`Working state: ${session.workingState.summary}`);
      }
      return;
    }

    case '/context': {
      console.log(`Context budget: ${contextManager.getConfig().contextBudget.toLocaleString()} tokens`);
      console.log(`Recent window: ${contextManager.getConfig().recentWindowSize} turns`);
      if (session.groundingContext) {
        console.log(`Grounding context: ${estimateTokens(session.groundingContext).toLocaleString()} tokens`);
      }
      console.log(`Messages in history: ${session.messages.length}`);
      const ws = session.workingState;
      if (ws.decisions.length > 0) console.log(`Decisions tracked: ${ws.decisions.length}`);
      if (ws.openQuestions.length > 0) console.log(`Open questions: ${ws.openQuestions.length}`);
      return;
    }

    case '/export': {
      const exportData = JSON.stringify(session, null, 2);
      const filename = `kondi-chat-${session.id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filename, exportData);
      console.log(`Exported to ${filename}`);
      return;
    }

    case '/help':
      console.log(`
Commands:
  /switch <provider> [model]  Switch provider/model mid-conversation
  /status                     Session statistics and cost
  /context                    Context budget breakdown
  /export                     Export session to JSON
  /quit                       Exit
`);
      return;

    case '/quit':
    case '/exit':
      console.log(`Session total: ${session.totalInputTokens.toLocaleString()}in / ${session.totalOutputTokens.toLocaleString()}out — $${session.totalCostUsd.toFixed(4)}`);
      process.exit(0);

    default:
      console.log(`Unknown command: ${cmd}. Type /help for commands.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
