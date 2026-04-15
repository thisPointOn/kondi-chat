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
  | 'zai'
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
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
  supportsCaching?: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  model?: string;
  provider?: ProviderId;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ---------------------------------------------------------------------------
// Repo Map — structured codebase summary, created once per repo
// ---------------------------------------------------------------------------

export interface RepoMap {
  stack: string[];
  entrypoints: string[];
  subsystems: Array<{ name: string; paths: string[]; purpose: string }>;
  commands: { build?: string; test?: string; lint?: string; typecheck?: string };
  conventions: string[];
}

// ---------------------------------------------------------------------------
// Session State — durable conversation memory
// ---------------------------------------------------------------------------

export interface SessionState {
  goal: string;
  decisions: string[];
  constraints: string[];
  currentPlan: string[];
  activeTaskId?: string;
  recentFailures: string[];
  lastUpdatedAtTurn: number;
}

// ---------------------------------------------------------------------------
// Task Card — bounded work packet for execution
// ---------------------------------------------------------------------------

/**
 * Task kinds are open-ended. Defaults: implementation, fix, refactor, test, analysis.
 * Users/plugins can add domain-specific kinds: robot-control, image-generation, etc.
 * The router learns to route new kinds through training data.
 */
export type TaskKind = string;

export interface TaskCard {
  id: string;
  kind: TaskKind;
  goal: string;
  relevantFiles: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  outputMode: 'diff' | 'file_replacements' | 'text';
  failures: number;
  createdAt: string;
  completedAt?: string;
  status: 'pending' | 'executing' | 'verifying' | 'passed' | 'failed' | 'promoted';
}

// ---------------------------------------------------------------------------
// Creative Generation
// ---------------------------------------------------------------------------

export interface CreativeGenerationRequest {
  description: string;
  images?: string[]; // Base64 encoded images
  style?: string; // e.g., "technical", "narrative", "visual", etc.
  constraints?: string[]; // Any specific requirements
}

export interface CreativeGenerationResponse {
  content: string; // The generated creative content
  type: 'text' | 'code' | 'structured' | 'mixed';
  metadata?: {
    model: string;
    tokens?: number;
    confidence?: number;
    suggestions?: string[]; // Additional ideas or variations
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  testOutput?: string;
  lintOutput?: string;
  typecheckOutput?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Audit Ledger — every LLM call recorded
// ---------------------------------------------------------------------------

export type LedgerPhase =
  | 'discuss'          // frontier: user conversation
  | 'commit'           // system: state update
  | 'dispatch'         // frontier: task card creation
  | 'execute'          // worker: code generation
  | 'verify'           // local: tests/lint/typecheck
  | 'reflect'          // frontier: summarize results
  | 'compress'         // cheap: context compression
  | 'state_update';    // cheap: working state update

export interface LedgerEntry {
  id: string;
  timestamp: string;
  phase: LedgerPhase;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
  /** Input tokens served from the provider's prompt cache (included in inputTokens). */
  cachedInputTokens?: number;

  /** What was sent (system + user prompt) */
  promptSummary: string;
  /** What came back */
  responseSummary: string;

  /** Associated task card ID, if any */
  taskId?: string;
  /** Was this a promotion (retry with better model)? */
  promoted?: boolean;
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

  /** Durable session state */
  state: SessionState;

  /** Repo map — structured codebase summary */
  repoMap?: RepoMap;

  /** Raw grounding context for prompt assembly */
  groundingContext?: string;

  /** All task cards created during this session */
  tasks: TaskCard[];

  /** Active provider/model (can change mid-session) */
  activeProvider: ProviderId;
  activeModel?: string;

  /** Cumulative cost tracking */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Context Budget
// ---------------------------------------------------------------------------

export interface ContextSection {
  key: string;
  content: string;
  priority: number;
  compressible: boolean;
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Tool Use
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  /** Spec 03 — unified diff, when the tool mutated a file. */
  diff?: string;
}

// ---------------------------------------------------------------------------
// LLM Call — multi-turn message for agent loops
// ---------------------------------------------------------------------------

/** Spec 09 — multimodal content part. Text remains the default. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string };

export interface LLMMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  /** Spec 09 — interleaved text/image parts; providers that support it use this. */
  parts?: ContentPart[];
  toolCalls?: ToolCall[];     // assistant messages with tool use
  toolResults?: ToolResult[]; // tool-result messages
}

/** Spec 09 — image attachment descriptor (used by submit command + pipeline). */
export interface ImageAttachment {
  mimeType: string;
  base64: string;
  originalPath?: string;
  sizeBytes: number;
}

export interface LLMRequest {
  provider: ProviderId;
  model?: string;
  systemPrompt: string;
  /** Simple single-turn: set userMessage */
  userMessage?: string;
  /** Multi-turn agent loop: set messages instead */
  messages?: LLMMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  cacheablePrefix?: string;
  /** Stream the response token by token */
  stream?: boolean;
  /** Callback for each streamed token chunk */
  onToken?: (token: string) => void;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: ProviderId;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached?: boolean;
  toolCalls?: ToolCall[];
  /** True if this response came from a fallback model, not the originally requested one */
  wasFallback?: boolean;
  /** The originally requested model (if different from the responding model) */
  requestedModel?: string;
  /** Spec 14 — raw response headers for rate-limit parsing. */
  responseHeaders?: Record<string, string>;
  /**
   * Hidden chain-of-thought emitted by reasoning models (GLM-5.x, OpenAI o-series,
   * DeepSeek-R1, Anthropic extended thinking). Billed as output tokens but not
   * shown inline; the TUI exposes it via Ctrl+R.
   */
  reasoningContent?: string;
  /**
   * Portion of inputTokens that the provider served from its prompt cache
   * (OpenAI `prompt_tokens_details.cached_tokens`, Anthropic
   * `cache_read_input_tokens`). Billed at reduced rate — our cost estimate
   * subtracts 50% of the standard input price on the cached portion, which
   * matches the published discount on both OpenAI and Z.AI endpoints.
   */
  cachedInputTokens?: number;
}
