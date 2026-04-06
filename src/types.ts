/**
 * Core types for kondi-chat
 */

// ---------------------------------------------------------------------------
// Provider & Model
// ---------------------------------------------------------------------------

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'google'
  | 'xai'
  | 'ollama'
  | 'nvidia-router';

export interface ProviderConfig {
  id: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  contextWindow: number;       // max input tokens
  maxOutputTokens: number;
  inputCostPer1M: number;      // USD per 1M input tokens
  outputCostPer1M: number;     // USD per 1M output tokens
  supportsCaching?: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  model?: string;              // which model produced this (assistant only)
  provider?: ProviderId;
  tokenCount?: number;         // estimated token count of content
  inputTokens?: number;        // tokens billed as input for this turn
  outputTokens?: number;       // tokens billed as output for this turn
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  createdAt: string;
  workingDirectory?: string;

  /** Full message history — never truncated, used for export/replay */
  messages: Message[];

  /** Evolving summary of the conversation so far */
  workingState: WorkingState;

  /** Grounding context (codebase, docs) — loaded once at session start */
  groundingContext?: string;

  /** Active provider/model (can change mid-session) */
  activeProvider: ProviderId;
  activeModel?: string;

  /** Cumulative cost tracking */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Working State — the "semantic memory" of the conversation
// ---------------------------------------------------------------------------

export interface WorkingState {
  /** High-level summary of what's been discussed/decided */
  summary: string;

  /** Key decisions made during the conversation */
  decisions: string[];

  /** Active constraints or requirements */
  constraints: string[];

  /** Open questions or unresolved topics */
  openQuestions: string[];

  /** What was tried and rejected */
  rejectedApproaches: string[];

  /** Last updated turn number */
  lastUpdatedAtTurn: number;
}

// ---------------------------------------------------------------------------
// Context Budget
// ---------------------------------------------------------------------------

export interface ContextSection {
  key: string;
  content: string;
  priority: number;           // 1 = highest, included first
  compressible: boolean;      // can be summarized if budget is tight
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

export interface LLMRequest {
  provider: ProviderId;
  model?: string;
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Cacheable prefix for providers that support it (Anthropic) */
  cacheablePrefix?: string;
}

export interface LLMResponse {
  content: string;
  model: string;              // actual model used (important for router)
  provider: ProviderId;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached?: boolean;           // was prompt cache hit (Anthropic)
}
