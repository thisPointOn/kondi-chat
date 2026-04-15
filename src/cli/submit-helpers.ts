/**
 * Pure helpers used by the agent submit path.
 *
 * Everything in this file is deliberately side-effect-free and takes its
 * dependencies as parameters. No startup wiring, no global state, no
 * callers-injected emit functions. The rest of backend.ts is free to do
 * the noisy orchestration; the decisions encoded here can be unit-tested
 * in isolation.
 */

import type { LLMMessage, ProviderId } from '../types.ts';
import type { ModelRegistry, ModelEntry } from '../router/registry.ts';
import type { BudgetProfile } from '../router/profiles.ts';

// ---------------------------------------------------------------------------
// In-loop context compaction
// ---------------------------------------------------------------------------

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
export function collapseOldToolResults(
  messages: LLMMessage[],
  keepLatest = 2,
  minLen = 300,
): number {
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
export function estimateMessagesTokens(messages: LLMMessage[]): number {
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
 * No LLM calls — pure local string manipulation. Returns before/after
 * token estimates and total bytes saved so the caller can emit it as an
 * activity line.
 */
export function compactInLoop(
  messages: LLMMessage[],
  budget: number,
): { before: number; after: number; savedBytes: number } {
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

// ---------------------------------------------------------------------------
// Model selection helpers
// ---------------------------------------------------------------------------

/**
 * Pick the cheapest enabled model for compaction-style LLM calls.
 * Respects the active profile's allowedProviders so `zai` mode compacts
 * with glm-4.5-flash (free) instead of bleeding out to claude-haiku.
 * Returns undefined if nothing suitable is enabled — caller keeps the
 * hardcoded ContextManager default in that case.
 */
export function pickCompressionModel(
  registry: ModelRegistry,
  profile: BudgetProfile,
): { provider: ProviderId; id: string } | undefined {
  const allowed = profile.allowedProviders;
  const candidates: ModelEntry[] = registry.getAvailable();
  const inScope = allowed && allowed.length > 0
    ? candidates.filter(m => allowed.includes(m.provider))
    : candidates;
  const withSummarization = inScope.filter(m => m.capabilities.includes('summarization'));
  const pool = withSummarization.length > 0 ? withSummarization : inScope;
  if (pool.length === 0) return undefined;
  pool.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);
  return { provider: pool[0].provider, id: pool[0].id };
}

// ---------------------------------------------------------------------------
// Phase classification
// ---------------------------------------------------------------------------

/**
 * Coarse classification of a user message as a coding-execution task vs. a
 * discussion. Used to pick an initial phase for `router.select()`. The
 * intent router runs on every phase, so a misclassification here is
 * recoverable — the intent tier will still pick a role-appropriate model.
 *
 * Heuristics target the common patterns:
 *   - Strong coding verb + code-y noun ("implement a parser", "save this to disk")
 *   - Language keyword ("in Python", "in Rust")
 *   - File extension mention (".py", ".ts", ".md", …)
 *   - File-oriented imperative ("save X to disk", "dump Y to file")
 *
 * Everything else defaults to `discuss`.
 */
export function classifyPhase(input: string): 'execute' | 'discuss' {
  const s = input.toLowerCase();
  // Strong coding-intent verbs paired with code-y nouns / file extensions / language names.
  if (/\b(write|make|create|build|implement|generate|add|fix|debug|refactor|optimize|update|change|modify|edit|remove|rewrite|port|translate|save|store|persist|dump|export|append)\b[^\n]{0,80}\b(code|script|function|class|method|file|test|module|app|component|endpoint|api|page|cli|tool|server|client|parser|wrapper|helper|util|util(?:s|ity)|service|model|database|schema|migration|response|answer|reply|output|log|notes?|disk|report|review|summary|transcript)\b/.test(s)) return 'execute';
  if (/\bin\s+(python|javascript|typescript|rust|go(lang)?|java|c\+\+|c#|ruby|php|swift|kotlin|bash|shell|sql)\b/.test(s)) return 'execute';
  if (/\.(py|js|ts|tsx|jsx|rs|go|java|cpp|cc|h|hpp|cs|rb|php|swift|kt|sh|sql|html|css|scss|json|yml|yaml|toml|md|txt)\b/.test(s)) return 'execute';
  if (/\b(write|make|create|build|implement)\s+(a|an|the)?\s*(python|js|ts|rust|go|bash|shell|sql)\b/.test(s)) return 'execute';
  if (/\b(save|write|store|dump|export|persist|append)\b[^\n]{0,40}\b(to|as|into|in)\b[^\n]{0,80}\b(disk|file|folder|directory|path)\b/.test(s)) return 'execute';
  return 'discuss';
}
