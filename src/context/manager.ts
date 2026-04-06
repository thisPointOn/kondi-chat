/**
 * Context Manager — maintains conversation state across turns.
 *
 * The core abstraction for model-agnostic context management.
 * Maintains:
 *   - Full message history (for export, never sent raw to models)
 *   - Working state (semantic summary, updated progressively)
 *   - Recent exchange window (last N turns at full fidelity)
 *   - Compressed history (older turns summarized)
 *   - Grounding context (codebase/docs, loaded once)
 *
 * On each turn, assembles a prompt from these pieces within a token budget.
 */

import type { Message, Session, WorkingState, LLMResponse, ProviderId } from '../types.ts';
import { ContextBudget, estimateTokens } from './budget.ts';
import { callLLM } from '../providers/llm-caller.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContextManagerConfig {
  /** Max tokens for assembled context (default 30K — conservative for router) */
  contextBudget?: number;
  /** Number of recent turns to keep at full fidelity (default 4) */
  recentWindowSize?: number;
  /** Trigger compression when history exceeds this many turns (default 6) */
  compressionThreshold?: number;
  /** Provider/model to use for compression (default: same as active) */
  compressionProvider?: ProviderId;
  compressionModel?: string;
  /** System prompt for the assistant */
  systemPrompt?: string;
}

const DEFAULT_CONFIG: Required<ContextManagerConfig> = {
  contextBudget: 30_000,
  recentWindowSize: 4,
  compressionThreshold: 6,
  compressionProvider: 'anthropic',
  compressionModel: 'claude-haiku-4-5-20251001',
  systemPrompt: 'You are a helpful assistant.',
};

// ---------------------------------------------------------------------------
// Context Manager
// ---------------------------------------------------------------------------

export class ContextManager {
  private session: Session;
  private config: Required<ContextManagerConfig>;

  /** Compressed narrative of older turns */
  private compressedHistory: string = '';

  constructor(session: Session, config?: ContextManagerConfig) {
    this.session = session;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getSession(): Session {
    return this.session;
  }

  getConfig(): Required<ContextManagerConfig> {
    return this.config;
  }

  // -------------------------------------------------------------------------
  // Turn management
  // -------------------------------------------------------------------------

  /** Record a user message */
  addUserMessage(content: string): void {
    this.session.messages.push({
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      tokenCount: estimateTokens(content),
    });
  }

  /** Record an assistant response */
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

    // Update cost tracking
    this.session.totalInputTokens += response.inputTokens;
    this.session.totalOutputTokens += response.outputTokens;
  }

  // -------------------------------------------------------------------------
  // Context assembly — the core function
  // -------------------------------------------------------------------------

  /**
   * Assemble the prompt to send to the LLM for the current turn.
   * Returns { systemPrompt, userMessage } ready for callLLM.
   */
  assemblePrompt(): { systemPrompt: string; userMessage: string; cacheablePrefix?: string } {
    const budget = new ContextBudget(this.config.contextBudget);

    // Priority 1: Current user message (the latest turn, always included)
    const currentMessage = this.session.messages[this.session.messages.length - 1];
    // This goes directly as userMessage, not in the budget

    // Priority 2: Working state
    const workingStateText = this.formatWorkingState();
    if (workingStateText) {
      budget.add('working-state', `## Conversation State\n${workingStateText}`, 2, false);
    }

    // Priority 3: Recent exchange window (last N turns, full fidelity)
    const recentWindow = this.getRecentWindow();
    if (recentWindow) {
      budget.add('recent-exchanges', `## Recent Conversation\n${recentWindow}`, 3, true);
    }

    // Priority 4: Compressed history
    if (this.compressedHistory) {
      budget.add('compressed-history', `## Earlier Discussion\n${this.compressedHistory}`, 4, true);
    }

    // Priority 5: Grounding context (codebase, docs)
    if (this.session.groundingContext) {
      budget.add('grounding-context', `## Project Context\n${this.session.groundingContext}`, 5, true);
    }

    const assembledContext = budget.assemble();

    // Log budget info
    const dropped = budget.getDropped();
    const compressed = budget.getCompressed();
    if (dropped.length > 0 || compressed.length > 0) {
      const parts: string[] = [];
      if (compressed.length > 0) parts.push(`truncated: ${compressed.join(', ')}`);
      if (dropped.length > 0) parts.push(`dropped: ${dropped.join(', ')}`);
      process.stderr.write(`[context] Budget ${this.config.contextBudget} tokens — ${parts.join('; ')}\n`);
    }

    // Grounding context can be cached (Anthropic) — separate it if present
    let cacheablePrefix: string | undefined;
    if (this.session.groundingContext && !dropped.includes('grounding-context')) {
      cacheablePrefix = `## Project Context\n${this.session.groundingContext}`;
    }

    return {
      systemPrompt: this.config.systemPrompt,
      userMessage: assembledContext
        ? `${assembledContext}\n\n---\n\n${currentMessage.content}`
        : currentMessage.content,
      cacheablePrefix,
    };
  }

  // -------------------------------------------------------------------------
  // Compression
  // -------------------------------------------------------------------------

  /**
   * Compress older messages into a narrative summary.
   * Called automatically when history exceeds compressionThreshold.
   */
  async maybeCompress(): Promise<void> {
    const messages = this.session.messages;
    const totalTurns = messages.filter(m => m.role === 'user').length;

    if (totalTurns < this.config.compressionThreshold) return;

    // Messages outside the recent window that haven't been compressed yet
    const recentCount = this.config.recentWindowSize * 2; // user+assistant pairs
    const toCompress = messages.slice(0, messages.length - recentCount);

    if (toCompress.length === 0) return;

    const transcript = toCompress
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    const existingHistory = this.compressedHistory
      ? `Previous summary:\n${this.compressedHistory}\n\nNew messages to incorporate:\n`
      : '';

    try {
      const response = await callLLM({
        provider: this.config.compressionProvider,
        model: this.config.compressionModel,
        systemPrompt: 'You are a conversation summarizer. Produce a concise narrative summary that preserves all key decisions, technical details, constraints, and context. Do not add commentary. Write in past tense.',
        userMessage: `${existingHistory}${transcript}\n\nSummarize the above conversation into a concise narrative (max 500 words). Preserve all technical decisions, code references, and architectural choices.`,
        maxOutputTokens: 1000,
        temperature: 0,
      });

      this.compressedHistory = response.content;

      // Track compression cost
      this.session.totalInputTokens += response.inputTokens;
      this.session.totalOutputTokens += response.outputTokens;
    } catch (error) {
      // Compression failure is non-fatal — proceed without it
      process.stderr.write(`[context] Compression failed: ${(error as Error).message}\n`);
    }
  }

  /**
   * Update working state based on the latest exchange.
   * Uses a cheap model to extract decisions, constraints, and updates.
   */
  async updateWorkingState(): Promise<void> {
    const messages = this.session.messages;
    if (messages.length < 2) return;

    // Only update every 2 turns to save calls
    const turnCount = messages.filter(m => m.role === 'user').length;
    if (turnCount <= this.session.workingState.lastUpdatedAtTurn + 1) return;

    const lastExchange = messages.slice(-4).map(m => `[${m.role}]: ${m.content}`).join('\n\n');

    const currentState = this.formatWorkingState();

    try {
      const response = await callLLM({
        provider: this.config.compressionProvider,
        model: this.config.compressionModel,
        systemPrompt: `You update a working state document for a conversation. Output ONLY valid JSON matching this shape:
{
  "summary": "1-3 sentence summary of conversation so far",
  "decisions": ["decision 1", "decision 2"],
  "constraints": ["constraint 1"],
  "openQuestions": ["question 1"],
  "rejectedApproaches": ["approach 1 — reason"]
}
Keep lists short (max 5 items each). Remove resolved questions. Remove old decisions that are superseded.`,
        userMessage: `Current state:\n${currentState || '(empty — first update)'}\n\nLatest exchange:\n${lastExchange}\n\nOutput updated state as JSON:`,
        maxOutputTokens: 800,
        temperature: 0,
      });

      const parsed = JSON.parse(response.content);
      this.session.workingState = {
        summary: parsed.summary || this.session.workingState.summary,
        decisions: parsed.decisions || this.session.workingState.decisions,
        constraints: parsed.constraints || this.session.workingState.constraints,
        openQuestions: parsed.openQuestions || this.session.workingState.openQuestions,
        rejectedApproaches: parsed.rejectedApproaches || this.session.workingState.rejectedApproaches,
        lastUpdatedAtTurn: turnCount,
      };

      this.session.totalInputTokens += response.inputTokens;
      this.session.totalOutputTokens += response.outputTokens;
    } catch {
      // Working state update failure is non-fatal
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getRecentWindow(): string {
    const messages = this.session.messages;
    // Last N turns (user+assistant pairs) — excluding the very latest user message
    // which goes as the actual userMessage
    const windowMessages = messages.slice(-(this.config.recentWindowSize * 2 + 1), -1);

    if (windowMessages.length === 0) return '';

    return windowMessages
      .map(m => `[${m.role}${m.model ? ` (${m.model})` : ''}]: ${m.content}`)
      .join('\n\n');
  }

  private formatWorkingState(): string {
    const ws = this.session.workingState;
    if (!ws.summary && ws.decisions.length === 0) return '';

    const parts: string[] = [];
    if (ws.summary) parts.push(ws.summary);
    if (ws.decisions.length > 0) parts.push(`Decisions: ${ws.decisions.join('; ')}`);
    if (ws.constraints.length > 0) parts.push(`Constraints: ${ws.constraints.join('; ')}`);
    if (ws.openQuestions.length > 0) parts.push(`Open questions: ${ws.openQuestions.join('; ')}`);
    if (ws.rejectedApproaches.length > 0) parts.push(`Rejected: ${ws.rejectedApproaches.join('; ')}`);
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
    workingState: {
      summary: '',
      decisions: [],
      constraints: [],
      openQuestions: [],
      rejectedApproaches: [],
      lastUpdatedAtTurn: 0,
    },
    activeProvider: provider,
    activeModel: model,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  };
}
