/**
 * Task Card — bounded work packets dispatched to worker models.
 *
 * The task card is the contract between the conversation model and
 * the execution model. It contains everything the worker needs and
 * nothing it doesn't.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskCard, TaskKind, RepoMap, SessionState, LLMResponse } from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';
import type { Ledger } from '../audit/ledger.ts';
import type { ProviderId } from '../types.ts';

// ---------------------------------------------------------------------------
// Task Card creation — frontier model generates from conversation
// ---------------------------------------------------------------------------

export async function createTaskCard(
  userIntent: string,
  sessionState: SessionState,
  repoMap: RepoMap | undefined,
  provider: ProviderId,
  model: string | undefined,
  ledger: Ledger,
): Promise<{ card: TaskCard; response: LLMResponse }> {

  const repoContext = repoMap
    ? `Stack: ${repoMap.stack.join(', ')}
Subsystems: ${repoMap.subsystems.map(s => `${s.name} (${s.paths.join(', ')}): ${s.purpose}`).join('\n')}
Entrypoints: ${repoMap.entrypoints.join(', ')}
Commands: build=${repoMap.commands.build || 'n/a'} test=${repoMap.commands.test || 'n/a'} lint=${repoMap.commands.lint || 'n/a'}
Conventions: ${repoMap.conventions.join('; ')}`
    : '(no repo map available)';

  const stateContext = `Goal: ${sessionState.goal || 'not set'}
Plan: ${sessionState.currentPlan.join(' → ') || 'none'}
Decisions: ${sessionState.decisions.join('; ') || 'none'}
Constraints: ${sessionState.constraints.join('; ') || 'none'}
Recent failures: ${sessionState.recentFailures.join('; ') || 'none'}`;

  const response = await callLLM({
    provider,
    model,
    systemPrompt: `You create structured task cards for a coding assistant. Output ONLY valid JSON.

A task card is a bounded work packet with:
- id: short identifier (e.g., "task-001")
- kind: one of "implementation", "fix", "refactor", "test", "analysis"
- goal: clear 1-2 sentence description of what to do
- relevantFiles: array of file paths the worker should focus on
- constraints: array of things NOT to do or boundaries
- acceptanceCriteria: array of conditions that must be true when done
- outputMode: "diff" for patches, "file_replacements" for full files, "text" for analysis

Be specific and bounded. The worker model will ONLY see this card, not the conversation.`,
    userMessage: `Create a task card for the following request.

SESSION STATE:
${stateContext}

REPO:
${repoContext}

USER REQUEST:
${userIntent}

Output the task card as JSON:`,
    maxOutputTokens: 1500,
    temperature: 0,
  });

  ledger.record('dispatch', response, `Task card creation for: ${userIntent.slice(0, 200)}`);

  let parsed: any = {};
  try {
    // Extract JSON from response — model may wrap it in markdown code blocks
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    process.stderr.write(`[dispatch] Failed to parse task card JSON, using defaults\n`);
  }

  const card: TaskCard = {
    id: parsed.id || `task-${Date.now().toString(36)}`,
    kind: parsed.kind || 'implementation',
    goal: parsed.goal || userIntent,
    relevantFiles: parsed.relevantFiles || [],
    constraints: parsed.constraints || [],
    acceptanceCriteria: parsed.acceptanceCriteria || [],
    outputMode: parsed.outputMode || 'file_replacements',
    failures: 0,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  return { card, response };
}

// ---------------------------------------------------------------------------
// Task execution — worker model processes the card
// ---------------------------------------------------------------------------

export async function executeTaskCard(
  card: TaskCard,
  repoMap: RepoMap | undefined,
  fileContents: string,
  provider: ProviderId,
  model: string | undefined,
  ledger: Ledger,
): Promise<LLMResponse> {

  const taskPrompt = `TASK CARD:
${JSON.stringify(card, null, 2)}

RELEVANT FILE CONTENTS:
${fileContents}`;

  const systemPrompt = card.kind === 'analysis'
    ? `You are a code analysis agent. Analyze the code as specified in the task card. Be thorough and specific. Reference exact files and line numbers.`
    : `You are a code execution agent. Implement exactly what the task card specifies.

Rules:
- Only modify files listed in relevantFiles unless absolutely necessary
- Respect all constraints
- Output your changes as ${card.outputMode === 'diff' ? 'unified diffs' : 'complete file contents with clear path labels'}
- When done, end with:
  ## RESULT
  **Status:** complete | partial
  **Files changed:** list of files
  **Notes:** anything the reviewer should know`;

  const response = await callLLM({
    provider,
    model,
    systemPrompt,
    userMessage: taskPrompt,
    maxOutputTokens: 8192,
  });

  ledger.record('execute', response, `Execute task ${card.id}: ${card.goal.slice(0, 200)}`, {
    taskId: card.id,
    promoted: card.failures >= 2,
  });

  return response;
}

// ---------------------------------------------------------------------------
// Read relevant files for a task card
// ---------------------------------------------------------------------------

export function readRelevantFiles(
  workingDir: string,
  files: string[],
  maxCharsPerFile = 4096,
): string {
  const base = resolve(workingDir);
  const sections: string[] = [];

  for (const relPath of files) {
    const fullPath = join(workingDir, relPath);
    const resolved = resolve(fullPath);

    // Path traversal check
    if (!resolved.startsWith(base)) continue;
    if (!existsSync(fullPath)) {
      sections.push(`#### ${relPath}\n(file not found)`);
      continue;
    }

    try {
      let content = readFileSync(fullPath, 'utf-8');
      if (content.length > maxCharsPerFile) {
        content = content.slice(0, maxCharsPerFile) + '\n... (truncated)';
      }
      sections.push(`#### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      sections.push(`#### ${relPath}\n(read error)`);
    }
  }

  return sections.join('\n\n');
}
