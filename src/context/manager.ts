/**
 * Context Manager — maintains conversation state across turns.
 *
 * Assembles prompts for the conversation model using:
 *   - Session state (decisions, constraints, plan)
 *   - Recent exchange window (last N turns at full fidelity)
 *   - Compressed history (older turns summarized)
 *   - Repo map (structured codebase summary)
 *   - Grounding context (raw codebase, lowest priority)
 */

import type { Message, Session, SessionState, RepoMap, LLMResponse, ProviderId } from '../types.ts';
import { ContextBudget, estimateTokens } from './budget.ts';
import { callLLM } from '../providers/llm-caller.ts';
import type { Ledger } from '../audit/ledger.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContextManagerConfig {
  contextBudget?: number;
  recentWindowSize?: number;
  compressionThreshold?: number;
  compressionProvider?: ProviderId;
  compressionModel?: string;
  systemPrompt?: string;
}

const DEFAULT_CONFIG: Required<ContextManagerConfig> = {
  contextBudget: 30_000,
  recentWindowSize: 4,
  compressionThreshold: 6,
  compressionProvider: 'anthropic',
  compressionModel: 'claude-haiku-4-5-20251001',
  systemPrompt: `You are a coding assistant with access to tools. You can read files, search code, run commands, and create task cards for code changes.

When the user asks you to implement, fix, refactor, or test something:
1. Use read_file and search_code to understand the current state
2. Use update_plan to track what you're doing
3. Use create_task to dispatch the coding work (this runs: dispatch → execute → verify → reflect)
4. Report the results

For questions about the codebase, use read_file and search_code to find answers.
For running tests or builds, use run_command.

Be concise and direct. Act on requests — don't just describe what you would do.`,
};

// ---------------------------------------------------------------------------
// Context Manager
// ---------------------------------------------------------------------------

export class ContextManager {
  private session: Session;
  private config: Required<ContextManagerConfig>;
  private compressedHistory: string = '';
  private ledger?: Ledger;

  constructor(session: Session, config?: ContextManagerConfig, ledger?: Ledger) {
    this.session = session;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ledger = ledger;
  }

  getSession(): Session { return this.session; }
  getConfig(): Required<ContextManagerConfig> { return this.config; }

  // -------------------------------------------------------------------------
  // Turn management
  // -------------------------------------------------------------------------

  addUserMessage(content: string): void {
    this.session.messages.push({
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      tokenCount: estimateTokens(content),
    });
  }

  addAssistantMessage(response: LLMResponse): void {
    this.session.messages.push({
      role: 'assistant',
      content: response.content,
      timestamp: new Date().toISOString(),
      model: response.model,
      provider: response.provider,
      tokenCount: estimateTokens(response.content),
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    this.session.totalInputTokens += response.inputTokens;
    this.session.totalOutputTokens += response.outputTokens;
  }

  // -------------------------------------------------------------------------
  // Context assembly
  // -------------------------------------------------------------------------

  /**
   * Assemble the prompt for the current turn.
   *
   * Context (session state, repo map, history, grounding) goes into the
   * system prompt so it's sent once per API call — NOT in the user message.
   * This prevents re-sending the full context on every tool-use iteration.
   *
   * The user message contains only the raw user input.
   */
  assemblePrompt(): { systemPrompt: string; userMessage: string; cacheablePrefix?: string } {
    const budget = new ContextBudget(this.config.contextBudget);
    const currentMessage = this.session.messages[this.session.messages.length - 1];

    // Priority 1: Session state (always fits — small and fixed-size)
    const stateText = this.formatSessionState();
    if (stateText) {
      budget.add('session-state', `## Session State\n${stateText}`, 1, false);
    }

    // Priority 2: Repo map (small, structured)
    if (this.session.repoMap) {
      const mapText = this.formatRepoMap();
      budget.add('repo-map', `## Repo Map\n${mapText}`, 2, false);
    }

    // Priority 3: Recent exchange window
    const recentWindow = this.getRecentWindow();
    if (recentWindow) {
      budget.add('recent-exchanges', `## Recent Conversation\n${recentWindow}`, 3, true);
    }

    // Priority 4: Compressed history
    if (this.compressedHistory) {
      budget.add('compressed-history', `## Earlier Discussion\n${this.compressedHistory}`, 4, true);
    }

    // Priority 5: Grounding context (raw codebase — big, expendable)
    if (this.session.groundingContext) {
      budget.add('grounding-context', `## Project Files\n${this.session.groundingContext}`, 5, true);
    }

    const assembledContext = budget.assemble();

    const dropped = budget.getDropped();
    const compressed = budget.getCompressed();
    if (dropped.length > 0 || compressed.length > 0) {
      const parts: string[] = [];
      if (compressed.length > 0) parts.push(`truncated: ${compressed.join(', ')}`);
      if (dropped.length > 0) parts.push(`dropped: ${dropped.join(', ')}`);
      process.stderr.write(`[context] Budget ${this.config.contextBudget} tokens — ${parts.join('; ')}\n`);
    }

    // Build system prompt: base instructions + assembled context
    // This is sent once per call, not repeated in tool-use iterations
    const systemParts = [this.config.systemPrompt];
    if (assembledContext) {
      systemParts.push(assembledContext);
    }
    const fullSystemPrompt = systemParts.join('\n\n---\n\n');

    // Grounding context can be cached (Anthropic prompt caching)
    let cacheablePrefix: string | undefined;
    if (this.session.groundingContext && !dropped.includes('grounding-context')) {
      cacheablePrefix = `## Project Files\n${this.session.groundingContext}`;
    }

    return {
      systemPrompt: fullSystemPrompt,
      userMessage: currentMessage.content,
      cacheablePrefix,
    };
  }

  // -------------------------------------------------------------------------
  // Compression & state updates
  // -------------------------------------------------------------------------

  async maybeCompress(): Promise<void> {
    const messages = this.session.messages;
    const totalTurns = messages.filter(m => m.role === 'user').length;
    if (totalTurns < this.config.compressionThreshold) return;

    const recentCount = this.config.recentWindowSize * 2;
    const toCompress = messages.slice(0, messages.length - recentCount);
    if (toCompress.length === 0) return;

    const transcript = toCompress.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
    const existing = this.compressedHistory
      ? `Previous summary:\n${this.compressedHistory}\n\nNew messages:\n`
      : '';

    try {
      const response = await callLLM({
        provider: this.config.compressionProvider,
        model: this.config.compressionModel,
        systemPrompt: 'Summarize this conversation concisely. Preserve all technical decisions, code references, and constraints. Past tense. No commentary.',
        userMessage: `${existing}${transcript}\n\nSummarize (max 500 words):`,
        maxOutputTokens: 1000,
        temperature: 0,
      });

      this.compressedHistory = response.content;
      this.session.totalInputTokens += response.inputTokens;
      this.session.totalOutputTokens += response.outputTokens;

      this.ledger?.record('compress', response, 'Conversation compression');
    } catch (error) {
      process.stderr.write(`[context] Compression failed: ${(error as Error).message}\n`);
    }
  }

  async updateSessionState(): Promise<void> {
    const messages = this.session.messages;
    if (messages.length < 2) return;

    const turnCount = messages.filter(m => m.role === 'user').length;
    if (turnCount <= this.session.state.lastUpdatedAtTurn + 1) return;

    const lastExchange = messages.slice(-4).map(m => `[${m.role}]: ${m.content}`).join('\n\n');
    const currentState = this.formatSessionState();

    try {
      const response = await callLLM({
        provider: this.config.compressionProvider,
        model: this.config.compressionModel,
        systemPrompt: `Update the session state. Output ONLY valid JSON:
{
  "goal": "current goal",
  "decisions": ["decision 1"],
  "constraints": ["constraint 1"],
  "currentPlan": ["step 1", "step 2"],
  "recentFailures": ["failure 1"]
}
Keep lists short (max 5 items). Remove resolved items.`,
        userMessage: `Current state:\n${currentState || '(empty)'}\n\nLatest exchange:\n${lastExchange}\n\nUpdated state as JSON:`,
        maxOutputTokens: 800,
        temperature: 0,
      });

      const parsed = JSON.parse(response.content);
      this.session.state = {
        ...this.session.state,
        goal: parsed.goal || this.session.state.goal,
        decisions: parsed.decisions || this.session.state.decisions,
        constraints: parsed.constraints || this.session.state.constraints,
        currentPlan: parsed.currentPlan || this.session.state.currentPlan,
        recentFailures: parsed.recentFailures || this.session.state.recentFailures,
        lastUpdatedAtTurn: turnCount,
      };

      this.session.totalInputTokens += response.inputTokens;
      this.session.totalOutputTokens += response.outputTokens;

      this.ledger?.record('state_update', response, 'Session state update');
    } catch {
      // Non-fatal
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getRecentWindow(): string {
    const messages = this.session.messages;
    const windowMessages = messages.slice(-(this.config.recentWindowSize * 2 + 1), -1);
    if (windowMessages.length === 0) return '';
    return windowMessages
      .map(m => `[${m.role}${m.model ? ` (${m.model})` : ''}]: ${m.content}`)
      .join('\n\n');
  }

  private formatSessionState(): string {
    const s = this.session.state;
    if (!s.goal && s.decisions.length === 0 && s.currentPlan.length === 0) return '';

    const parts: string[] = [];
    if (s.goal) parts.push(`Goal: ${s.goal}`);
    if (s.currentPlan.length > 0) parts.push(`Plan: ${s.currentPlan.join(' → ')}`);
    if (s.decisions.length > 0) parts.push(`Decisions: ${s.decisions.join('; ')}`);
    if (s.constraints.length > 0) parts.push(`Constraints: ${s.constraints.join('; ')}`);
    if (s.activeTaskId) parts.push(`Active task: ${s.activeTaskId}`);
    if (s.recentFailures.length > 0) parts.push(`Recent failures: ${s.recentFailures.join('; ')}`);
    return parts.join('\n');
  }

  private formatRepoMap(): string {
    const r = this.session.repoMap;
    if (!r) return '';
    const parts: string[] = [];
    parts.push(`Stack: ${r.stack.join(', ')}`);
    if (r.entrypoints.length > 0) parts.push(`Entrypoints: ${r.entrypoints.join(', ')}`);
    if (r.subsystems.length > 0) {
      parts.push('Subsystems:');
      for (const s of r.subsystems) {
        parts.push(`  ${s.name} (${s.paths.join(', ')}): ${s.purpose}`);
      }
    }
    const cmds = r.commands;
    const cmdParts = [];
    if (cmds.build) cmdParts.push(`build: ${cmds.build}`);
    if (cmds.test) cmdParts.push(`test: ${cmds.test}`);
    if (cmds.lint) cmdParts.push(`lint: ${cmds.lint}`);
    if (cmds.typecheck) cmdParts.push(`typecheck: ${cmds.typecheck}`);
    if (cmdParts.length > 0) parts.push(`Commands: ${cmdParts.join(', ')}`);
    if (r.conventions.length > 0) parts.push(`Conventions: ${r.conventions.join('; ')}`);
    return parts.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSession(provider: ProviderId, model?: string, workingDirectory?: string): Session {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    workingDirectory,
    messages: [],
    state: {
      goal: '',
      decisions: [],
      constraints: [],
      currentPlan: [],
      recentFailures: [],
      lastUpdatedAtTurn: 0,
    },
    tasks: [],
    activeProvider: provider,
    activeModel: model,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  };
}
