/**
 * Task Router — adaptive problem framing before execution.
 *
 * Decides automatically whether a task is:
 *   A. directly executable (concrete, unambiguous)
 *   B. needs lightweight framing (broad but inferable)
 *   C. needs user clarification (risky or ambiguous)
 *   D. needs council/deeper deliberation (design tradeoffs)
 *
 * Runs a single cheap classifier call before the agent loop starts.
 * The user never has to say "think first" or "define the problem" —
 * kondi infers it from task shape.
 */

import type { ProviderId } from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskMode =
  | 'execute_now'
  | 'frame_then_execute'
  | 'ask_clarifying_question'
  | 'council_deliberation';

export interface TaskClassification {
  mode: TaskMode;
  confidence: number;
  reason: string;
  missingInformation: string[];
  suggestedQuestions: string[];
  executionGoal?: string;
}

export interface ProblemFrame {
  originalRequest: string;
  interpretedGoal: string;
  whyThisMatters: string;
  currentBehavior?: string;
  desiredBehavior?: string;
  constraints: string[];
  assumptions: string[];
  unknowns: string[];
  successCriteria: string[];
  proposedPlan: string[];
  executionScope: 'small' | 'medium' | 'large';
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = `You classify user tasks for a coding agent. Based on the task, decide the mode:

execute_now — the task is concrete and unambiguous. Examples: "fix this error", "rename this function", "add logging", "run tests", "read this file", "explain this code"

frame_then_execute — the task is broad but you can infer what to do. Examples: "clean up the provider system", "improve the onboarding", "make this less confusing", "refactor the auth module"

ask_clarifying_question — the task is risky or genuinely ambiguous, and acting without clarification could waste effort or cause harm. Examples: "change the auth flow" (which part?), "delete unused code" (what counts as unused?), "make it production ready" (what's the target?)

council_deliberation — the task involves real design tradeoffs that benefit from multiple perspectives. Examples: "redesign the architecture", "choose between strategies", "plan the roadmap"

Most tasks are execute_now. Only escalate when there's genuine ambiguity or risk. Simple questions and straightforward coding tasks are always execute_now.

Respond with ONLY a JSON object:
{"mode": "execute_now|frame_then_execute|ask_clarifying_question|council_deliberation", "confidence": 0.0-1.0, "reason": "one sentence", "missingInformation": [], "suggestedQuestions": [], "executionGoal": "optional refined goal"}`;

/**
 * Fast local classification — no LLM call. Handles 95% of inputs instantly.
 * Only falls back to an LLM call for genuinely ambiguous cases where the
 * heuristic has low confidence.
 */
export function classifyTaskLocal(
  userRequest: string,
  recentContext: string,
): TaskClassification {
  const lower = userRequest.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;

  // Very short messages are always execute_now (greetings, "yes", "do it", etc.)
  if (wordCount <= 6) {
    return { mode: 'execute_now', confidence: 0.95, reason: 'short input', missingInformation: [], suggestedQuestions: [] };
  }

  // Follow-up messages in an ongoing conversation are always execute_now
  if (recentContext.length > 50) {
    return { mode: 'execute_now', confidence: 0.9, reason: 'follow-up in conversation', missingInformation: [], suggestedQuestions: [] };
  }

  // Direct action verbs → execute_now
  const actionVerbs = /^(fix|add|create|write|read|show|list|run|test|build|deploy|install|update|change|rename|remove|delete|explain|refactor|implement|move|copy|find|search|check|debug|log|print|open|close|merge|revert|commit|push|pull)\b/i;
  if (actionVerbs.test(lower)) {
    return { mode: 'execute_now', confidence: 0.9, reason: 'action verb', missingInformation: [], suggestedQuestions: [] };
  }

  // Questions → execute_now (the model will answer)
  if (lower.startsWith('what') || lower.startsWith('how') || lower.startsWith('why') ||
      lower.startsWith('where') || lower.startsWith('when') || lower.startsWith('can') ||
      lower.startsWith('does') || lower.startsWith('is ') || lower.endsWith('?')) {
    return { mode: 'execute_now', confidence: 0.9, reason: 'question', missingInformation: [], suggestedQuestions: [] };
  }

  // File references → execute_now
  if (/\.(ts|js|py|rs|go|json|yml|yaml|toml|md|css|html|sql)\b/.test(lower)) {
    return { mode: 'execute_now', confidence: 0.9, reason: 'file reference', missingInformation: [], suggestedQuestions: [] };
  }

  // Broad/vague multi-sentence requests with no concrete target → frame_then_execute
  const broadIndicators = /\b(redesign|overhaul|rethink|architect|migrate|strategy|roadmap|plan out)\b/i;
  if (broadIndicators.test(lower) && wordCount > 15) {
    return { mode: 'frame_then_execute', confidence: 0.7, reason: 'broad request', missingInformation: [], suggestedQuestions: [] };
  }

  // Default: execute_now. The model itself is good at asking for
  // clarification when it needs it — we don't need a pre-classifier.
  return { mode: 'execute_now', confidence: 0.8, reason: 'default', missingInformation: [], suggestedQuestions: [] };
}

/**
 * LLM-based classification — only called when the local heuristic has
 * low confidence. Most inputs never reach this.
 */
export async function classifyTask(
  userRequest: string,
  recentContext: string,
  classifierProvider: ProviderId,
  classifierModel?: string,
): Promise<TaskClassification> {
  // Fast path: local heuristic handles 95% of inputs with no LLM call.
  const local = classifyTaskLocal(userRequest, recentContext);
  if (local.confidence >= 0.7) return local;

  try {
    const response = await callLLM({
      provider: classifierProvider,
      model: classifierModel,
      systemPrompt: CLASSIFY_PROMPT,
      userMessage: `Task: ${userRequest.slice(0, 1500)}${recentContext ? `\n\nRecent context: ${recentContext.slice(0, 500)}` : ''}`,
      maxOutputTokens: 200,
      temperature: 0,
    });

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { mode: 'execute_now', confidence: 0.5, reason: 'classifier returned non-JSON', missingInformation: [], suggestedQuestions: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      mode: parsed.mode || 'execute_now',
      confidence: parsed.confidence ?? 0.8,
      reason: parsed.reason || '',
      missingInformation: parsed.missingInformation || [],
      suggestedQuestions: parsed.suggestedQuestions || [],
      executionGoal: parsed.executionGoal,
    };
  } catch {
    // If classification fails, default to execute — don't block the user.
    return { mode: 'execute_now', confidence: 0.5, reason: 'classifier error — defaulting to execute', missingInformation: [], suggestedQuestions: [] };
  }
}

// ---------------------------------------------------------------------------
// Problem Framer
// ---------------------------------------------------------------------------

const FRAME_PROMPT = `You are a problem framing assistant for a coding agent. The user gave a broad task. Your job is to:

1. Interpret what they actually want
2. Define clear success criteria
3. Propose a concrete plan

Be concise. No filler. Output ONLY a JSON object:
{
  "interpretedGoal": "what the user really wants",
  "whyThisMatters": "one sentence on why",
  "currentBehavior": "what happens now (if known)",
  "desiredBehavior": "what should happen after",
  "constraints": ["things to preserve or avoid"],
  "assumptions": ["things you're assuming"],
  "unknowns": ["things you'd need to verify"],
  "successCriteria": ["how to know it's done"],
  "proposedPlan": ["step 1", "step 2", ...],
  "executionScope": "small|medium|large"
}`;

export async function frameProblem(
  userRequest: string,
  recentContext: string,
  provider: ProviderId,
  model?: string,
): Promise<ProblemFrame> {
  const response = await callLLM({
    provider,
    model,
    systemPrompt: FRAME_PROMPT,
    userMessage: `Task: ${userRequest}\n\n${recentContext ? `Context: ${recentContext.slice(0, 1000)}` : ''}`,
    maxOutputTokens: 800,
    temperature: 0,
  });

  const text = response.content.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      originalRequest: userRequest,
      interpretedGoal: userRequest,
      whyThisMatters: '',
      constraints: [],
      assumptions: [],
      unknowns: [],
      successCriteria: [],
      proposedPlan: [userRequest],
      executionScope: 'medium',
    };
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    originalRequest: userRequest,
    interpretedGoal: parsed.interpretedGoal || userRequest,
    whyThisMatters: parsed.whyThisMatters || '',
    currentBehavior: parsed.currentBehavior,
    desiredBehavior: parsed.desiredBehavior,
    constraints: parsed.constraints || [],
    assumptions: parsed.assumptions || [],
    unknowns: parsed.unknowns || [],
    successCriteria: parsed.successCriteria || [],
    proposedPlan: parsed.proposedPlan || [],
    executionScope: parsed.executionScope || 'medium',
  };
}

// ---------------------------------------------------------------------------
// Frame formatter (for TUI display)
// ---------------------------------------------------------------------------

export function formatFrame(frame: ProblemFrame): string {
  const lines: string[] = [
    `Goal: ${frame.interpretedGoal}`,
  ];
  if (frame.whyThisMatters) lines.push(`Why: ${frame.whyThisMatters}`);
  if (frame.currentBehavior) lines.push(`Now: ${frame.currentBehavior}`);
  if (frame.desiredBehavior) lines.push(`Target: ${frame.desiredBehavior}`);
  if (frame.successCriteria.length > 0) {
    lines.push(`Success: ${frame.successCriteria.join('; ')}`);
  }
  if (frame.proposedPlan.length > 0) {
    lines.push(`Plan: ${frame.proposedPlan.map((s, i) => `${i + 1}. ${s}`).join(' → ')}`);
  }
  lines.push(`Scope: ${frame.executionScope}`);
  return lines.join('\n');
}
