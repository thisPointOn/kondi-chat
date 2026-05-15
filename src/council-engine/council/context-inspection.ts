/**
 * Context Inspection: builds a summary of what was sent to the LLM for each agent call.
 * Stored on LedgerEntry.structured.contextInspection for UI display.
 */

export interface ContextInspection {
  systemPromptChars: number;
  systemPromptSource: string;
  userMessageChars: number;
  toolScope: 'full' | 'plan' | 'read_only' | 'manager' | 'none';
  toolCount: number;
  toolNames?: string[];
  effectiveServerIds?: string[];
  wordLimitApplied?: number;
  contextTokenBudget?: number;
  timeoutMs?: number;
}

export function buildContextInspection(params: {
  systemPrompt: string;
  systemPromptSource: string;
  userMessage: string;
  toolScope: ContextInspection['toolScope'];
  toolNames?: string[];
  effectiveServerIds?: string[];
  wordLimitApplied?: number;
  contextTokenBudget?: number;
  timeoutMs?: number;
}): ContextInspection {
  return {
    systemPromptChars: params.systemPrompt.length,
    systemPromptSource: params.systemPromptSource,
    userMessageChars: params.userMessage.length,
    toolScope: params.toolScope,
    toolCount: params.toolNames?.length || 0,
    toolNames: params.toolNames?.slice(0, 20), // cap to avoid bloat
    effectiveServerIds: params.effectiveServerIds,
    wordLimitApplied: params.wordLimitApplied,
    contextTokenBudget: params.contextTokenBudget,
    timeoutMs: params.timeoutMs,
  };
}
