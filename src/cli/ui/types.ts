/**
 * UI state types for the Ink-based TUI.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Model alias or name (e.g., "opus", "gpt") */
  modelLabel?: string;
  /** Full model ID */
  modelId?: string;
  timestamp: string;
  /** Tool calls made during this message */
  toolCalls?: ToolCallDisplay[];
  /** Token/cost stats for this message */
  stats?: MessageStats;
}

export interface ToolCallDisplay {
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}

export interface MessageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  iterations: number;
  models: string[];
}

export type ViewMode = 'chat' | 'tools' | 'stats';

export interface AppState {
  messages: ChatMessage[];
  isProcessing: boolean;
  viewMode: ViewMode;
  statusText: string;
}
