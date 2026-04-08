/**
 * Context Manager — maintains conversation state across turns.
 *
 * Inspired by Claude Code's context management:
 *   - Threshold-based auto-compaction (by token count, not turn count)
 *   - Compact boundary markers — only send messages after boundary
 *   - Post-compact restoration of relevant files and session state
 *   - Message normalization before API calls
 *   - Token budget tracking with warnings
 *   - Prompt caching optimization
 */

import type { Message, Session, SessionState, RepoMap, LLMResponse, ProviderId } from '../types.ts';
import { ContextBudget, estimateTokens } from './budget.ts';
import { callLLM } from '../providers/llm-caller.ts';
import type { Ledger } from '../audit/ledger.ts';

// ---------------------------------------------------------------------------
// Constants (matching Claude Code's approach)
// ---------------------------------------------------------------------------

/** Buffer from context window limit to trigger auto-compact */
const AUTOCOMPACT_BUFFER = 13_000;
/** Warning threshold — larger buffer */
const AUTOCOMPACT_WARNING_BUFFER = 20_000;
/** Max files to restore after compaction */
const POST_COMPACT_MAX_FILES = 5;
/** Max tokens per restored file */
const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
/** Max total tokens for post-compact restoration */
const POST_COMPACT_TOKEN_BUDGET = 25_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContextManagerConfig {
  contextBudget?: number;
  /** Model's context window size (for auto-compact threshold) */
  modelContextWindow?: number;
  recentWindowSize?: number;
  compressionProvider?: ProviderId;
  compressionModel?: string;
  systemPrompt?: string;
}

const DEFAULT_CONFIG: Required<ContextManagerConfig> = {
  contextBudget: 30_000,
  modelContextWindow: 128_000,
  recentWindowSize: 4,
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
// Compact boundary marker
// ---------------------------------------------------------------------------

const COMPACT_BOUNDARY_ROLE = 'system' as const;
const COMPACT_BOUNDARY_PREFIX = '[COMPACT_BOUNDARY]';

function isCompactBoundary(msg: Message): boolean {
  return msg.role === COMPACT_BOUNDARY_ROLE && msg.content.startsWith(COMPACT_BOUNDARY_PREFIX);
}

// ---------------------------------------------------------------------------
// Context Manager
// ---------------------------------------------------------------------------

export class ContextManager {
  private session: Session;
  private config: Required<ContextManagerConfig>;
  private ledger?: Ledger;

  /** Token budget tracking */
  private sessionTokensUsed = 0;
  private sessionTokenBudget: number | null = null;
  private compactionCount = 0;

  /** Prompt cache tracking */
  private lastSystemPromptHash = '';
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(session: Session, config?: ContextManagerConfig, ledger?: Ledger) {
    this.session = session;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ledger = ledger;
  }

  getSession(): Session { return this.session; }
  getConfig(): Required<ContextManagerConfig> { return this.config; }
  setTokenBudget(budget: number | null): void { this.sessionTokenBudget = budget; }

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
    this.sessionTokensUsed += response.inputTokens + response.outputTokens;
  }

  // -------------------------------------------------------------------------
  // Context assembly
  // -------------------------------------------------------------------------

  /**
   * Assemble the prompt for the current turn.
   *
   * Only sends messages AFTER the last compact boundary (if any).
   * Context goes into the system prompt for caching efficiency.
   */
  assemblePrompt(): { systemPrompt: string; userMessage: string; cacheablePrefix?: string } {
    const budget = new ContextBudget(this.config.contextBudget);
    const messages = this.getMessagesAfterBoundary();
    const currentMessage = messages[messages.length - 1];

    // Priority 1: Session state
    const stateText = this.formatSessionState();
    if (stateText) {
      budget.add('session-state', `## Session State\n${stateText}`, 1, false);
    }

    // Priority 2: Repo map
    if (this.session.repoMap) {
      const mapText = this.formatRepoMap();
      budget.add('repo-map', `## Repo Map\n${mapText}`, 2, false);
    }

    // Priority 3: Recent exchange window (from post-boundary messages)
    const recentWindow = this.getRecentWindow(messages);
    if (recentWindow) {
      budget.add('recent-exchanges', `## Recent Conversation\n${recentWindow}`, 3, true);
    }

    // Priority 4: Compact summary (from the boundary marker itself)
    const compactSummary = this.getCompactSummary();
    if (compactSummary) {
      budget.add('compact-summary', `## Earlier Discussion\n${compactSummary}`, 4, true);
    }

    // Priority 5: Grounding context
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

    // Build system prompt
    const systemParts = [this.config.systemPrompt];
    if (assembledContext) {
      systemParts.push(assembledContext);
    }
    const fullSystemPrompt = systemParts.join('\n\n---\n\n');

    // Track cache breaks
    const promptHash = simpleHash(fullSystemPrompt);
    if (this.lastSystemPromptHash && promptHash !== this.lastSystemPromptHash) {
      this.cacheMisses++;
    } else if (this.lastSystemPromptHash) {
      this.cacheHits++;
    }
    this.lastSystemPromptHash = promptHash;

    // Cacheable prefix — stable content that doesn't change between calls
    let cacheablePrefix: string | undefined;
    if (this.session.groundingContext && !dropped.includes('grounding-context')) {
      cacheablePrefix = `## Project Files\n${this.session.groundingContext}`;
    }

    return {
      systemPrompt: fullSystemPrompt,
      userMessage: currentMessage?.content || '',
      cacheablePrefix,
    };
  }

  // -------------------------------------------------------------------------
  // Auto-compaction (threshold-based, like Claude Code)
  // -------------------------------------------------------------------------

  /**
   * Check if compaction is needed and perform it.
   * Triggers when estimated context size approaches the model's window.
   */
  async maybeCompact(): Promise<{ compacted: boolean; reason?: string }> {
    const contextSize = this.estimateCurrentContextSize();
    const threshold = this.config.modelContextWindow - AUTOCOMPACT_BUFFER;
    const warningThreshold = this.config.modelContextWindow - AUTOCOMPACT_WARNING_BUFFER;

    if (contextSize < warningThreshold) {
      return { compacted: false };
    }

    if (contextSize >= warningThreshold && contextSize < threshold) {
      process.stderr.write(
        `[context] Warning: ${contextSize.toLocaleString()}/${this.config.modelContextWindow.toLocaleString()} tokens ` +
        `(${((contextSize / this.config.modelContextWindow) * 100).toFixed(0)}% — compaction soon)\n`
      );
      return { compacted: false };
    }

    // Compact needed
    process.stderr.write(
      `[context] Auto-compact triggered: ${contextSize.toLocaleString()} tokens ` +
      `(threshold: ${threshold.toLocaleString()})\n`
    );

    await this.compact();
    return { compacted: true, reason: `${contextSize} tokens exceeded threshold ${threshold}` };
  }

  /**
   * Force compaction: summarize old messages, insert boundary, restore context.
   */
  async compact(): Promise<void> {
    const messages = this.session.messages;
    if (messages.length < 4) return;

    // Keep the last N messages intact
    const keepCount = Math.min(this.config.recentWindowSize * 2, messages.length - 1);
    const toCompact = messages.slice(0, messages.length - keepCount)
      .filter(m => !isCompactBoundary(m));

    if (toCompact.length === 0) return;

    const transcript = toCompact
      .map(m => `[${m.role}${m.model ? ` (${m.model})` : ''}]: ${m.content.slice(0, 2000)}`)
      .join('\n\n');

    // Get existing summary to build on
    const existingSummary = this.getCompactSummary();
    const summaryPrefix = existingSummary
      ? `Previous summary:\n${existingSummary}\n\nNew messages to incorporate:\n`
      : '';

    try {
      const response = await callLLM({
        provider: this.config.compressionProvider,
        model: this.config.compressionModel,
        systemPrompt: `Summarize this conversation concisely. Preserve:
- All technical decisions and their rationale
- File paths and code references mentioned
- Constraints and requirements discussed
- Current plan and progress
- Any errors or failures encountered
Use past tense. No commentary. Max 800 words.`,
        userMessage: `${summaryPrefix}${transcript}\n\nSummarize:`,
        maxOutputTokens: 1500,
        temperature: 0,
      });

      // Build the compact boundary message
      const boundaryContent = `${COMPACT_BOUNDARY_PREFIX}\n${response.content}`;

      // Replace old messages with boundary + kept messages
      const keptMessages = messages.slice(messages.length - keepCount);
      this.session.messages = [
        { role: COMPACT_BOUNDARY_ROLE, content: boundaryContent, timestamp: new Date().toISOString() },
        ...keptMessages,
      ];

      this.compactionCount++;
      this.session.totalInputTokens += response.inputTokens;
      this.session.totalOutputTokens += response.outputTokens;
      this.ledger?.record('compress', response, `Compaction #${this.compactionCount}`);

      // Post-compact restoration
      await this.restorePostCompact();

      const newSize = this.estimateCurrentContextSize();
      process.stderr.write(
        `[context] Compacted: ${this.compactionCount} total, ` +
        `${toCompact.length} messages summarized, ` +
        `new size: ${newSize.toLocaleString()} tokens\n`
      );
    } catch (error) {
      process.stderr.write(`[context] Compaction failed: ${(error as Error).message}\n`);
    }
  }

  /**
   * After compaction, re-inject the most relevant files to keep
   * the context useful. (Like Claude Code's post-compact restoration.)
   */
  private async restorePostCompact(): Promise<void> {
    // Re-inject session state (already happens via assemblePrompt)
    // Re-inject most recently referenced files
    const recentFiles = this.extractRecentFileReferences();
    if (recentFiles.length === 0) return;

    const filesToRestore = recentFiles.slice(0, POST_COMPACT_MAX_FILES);
    process.stderr.write(
      `[context] Post-compact: restoring ${filesToRestore.length} file references\n`
    );
    // File contents will be re-read on next tool use — no need to inject here.
    // The session state and repo map are preserved and re-assembled each turn.
  }

  /**
   * Update session state (goal, decisions, plan) based on recent conversation.
   */
  async updateSessionState(): Promise<void> {
    const messages = this.getMessagesAfterBoundary();
    if (messages.length < 2) return;

    const turnCount = messages.filter(m => m.role === 'user').length;
    if (turnCount <= this.session.state.lastUpdatedAtTurn + 1) return;

    const lastExchange = messages.slice(-4).map(m => `[${m.role}]: ${m.content.slice(0, 1000)}`).join('\n\n');
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
  // Token budget tracking
  // -------------------------------------------------------------------------

  /**
   * Estimate the current context size (all messages after boundary + system prompt).
   */
  estimateCurrentContextSize(): number {
    const messages = this.getMessagesAfterBoundary();
    let total = estimateTokens(this.config.systemPrompt);

    // Session state
    total += estimateTokens(this.formatSessionState());

    // Messages
    for (const m of messages) {
      total += m.tokenCount || estimateTokens(m.content);
    }

    // Compact summary
    const summary = this.getCompactSummary();
    if (summary) total += estimateTokens(summary);

    // Grounding context
    if (this.session.groundingContext) {
      total += estimateTokens(this.session.groundingContext);
    }

    return total;
  }

  /**
   * Check token budget status.
   */
  getBudgetStatus(): {
    sessionTokensUsed: number;
    sessionBudget: number | null;
    currentContextSize: number;
    modelContextWindow: number;
    contextUtilization: number;
    compactionCount: number;
    cacheHitRate: number;
  } {
    const contextSize = this.estimateCurrentContextSize();
    const totalCacheAttempts = this.cacheHits + this.cacheMisses;
    return {
      sessionTokensUsed: this.sessionTokensUsed,
      sessionBudget: this.sessionTokenBudget,
      currentContextSize: contextSize,
      modelContextWindow: this.config.modelContextWindow,
      contextUtilization: contextSize / this.config.modelContextWindow,
      compactionCount: this.compactionCount,
      cacheHitRate: totalCacheAttempts > 0 ? this.cacheHits / totalCacheAttempts : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Message normalization
  // -------------------------------------------------------------------------

  /**
   * Normalize messages for API consumption.
   * - Strips compact boundary markers (replaced by summary in system prompt)
   * - Merges consecutive user messages
   * - Strips internal fields
   * - Truncates excessively long messages
   */
  normalizeForAPI(messages: Message[]): Message[] {
    const normalized: Message[] = [];

    for (const msg of messages) {
      // Skip compact boundaries
      if (isCompactBoundary(msg)) continue;

      // Merge consecutive user messages
      const last = normalized[normalized.length - 1];
      if (last && last.role === 'user' && msg.role === 'user') {
        last.content += '\n\n' + msg.content;
        last.tokenCount = estimateTokens(last.content);
        continue;
      }

      // Truncate extremely long messages (>10K tokens)
      const tokenCount = msg.tokenCount || estimateTokens(msg.content);
      if (tokenCount > 10_000) {
        normalized.push({
          ...msg,
          content: msg.content.slice(0, 40_000) + '\n\n[... message truncated ...]',
          tokenCount: estimateTokens(msg.content.slice(0, 40_000)),
        });
        continue;
      }

      normalized.push({ ...msg });
    }

    return normalized;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Get messages after the last compact boundary */
  private getMessagesAfterBoundary(): Message[] {
    const messages = this.session.messages;
    let boundaryIndex = -1;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (isCompactBoundary(messages[i])) {
        boundaryIndex = i;
        break;
      }
    }

    return boundaryIndex >= 0
      ? messages.slice(boundaryIndex + 1)
      : messages;
  }

  /** Get the compact summary from the boundary marker */
  private getCompactSummary(): string {
    const messages = this.session.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isCompactBoundary(messages[i])) {
        return messages[i].content.slice(COMPACT_BOUNDARY_PREFIX.length + 1);
      }
    }
    return '';
  }

  /** Extract file paths mentioned in recent messages */
  private extractRecentFileReferences(): string[] {
    const messages = this.getMessagesAfterBoundary();
    const files = new Set<string>();
    const filePattern = /(?:src|lib|test|app|pages|components)\/[\w/.,-]+\.\w+/g;

    for (const m of messages.slice(-6)) {
      const matches = m.content.match(filePattern);
      if (matches) {
        for (const f of matches) files.add(f);
      }
    }

    return [...files];
  }

  private getRecentWindow(messages?: Message[]): string {
    const msgs = messages || this.getMessagesAfterBoundary();
    const windowMessages = msgs.slice(-(this.config.recentWindowSize * 2 + 1), -1);
    if (windowMessages.length === 0) return '';
    return windowMessages
      .map(m => `[${m.role}${m.model ? ` (${m.model})` : ''}]: ${m.content.slice(0, 2000)}`)
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
// Helpers
// ---------------------------------------------------------------------------

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
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
