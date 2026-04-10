/**
 * Sub-agent spawning — bounded child agent loops.
 *
 * This is a minimal implementation: each spawn runs an inline loop that
 * calls callLLM + toolManager.execute on a filtered tool set. Parallelism
 * is handled by the caller (the `spawn_agent` tool awaits one at a time in
 * this version; Promise.all at the call site yields natural parallelism).
 *
 * Sub-agents do NOT nest (no recursive spawn_agent). Loop guard caps
 * iterations and cost.
 */

import type { LLMMessage, ToolDefinition, Session } from '../types.ts';
import type { Router } from '../router/index.ts';
import type { ToolContext, ToolExecutionResult } from './tools.ts';
import type { ToolManager } from '../mcp/tool-manager.ts';
import { callLLM } from '../providers/llm-caller.ts';
import { estimateCost } from '../audit/ledger.ts';

export type SubAgentType = 'research' | 'worker' | 'planner';

const MAX_SUB_ITERATIONS = 8;
const MAX_SUB_COST_USD = 0.50;
const MAX_RESULT_CHARS = 4000;

const RESEARCH_TOOLS = new Set(['read_file', 'list_files', 'search_code', 'web_search', 'web_fetch', 'git_status', 'git_diff', 'git_log']);
const WORKER_TOOLS = new Set<string>([
  'read_file', 'list_files', 'search_code', 'write_file', 'edit_file', 'run_command',
  'git_status', 'git_diff', 'git_log', 'git_commit',
]);

function filterToolsForType(type: SubAgentType, tools: ToolDefinition[]): ToolDefinition[] {
  if (type === 'planner') return [];
  const set = type === 'research' ? RESEARCH_TOOLS : WORKER_TOOLS;
  return tools.filter(t => set.has(t.name));
}

function systemPromptForType(type: SubAgentType, parentGoal?: string): string {
  const goalLine = parentGoal ? `Parent session goal: ${parentGoal}\n\n` : '';
  if (type === 'planner') {
    return `${goalLine}You are a planning sub-agent. Return a concise plan; do not call tools. Output a numbered list of concrete steps.`;
  }
  if (type === 'research') {
    return `${goalLine}You are a research sub-agent. Gather information and return a concise summary. You may read files and search code but must not modify anything.`;
  }
  return `${goalLine}You are a worker sub-agent. Complete the given task. You may read, write, and edit files, and run commands. Return a short summary of what you did.`;
}

export interface SubAgentResult {
  type: SubAgentType;
  instruction: string;
  finalContent: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  error?: string;
  truncated?: boolean;
}

export async function runSubAgent(
  type: SubAgentType,
  instruction: string,
  parent: {
    router: Router;
    toolManager: ToolManager;
    toolCtx: ToolContext;
    session: Session;
  },
): Promise<SubAgentResult> {
  const { router, toolManager, toolCtx, session } = parent;
  const systemPrompt = systemPromptForType(type, session.state.goal);
  const tools = filterToolsForType(type, toolManager.getTools('discuss'));

  const messages: LLMMessage[] = [{ role: 'user', content: instruction }];
  let inputTokens = 0, outputTokens = 0, costUsd = 0;
  let finalContent = '';
  let model = '';

  for (let iter = 0; iter < MAX_SUB_ITERATIONS; iter++) {
    const decision = await router.select(type === 'planner' ? 'dispatch' : type === 'research' ? 'discuss' : 'execute', instruction);
    model = decision.model.alias || decision.model.name;
    const response = await callLLM({
      provider: decision.model.provider,
      model: decision.model.id,
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxOutputTokens: 4096,
    });
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    costUsd += estimateCost(response.model, response.inputTokens, response.outputTokens);

    if (costUsd > MAX_SUB_COST_USD) {
      finalContent = response.content || 'sub-agent cost cap reached';
      return {
        type, instruction, finalContent, iterations: iter + 1,
        inputTokens, outputTokens, costUsd, model, error: 'cost-cap',
      };
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content;
      return { type, instruction, finalContent, iterations: iter + 1, inputTokens, outputTokens, costUsd, model };
    }

    messages.push({ role: 'assistant', content: response.content || undefined, toolCalls: response.toolCalls });
    const toolResults = [];
    for (const tc of response.toolCalls) {
      const result: ToolExecutionResult = await toolManager.execute(tc.name, tc.arguments, toolCtx);
      const capped = result.content.length > 3000 ? result.content.slice(0, 3000) + '...' : result.content;
      toolResults.push({ toolCallId: tc.id, content: capped, isError: result.isError });
    }
    messages.push({ role: 'tool', toolResults });
  }

  finalContent = finalContent || `sub-agent hit ${MAX_SUB_ITERATIONS} iterations without finishing`;
  return {
    type, instruction, finalContent: finalContent.slice(0, MAX_RESULT_CHARS),
    iterations: MAX_SUB_ITERATIONS, inputTokens, outputTokens, costUsd, model,
    error: 'max-iterations',
    truncated: finalContent.length > MAX_RESULT_CHARS,
  };
}

/** Formats a SubAgentResult as a short block suitable for the parent's tool_result content. */
export function formatSubAgentResult(r: SubAgentResult): string {
  const header = `[sub-agent ${r.type} via ${r.model}; ${r.iterations}it; $${r.costUsd.toFixed(4)}${r.error ? `; ${r.error}` : ''}]`;
  const body = r.finalContent.length > MAX_RESULT_CHARS ? r.finalContent.slice(0, MAX_RESULT_CHARS) + '\n[truncated]' : r.finalContent;
  return `${header}\n${body}`;
}
