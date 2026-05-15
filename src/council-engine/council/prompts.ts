/**
 * Council: Prompt Construction
 * System prompts and prompt templates for personas
 */

import type { Council, Persona, CouncilMessage, TurnContext, CouncilMode, LedgerEntry, ContextPatch } from './types';
import type { CouncilStepType } from '../pipeline/types';

/**
 * Context access instruction — adapts based on whether tools are available.
 * When tools are available: tells the model to use them AND reference context.
 * When tools are unavailable: tells the model the code is in the prompt.
 */
export function contextAccessNote(hasTools?: boolean): string {
  if (hasTools) {
    return `The source code and project structure are provided in your context. You also have tools available (read_file, list_directory, run_command). Use BOTH the provided context AND tools to examine the codebase thoroughly.`;
  }
  return `The source code and project structure are provided in your context. Analyze them directly — do not say you need tools or external access. The code is in your prompt.`;
}

/**
 * Get interaction instruction based on council mode and persona stance
 */
function getInteractionInstruction(mode: CouncilMode, persona: Persona): string {
  switch (mode) {
    case 'debate':
      return persona.predisposition.stance === 'advocate'
        ? 'Defend your position and counter opposing arguments.'
        : persona.predisposition.stance === 'critic'
        ? 'Challenge claims and identify weaknesses in arguments.'
        : 'Offer perspective that bridges competing views.';
    case 'build':
      return "Build on what others have said. Add value, don't repeat.";
    case 'review':
      return 'Provide constructive critique. Be specific about improvements.';
    case 'synthesis':
      return "Offer your unique perspective. The goal is diverse input, not agreement.";
    case 'socratic':
      return persona.predisposition.interactionStyle === 'question'
        ? 'Ask probing questions that reveal assumptions and deepen understanding.'
        : 'Defend your reasoning while remaining open to being wrong.';
    case 'freeform':
    default:
      return 'Engage naturally as your character would.';
  }
}

/**
 * Build the system prompt for a persona's turn
 */
export function buildPersonaSystemPrompt(
  persona: Persona,
  council: Council,
  turnContext: TurnContext
): string {
  const otherPersonas = council.personas
    .filter((p) => p.id !== persona.id && !p.muted)
    .map((p) => `${p.name} (${p.predisposition.stance})`)
    .join(', ');

  return `${persona.predisposition.systemPrompt}

## Your Identity
Name: ${persona.name}
Stance: ${persona.predisposition.stance}
${persona.predisposition.arguesFor ? `You argue for: ${persona.predisposition.arguesFor}` : ''}
${persona.predisposition.arguesAgainst ? `You argue against: ${persona.predisposition.arguesAgainst}` : ''}
Your style: ${persona.predisposition.interactionStyle}
Traits: ${persona.predisposition.traits.join(', ')}
${persona.predisposition.domain ? `Domain expertise: ${persona.predisposition.domain}` : ''}

## Council Context
Topic: ${council.topic}
Mode: ${council.orchestration.mode}
Other participants: ${otherPersonas || 'None yet'}

## Shared Context
${council.sharedContext.description}
${council.sharedContext.constraints?.length
  ? `\nConstraints:\n${council.sharedContext.constraints.map((c) => `- ${c}`).join('\n')}`
  : ''}

## Your Task
Respond as ${persona.name} would. Stay in character.
${getInteractionInstruction(council.orchestration.mode, persona)}

## Guidelines
- Be concise but substantive (2-4 paragraphs max unless thorough analysis is needed)
- Reference specific points from other participants when relevant
- If you agree with someone, say so briefly and add new value
- If you disagree, be direct but respectful
- Ask questions when genuinely uncertain
- Stay true to your predisposition, but engage authentically
${persona.verbosity === 'concise'
  ? '- Keep responses brief and focused (1-2 paragraphs)'
  : persona.verbosity === 'thorough'
  ? '- Provide thorough analysis when the topic warrants it'
  : ''}

${turnContext.speakerInstruction ? `## Specific Direction\n${turnContext.speakerInstruction}` : ''}`;
}

/**
 * Build the user message containing recent conversation context
 */
export function buildConversationContext(
  council: Council,
  turnContext: TurnContext,
  maxMessages = 10
): string {
  const recentMessages = turnContext.recentMessages.slice(-maxMessages);

  if (recentMessages.length === 0) {
    return `This is the start of the discussion. The topic is: "${council.topic}"\n\nPlease share your initial perspective.`;
  }

  const messageStrings = recentMessages.map((m) => {
    const speaker = getSpeakerName(m, council);
    return `[${speaker}]: ${m.content}`;
  });

  let context = `## Recent Discussion\n\n${messageStrings.join('\n\n')}`;

  if (turnContext.openQuestions.length > 0) {
    context += `\n\n## Open Questions\n${turnContext.openQuestions.map((q) => `- ${q}`).join('\n')}`;
  }

  context += '\n\n---\n\nPlease respond as your character, building on or responding to the discussion.';

  return context;
}

/**
 * Get the display name for a message speaker
 */
function getSpeakerName(message: CouncilMessage, council: Council): string {
  if (message.speakerType === 'user') return 'User';
  if (message.speakerType === 'system') return 'System';
  const persona = council.personas.find((p) => p.id === message.speakerId);
  return persona?.name || 'Unknown';
}

/**
 * Build prompt for synthesis generation
 */
export function buildSynthesisPrompt(council: Council): string {
  const personaSummaries = council.personas
    .filter((p) => !p.muted)
    .map(
      (p) => `**${p.name}** (${p.predisposition.stance})
Argues for: ${p.predisposition.arguesFor || 'N/A'}`
    )
    .join('\n');

  const messageStrings = council.messages.map((m) => {
    const speaker = getSpeakerName(m, council);
    return `[${speaker}]: ${m.content}`;
  });

  return `You are synthesizing a multi-perspective discussion.

## Topic
${council.topic}

## Participants and Positions
${personaSummaries}

## Discussion So Far
${messageStrings.join('\n\n')}

## Your Task
Generate a synthesis that:
1. Summarizes the key positions and tensions
2. Identifies areas of agreement
3. Notes unresolved disagreements
4. Suggests a path forward or decision framework
5. Rates consensus level (0-100%)

Respond in JSON format:
{
  "summary": "2-3 paragraph summary of the discussion",
  "consensusLevel": 0.65,
  "agreements": ["Point 1 everyone agrees on", "Point 2..."],
  "tensions": ["Key tension 1", "Key tension 2..."],
  "keyDecisions": ["Decision or recommendation 1", "..."],
  "dissent": ["Unresolved disagreement 1", "..."],
  "nextSteps": ["Suggested next step 1", "..."]
}`;
}

/**
 * Build prompt for debate between two personas
 */
export function buildDebatePrompt(
  persona: Persona,
  opponent: Persona,
  topic: string,
  council: Council
): string {
  return `You are ${persona.name} in a focused debate with ${opponent.name}.

## Your Position
${persona.predisposition.systemPrompt}
You argue for: ${persona.predisposition.arguesFor}
You argue against: ${persona.predisposition.arguesAgainst}

## Your Opponent
${opponent.name} (${opponent.predisposition.stance})
They argue for: ${opponent.predisposition.arguesFor}
They argue against: ${opponent.predisposition.arguesAgainst}

## Debate Topic
${topic || council.topic}

## Instructions
Make your strongest argument for your position. Address ${opponent.name}'s likely counterarguments. Be direct and substantive.`;
}

/**
 * Build prompt for steelmanning another persona's position
 */
export function buildSteelmanPrompt(
  persona: Persona,
  targetPersona: Persona,
  council: Council
): string {
  // Get the target persona's recent messages
  const targetMessages = council.messages
    .filter((m) => m.speakerId === targetPersona.id)
    .slice(-3)
    .map((m) => m.content)
    .join('\n\n');

  return `You are ${persona.name}, but your task is special: you must steelman ${targetPersona.name}'s position.

## Context
${targetPersona.name} has been arguing:
${targetMessages || targetPersona.predisposition.arguesFor}

## Your Task
Present the STRONGEST possible version of ${targetPersona.name}'s argument. Even though you typically ${persona.predisposition.arguesFor}, now you must:

1. Articulate their position more clearly and compellingly than they might
2. Identify the best evidence and reasoning that supports their view
3. Explain why a reasonable person might hold this position
4. Present it genuinely, not as a strawman

This is an exercise in intellectual honesty and understanding opposing views.`;
}

/**
 * Build prompt for finding common ground
 */
export function buildCommonGroundPrompt(council: Council): string {
  const positions = council.personas
    .filter((p) => !p.muted)
    .map((p) => {
      const recentMessage = council.messages
        .filter((m) => m.speakerId === p.id)
        .slice(-1)[0];
      return `${p.name}: ${recentMessage?.content || p.predisposition.arguesFor || 'No position stated yet'}`;
    })
    .join('\n\n');

  return `## Discussion Positions
${positions}

## Your Task
Identify what these participants AGREE on, even if they disagree on many things. Look for:
- Shared values or goals
- Common concerns
- Areas of potential compromise
- Underlying assumptions they share

Be specific and constructive. The goal is to find a foundation for moving forward.`;
}

/**
 * Build prompt for asking a specific persona a question
 */
export function buildAskPrompt(
  persona: Persona,
  question: string,
  council: Council
): string {
  return `${buildPersonaSystemPrompt(persona, council, {
    recentMessages: council.messages.slice(-5),
    currentTopic: council.topic,
    openQuestions: [question],
    speakerInstruction: `The user has directed this question specifically to you: "${question}"\n\nProvide a thoughtful response that reflects your unique perspective as ${persona.name}.`,
  })}`;
}

/**
 * Build prompt for voting/final position
 */
export function buildVotePrompt(persona: Persona, council: Council): string {
  return `You are ${persona.name}. After the discussion so far, state your FINAL position.

## Your Identity
${persona.predisposition.systemPrompt}

## Discussion Summary
Topic: ${council.topic}
Messages exchanged: ${council.messages.length}
Other participants: ${council.personas.filter((p) => p.id !== persona.id).map((p) => p.name).join(', ')}

## Your Task
State your final position in 1-2 sentences. Then rate your confidence (0-100%). Be clear and decisive.

Format:
POSITION: [Your final position]
CONFIDENCE: [0-100]%
RATIONALE: [Brief explanation]`;
}

/**
 * Extract open questions from recent messages
 */
export function extractOpenQuestions(messages: CouncilMessage[]): string[] {
  const questions: string[] = [];

  for (const message of messages.slice(-10)) {
    // Simple heuristic: find sentences ending with ?
    const sentences = message.content.split(/[.!?]+/);
    for (const sentence of sentences) {
      if (message.content.includes(sentence + '?')) {
        const trimmed = sentence.trim();
        if (trimmed.length > 10 && trimmed.length < 200) {
          questions.push(trimmed + '?');
        }
      }
    }
  }

  // Return unique questions, most recent first
  return [...new Set(questions.reverse())].slice(0, 5);
}

// ============================================================================
// Deliberation Prompts - Structured Multi-Agent Workflow
// ============================================================================

/**
 * Minimal worker system prompt when persona is suppressed
 */
export interface WorkerPermissions {
  writePermissions?: boolean;
  workingDirectory?: string;
  directoryConstrained?: boolean;
}

export function getMinimalWorkerSystemPrompt(permissions?: WorkerPermissions, stepType?: CouncilStepType): string {
  if (stepType === 'agent' || stepType === 'analysis') {
    const saveNote = permissions?.workingDirectory
      ? `\nIf you need to save output, include the content in your response with a clear file path label.`
      : '';
    return `You are an execution agent. Your job is to PERFORM the task by analyzing the source code and project structure provided in your context — not to write code, not to plan, not to describe what should be done.

The source code and project structure are provided in your context. Analyze them directly.
For example, if told to collect data from an API, analyze the API code in your context and describe the results.
If told to search for information, examine the code provided in your context and return what you found.

CRITICAL RULES:
- DO NOT write code or scripts that would perform the task — analyze the provided context and produce results
- DO NOT create implementation plans, documentation, or mock data
- ACTUALLY ANALYZE the code in your context and return the real results
- If you cannot find something in the provided context, report what is missing
- Your response should contain the ACTUAL DATA or RESULTS from analyzing the context${saveNote}

When DONE, end with:
## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**What was done:** 1-3 sentence description of what you actually analyzed
**Known issues:** [None | list any issues]`;
  }

  if (permissions?.writePermissions) {
    const workspaceDir = permissions.workingDirectory
      ? `${permissions.workingDirectory.replace(/\/$/, '')}/.kondi/workspace`
      : undefined;
    const scopeNote = workspaceDir
      ? (permissions.directoryConstrained
        ? `Output directory: ${workspaceDir}
All output you produce MUST be for ${workspaceDir} (label it clearly in your response).
You may reference files from anywhere under ${permissions.workingDirectory}, but output only targets the directory above.`
        : `Working directory: ${permissions.workingDirectory}
Output directory for new files: ${workspaceDir}
Produce new file content for the output directory. You may reference existing files in-place.`)
      : `You may reference and produce content for files as needed.`;

    if (stepType === 'review') {
      return `You are the Worker agent — a documentation specialist. Your job is to review the codebase for quality and produce THREE documentation deliverables.

${scopeNote}

The source code and project structure are provided in your context. Analyze them directly.

CRITICAL RULES:
- You MUST produce exactly THREE documentation artifacts in your response:
  1. README.md — Project overview, setup instructions, usage guide, architecture summary
  2. docs/ folder — Detailed documentation (API reference, architecture decisions, guides)
  3. review.md — Code quality review: spec adherence, issues found, recommendations
- Examine the codebase in your context thoroughly before writing any documentation
- Do NOT modify any source code files — only create documentation files
- Produce the content in your response using clearly labeled code blocks
- Follow the directive exactly as written
- When DONE, you MUST end with a ## COMPLETION SUMMARY section (status, files created, what was produced, known issues)`;
    }

    if (stepType === 'enrich') {
      return `You are the Worker agent — an innovation specialist. Your job is to research the codebase and market landscape, then brainstorm creative feature ideas that extend beyond the original spec.

${scopeNote}

The source code and project structure are provided in your context. Analyze them directly.

CRITICAL RULES:
- You MUST produce an enrichment document in your response (e.g., enrichment.md or ENRICHMENT.md)
- Examine the codebase in your context thoroughly to understand what exists, what patterns are used, and what gaps exist
- Research the market context — competitive landscape, user needs, industry trends
- Brainstorm NEW features and enhancements that go BEYOND the original spec
- For each feature idea, assess: user value, technical feasibility, implementation effort, and priority
- Do NOT modify any source code files — only create the enrichment document
- Produce the content in your response using clearly labeled code blocks
- Follow the directive exactly as written
- When DONE, you MUST end with a ## COMPLETION SUMMARY section (status, files created, what was produced, known issues)`;
    }

    if (stepType === 'code_planning') {
      return `You are the Worker agent — a planning specialist. Your job is to produce a DETAILED PLAN DOCUMENT, NOT code.

${scopeNote}

The source code and project structure are provided in your context. Analyze them directly.

Produce the plan document in your response (e.g., plan.md or PLAN.md) using a clearly labeled code block.

CRITICAL RULES:
- Produce a PLAN, not code. Do NOT write source code files, implementation files, or any executable code.
- Your output is a structured, actionable plan document that a separate coding step will later implement.
- Produce the plan document in your response using a clearly labeled code block.
- The plan should include: phases, steps, dependencies, architecture decisions, file structure, interfaces, and acceptance criteria.
- Follow the directive exactly as written
- If anything is unclear, flag it explicitly — do not guess
- When DONE, you MUST end with a ## COMPLETION SUMMARY section (status, files created/modified, what was built, known issues)`;
    }

    return `You are the Worker agent — a hands-on implementer. Your job is to execute the directive by ACTUALLY WRITING CODE AND FILES, not by describing what should be done.

${scopeNote}

CRITICAL — BEFORE YOU START CODING:
The source code and project structure are provided in your context. Examine them carefully:
1. Review the project structure in the context (find key directories and files)
2. Examine the files you'll be modifying (understand existing patterns)
3. Review the code in your context to locate related code (imports, function calls, type definitions)
Your changes MUST integrate with the existing codebase. Do not rewrite files
from scratch unless the directive explicitly asks you to create new files.

Produce the content in your response using clearly labeled code blocks:
\`\`\`filename: path/to/file.ts
// file contents here
\`\`\`

CRITICAL RULES:
- IMPLEMENT the code. Produce real file contents in your response. Do not describe or summarize what to build.
- Follow the directive exactly as written
- If the directive says to create files, produce their full content in your response
- If anything is unclear, flag it explicitly — do not guess
- If something seems incorrect or impossible, say so — do not silently deviate
- Do not add features, optimizations, or changes not specified in the directive
- When DONE, you MUST end with a ## COMPLETION SUMMARY section (status, files created/modified, what was built, known issues)`;
  }

  return `You are the Worker agent. Your job is to execute the directive precisely.

All of your output must be produced directly as text in your response.
If the directive asks you to create files, write code, or produce documents,
include them in your response using clearly labeled code blocks or sections.

For example, if asked to write a file, output it like:
\`\`\`filename: path/to/file.ts
// file contents here
\`\`\`

Rules:
- Follow the directive exactly as written
- Produce ALL output directly in your response text
- If anything is unclear, flag it explicitly in your output — do not guess
- If something seems incorrect or impossible, say so — do not silently deviate
- Do not add features, optimizations, or changes not specified in the directive`;
}

// ============================================================================
// Manager Prompts
// ============================================================================

/**
 * Manager frames the problem - Section 9.1
 */
export function buildManagerFramingPrompt(rawProblem: string): string {
  return `You are framing a problem for a team of consultants who will analyze it
from different perspectives, then debate approaches.

The project's source code and directory structure are provided in the context above.
Analyze the code directly from what's provided — do not say you need tools or external access.
The code is in your prompt. Read it carefully.

Write a structured problem statement that includes:
- CONTEXT: What background does the team need?
- PROBLEM: What specific question must be answered?
- CONSTRAINTS: What are the non-negotiable requirements?
- DESIRED OUTCOME: What does a good solution look like?
- SCOPE: What is and isn't in scope?

RAW PROBLEM:
${rawProblem}`;
}

/**
 * Manager evaluates the round - Section 9.4
 */
export function buildManagerEvaluationPrompt(
  ledgerContext: string,
  pendingPatches: ContextPatch[],
  expectedOutput?: string
): string {
  const patchesSection = pendingPatches.length > 0
    ? `\n---\n\nPENDING CONTEXT PROPOSALS:\n${pendingPatches.map((p) =>
        `Patch ${p.id} by ${p.authorPersonaId}:\nWhat: ${p.diff}\nRationale: ${p.rationale}`
      ).join('\n\n')}\n\nFor each patch, decide: ACCEPT or REJECT with reason.`
    : '';

  const expectedOutputSection = expectedOutput
    ? `\n---\n\nEXPECTED OUTPUT (the final deliverable must satisfy this):\n${expectedOutput}`
    : '';

  return `${ledgerContext}
${patchesSection}
${expectedOutputSection}

---

Evaluate this round of deliberation.

YOUR RESPONSIBILITIES AS MANAGER:
1. Keep the conversation focused on the task and expected output
2. If the discussion is getting derailed or fixated on irrelevant topics, use REDIRECT
3. Ensure progress is being made toward a solution that meets the expected output
4. Move the conversation forward productively

Decide:
1. CONTINUE — positions are still evolving, run another round
   Include a question to focus and advance the discussion.
2. DECIDE — enough clarity exists to make a decision that will meet the expected output
3. REDIRECT — consultants are off-track, unfocused, or fixated on irrelevant details.
   Use this to get the conversation back on track with a specific refocusing question.

Respond as JSON:
{
  "patchDecisions": [
    { "patchId": "...", "accepted": true/false, "reason": "..." }
  ],
  "action": "continue" | "decide" | "redirect",
  "reasoning": "...",
  "question": "required for continue or redirect - use this to guide the discussion",
  "confidence": 0.0-1.0,
  "missingInformation": ["optional list"]
}`;
}

/**
 * Manager makes decision - Section 9.5
 */
export function buildManagerDecisionPrompt(
  ledgerContext: string,
  decisionCriteria?: string[],
  expectedOutput?: string,
  stepType?: CouncilStepType
): string {
  const criteriaBlock = decisionCriteria?.length
    ? `\n---\n\nDECISION CRITERIA (evaluate against these):\n${decisionCriteria.map((c) => `- ${c}`).join('\n')}`
    : '';

  const expectedOutputBlock = expectedOutput
    ? `\n---\n\nEXPECTED OUTPUT (the final deliverable MUST satisfy this):\n${expectedOutput}`
    : '';

  const stepTypeNote = stepType === 'enrich'
    ? `\n\nCRITICAL: This is an ENRICHMENT step. Your decision must direct the worker to produce a creative enrichment document that goes BEYOND the original spec. The worker should:
1. Examine the codebase provided in the context to understand what exists and what gaps/opportunities are present
2. Analyze the market context — competitive landscape, user needs, and industry trends
3. Brainstorm new features and enhancements with user value, feasibility, effort, and priority assessments
4. Produce a structured enrichment document in their response
The worker must NOT modify any source code — only create the enrichment document.`
    : stepType === 'review'
    ? `\n\nCRITICAL: This is a REVIEW & DOCUMENTATION step. Your decision must direct the worker to produce THREE documentation artifacts:
1. README.md — Project overview, setup, usage, and architecture summary
2. docs/ folder — Detailed documentation files (API reference, architecture decisions, guides)
3. review.md — Code quality review with spec adherence evaluation, issues found, and recommendations
The worker must NOT modify any source code. The worker should examine the codebase provided in the context, evaluate quality against the spec, then produce all three documentation deliverables in their response.`
    : stepType === 'code_planning'
    ? `\n\nCRITICAL: This is a PLANNING step. Your decision must direct the worker to produce a DETAILED PLAN DOCUMENT — NOT code or implementation. The worker output should be a comprehensive specification covering architecture, dependencies, step-by-step implementation instructions, data flows, edge cases, and acceptance criteria. Think of it as a product/engineering spec that another developer could follow to implement the feature without ambiguity. Do NOT ask the worker to write code, create files, or implement anything.`
    : '';

  return `${ledgerContext}
${criteriaBlock}
${expectedOutputBlock}

---

The deliberation is complete. Make your decision.

IMPORTANT: Your decision must lead to a deliverable that matches the expected output exactly.${stepTypeNote}

Write:
- SUMMARY: Key positions and arguments from the consultants
- DECISION: What approach will we take?
- RATIONALE: Why this approach? Which arguments were most persuasive?
- REJECTED: Alternatives considered and why they were rejected
- RISKS: Known risks we are accepting
- ACCEPTANCE CRITERIA: How will we know the work output is correct?

You are not bound by majority opinion. Choose the approach with
the strongest reasoning.`;
}

/**
 * Manager forced decision (early termination) - Section 9.9
 */
export function buildManagerForcedDecisionPrompt(
  ledgerContext: string,
  stepType?: CouncilStepType
): string {
  const stepTypeNote = stepType === 'enrich'
    ? `\n\nCRITICAL: This is an ENRICHMENT step. Your decision must direct the worker to examine the codebase in the context and market landscape, then produce a creative enrichment document with new feature ideas, feasibility assessments, and priorities. The worker must NOT modify source code.`
    : stepType === 'review'
    ? `\n\nCRITICAL: This is a REVIEW & DOCUMENTATION step. Your decision must direct the worker to produce three documentation artifacts: README.md, docs/ folder, and review.md. The worker must NOT modify source code.`
    : stepType === 'code_planning'
    ? `\n\nCRITICAL: This is a PLANNING step. Your decision must direct the worker to produce a DETAILED PLAN DOCUMENT — NOT code. The output should be a comprehensive specification, not implementation.`
    : '';

  return `${ledgerContext}

---

NOTE: This deliberation was ended early by the user.
You must make a decision now with the information available.
Acknowledge what is incomplete or uncertain.${stepTypeNote}

Write:
- SUMMARY: What was discussed so far
- DECISION: Best approach given available information
- RATIONALE: Why, and what you're uncertain about
- RISKS: Higher than normal due to incomplete deliberation
- ACCEPTANCE CRITERIA: How to verify the output`;
}

/**
 * Manager creates execution plan
 */
export function buildManagerPlanPrompt(decision: string): string {
  return `Based on your decision, create an execution plan.

YOUR DECISION:
${decision}

Write a plan that:
- Breaks down the work into clear steps
- Identifies dependencies between steps
- Specifies what each step should produce
- Notes any prerequisites or setup needed

Keep the plan concrete and actionable.`;
}

/**
 * Manager issues work directive - Section 9.6
 */
export function buildWorkDirectivePrompt(decision: string, plan?: string, hasWritePermissions?: boolean, stepType?: CouncilStepType): string {
  const planSection = plan ? `\nPLAN:\n${plan}\n` : '';

  let outputNote = '';
  if (stepType === 'enrich') {
    outputNote = `\nCRITICAL: This is an ENRICHMENT step. The worker must produce a structured enrichment document that:
1. Analyzes the existing codebase — architecture, patterns, gaps, and opportunities
2. Researches market context — competitive landscape, user needs, industry trends
3. Brainstorms new features and enhancements BEYOND the original spec
4. Assesses each idea for: user value, technical feasibility, implementation effort, and priority
The worker MUST produce the enrichment document content in their response (e.g., enrichment.md).
The worker must NOT modify any source code files — only create the enrichment document.\n`;
  } else if (stepType === 'review') {
    outputNote = `\nCRITICAL: This is a REVIEW & DOCUMENTATION step. The worker must produce exactly THREE deliverables:
1. README.md — Project overview, setup instructions, usage guide, architecture summary
2. docs/ folder — Detailed documentation (API reference, architecture decisions, guides)
3. review.md — Code quality review: spec adherence, issues found, recommendations
The worker MUST produce these files' content in their response.
The worker must NOT modify any source code files — only create documentation.\n`;
  } else if (stepType === 'code_planning') {
    outputNote = `\nCRITICAL: This is a PLANNING step. The worker must produce a DETAILED PLAN — NOT code.
The output should be a structured, actionable plan document with:
- Clear steps and phases
- Dependencies between steps
- Specific deliverables for each step
- Technical approach and architecture decisions
- Success criteria and acceptance tests
Do NOT tell the worker to write code, create files, or implement anything.
The worker should produce a comprehensive plan that a separate coding step will later implement.

IMPORTANT: The worker's plan MUST include a ## STRUCTURED SPEC section at the end containing a
JSON code block with machine-readable project specification. This allows downstream coding steps
to consume concrete features, acceptance criteria, and file trees instead of guessing from prose.
Tell the worker this is mandatory.\n`;
  } else if (hasWritePermissions) {
    outputNote = `\nCRITICAL: The worker must produce the content in their response.
Your directive MUST tell the worker to ACTUALLY WRITE THE CODE — not describe it, not outline it, not summarize it.
The worker should produce every file and every line of code in their response.\n`;
  }

  return `Based on your decision, write a concrete work directive.

The project's source code and directory structure are provided in the context.
Reference specific file paths and code from what you've seen.

YOUR DECISION:
${decision}
${planSection}${outputNote}
The directive must be:
- SPECIFIC: Exactly what to do
- CONSTRAINED: Rules and limitations
- MEASURABLE: What does "done" look like?
- SELF-CONTAINED: The worker can execute from this alone

Do not include deliberation history, rejected alternatives,
or consultant arguments. The worker will not see any of that.
Give a clear, unambiguous task.`;
}

/**
 * Manager reviews output - Section 9.8
 */
export function buildManagerReviewPrompt(
  workOutput: string,
  directive: string,
  acceptanceCriteria?: string,
  expectedOutput?: string,
  hasWritePermissions?: boolean,
  stepType?: CouncilStepType,
  consultantReviews?: string,
): string {
  const criteriaSection = acceptanceCriteria
    ? `\nACCEPTANCE CRITERIA (from your decision):\n${acceptanceCriteria}\n`
    : '';

  const expectedOutputSection = expectedOutput
    ? `\nEXPECTED OUTPUT (the deliverable MUST match this):\n${expectedOutput}\n`
    : '';

  const implementationNote = stepType === 'enrich'
    ? `\nNOTE: This is an ENRICHMENT step. The worker was expected to produce an enrichment document covering:
1. Codebase analysis — existing architecture, patterns, gaps, and opportunities
2. Market research — competitive landscape, user needs, industry trends
3. Feature brainstorm — new ideas with user value, feasibility, effort, and priority
4. Prioritized recommendations — which features to pursue first
Verify the enrichment document was produced in the worker's response and covers all four areas.
The worker must NOT have modified any source code files.
If the document is missing areas or lacks depth, use REVISE with specific instructions on what to expand.\n`
    : stepType === 'review'
    ? `\nNOTE: This is a REVIEW & DOCUMENTATION step. The worker was expected to produce THREE documentation artifacts:
1. README.md — Project overview, setup, usage, architecture
2. docs/ folder — Detailed documentation files
3. review.md — Code quality review and recommendations
Verify that ALL THREE artifacts were produced in the worker's response. The worker must NOT have modified any source code files.
If any artifact is missing or incomplete, use REVISE with specific instructions on what to add.\n`
    : stepType === 'code_planning'
    ? `\nNOTE: This is a PLANNING step. The worker was expected to produce a detailed PLAN document,
NOT code or implementation. Evaluate whether the plan is thorough, actionable, and covers all requirements.
The plan MUST include a ## STRUCTURED SPEC section with a JSON code block containing: features (name,
description, acceptanceCriteria, files), architecture (fileTree, techStack), and phases. If the
structured spec is missing or incomplete, use REVISE and instruct the worker to add it.\n`
    : hasWritePermissions
    ? `\nNOTE: The worker was expected to produce complete file contents in their response.
If the worker's response includes clearly labeled code blocks with file contents, that IS valid implementation.
Only use REVISE if the worker truly did not produce the requested code.\n`
    : '';

  const consultantSection = consultantReviews
    ? `\nCONSULTANT REVIEWS:\n${consultantReviews}\n`
    : '';

  return `WORK DIRECTIVE:
${directive}
${criteriaSection}${expectedOutputSection}${implementationNote}
WORKER OUTPUT:
${workOutput}
${consultantSection}
---

Review the worker's output against the directive, acceptance criteria, and expected output.

HOW TO EVALUATE:
1. Look for the worker's "## COMPLETION SUMMARY" section at the end of their output.
   This tells you what they built, what files they created/modified, and any known issues.
2. If the summary says "Complete" and the files/description match the directive — ACCEPT.
3. If the summary says "Partial" or is missing key deliverables — REVISE with specifics.
4. If there is NO completion summary, the worker's output may be truncated or incomplete.
   In that case, use REVISE and instruct the worker to finish the implementation and
   include the mandatory completion summary.

CRITICAL: The output MUST match what was specified in the expected output. If it doesn't,
use REVISE with specific instructions to correct it, or RE-DELIBERATE if the approach
needs to be reconsidered by the consultants.

IMPORTANT: Your reasoning and verdict MUST be included in your JSON response below.
Review the code in your context to verify the worker's claims.
Do NOT modify any files.

CRITICAL VERIFICATION RULE: BEFORE issuing a REVISE verdict, carefully review the worker's
output to check whether the expected content was actually produced. If the worker's response
contains the correct content in labeled code blocks, ACCEPT the work — do NOT demand
additional proof. The worker's job is to produce the content. YOUR job is to verify it.

Decide:
- ACCEPT: Output meets the directive, acceptance criteria, AND expected output.
  Include a brief summary of what was delivered in your reasoning.
- REVISE: Output needs changes. Provide specific, actionable feedback.
- RE-DELIBERATE: The approach doesn't satisfy the expected output and requires the
  consultants to reconsider. Explain what needs to change.

Respond as JSON:
{
  "verdict": "accept" | "revise" | "re_deliberate",
  "reasoning": "what the worker delivered and whether it meets requirements",
  "feedback": "specific revision instructions (if revise)",
  "newInformation": "what changed (if re_deliberate)"
}`;
}

/**
 * Manager writes round summary - Section 9.10
 */
export function buildManagerRoundSummaryPrompt(roundEntries: LedgerEntry[]): string {
  const entriesText = roundEntries
    .filter((e) => ['analysis', 'response', 'proposal'].includes(e.entryType))
    .map((e) => `[${e.authorPersonaId}, ${e.entryType}]:\n${e.content}`)
    .join('\n\n');

  return `Summarize this round of deliberation for the next round's consultants.
Capture:
- Each consultant's key position
- Points of agreement
- Points of disagreement
- Unresolved questions

Keep it concise. The consultants will use this summary instead of
reading the full round.

ROUND ENTRIES:
${entriesText}`;
}

// ============================================================================
// Consultant Prompts
// ============================================================================

/**
 * Consultant independent analysis (Round 1) - Section 9.2
 */
export function buildIndependentAnalysisPrompt(
  persona: Persona,
  focusArea: string,
  contextContent: string
): string {
  return `${contextContent}

---

Analyze this problem from your area of expertise (${focusArea}).

Provide:
- Your assessment of the key challenges
- Your recommended approach
- Risks and concerns from your perspective
- Tradeoffs to consider

If you believe the shared context is missing something important,
you may propose a CONTEXT CHANGE by clearly marking it:

PROPOSED CONTEXT CHANGE:
What: {description of what to add/modify}
Why: {rationale}

Other consultants are analyzing this independently. You will see
their perspectives and can respond in the next round.

The source code and project structure are provided in your context. Analyze them directly to strengthen your analysis.`;
}

/**
 * Consultant deliberation response (Round 2+) - Section 9.3
 */
export function buildDeliberationResponsePrompt(
  persona: Persona,
  focusArea: string,
  fullContext: string
): string {
  return `${fullContext}

---

You have seen the other consultants' analyses. Provide your updated perspective:

- Where do you AGREE with other consultants and why?
- Where do you DISAGREE and what is your counter-argument?
- What important considerations have been MISSED?
- Has your position CHANGED? If so, how and why?
- What is your REFINED recommendation?

Do not restate your previous position unchanged.
Engage substantively with the other perspectives.

You may propose a CONTEXT CHANGE if you believe the shared context
should be updated:

PROPOSED CONTEXT CHANGE:
What: {description}
Why: {rationale}

The source code and project structure are provided in your context. Examine them to research and verify claims when it would strengthen your argument.`;
}

/**
 * Consultant final position before manager decision
 */
export function buildConsultantFinalPositionPrompt(
  persona: Persona, focusArea: string, fullContext: string
): string {
  return `The deliberation is ending. Based on everything discussed, provide your FINAL POSITION.

DELIBERATION CONTEXT:
${fullContext}

---

As ${persona.name} (focus: ${focusArea}), state:
1. Your recommended approach (1-2 sentences)
2. The single biggest risk if your recommendation is ignored
3. Any non-negotiable constraint from your domain

Be brief and decisive — this is your last input before the manager decides.`;
}

/**
 * Consultant review of worker output
 */
export function buildConsultantReviewPrompt(
  persona: Persona, focusArea: string,
  workOutput: string, directive: string, expectedOutput?: string
): string {
  return `Review the worker's output from your domain perspective (${focusArea}).

DIRECTIVE (what was requested):
${directive}
${expectedOutput ? `\nEXPECTED OUTCOME: ${expectedOutput}` : ''}

WORKER OUTPUT:
${workOutput}

---

As ${persona.name}, evaluate from your ${focusArea} perspective:
1. Does the output meet the directive requirements?
2. Any issues in your domain? (e.g., security flaws, performance problems, missing edge cases)
3. Specific improvements needed (if any)

Review the code in your context to verify claims.
Be concise — 3-5 sentences max. Focus on actionable feedback, not style preferences.`;
}

// ============================================================================
// Worker Prompts
// ============================================================================

/**
 * Worker execution - Section 9.7
 */
export function buildWorkerExecutionPrompt(directive: string, permissions?: WorkerPermissions, stepType?: CouncilStepType): string {
  if (stepType === 'agent' || stepType === 'analysis') {
    const saveNote = permissions?.writePermissions && permissions?.workingDirectory
      ? `\nIf you need to save output to a file, include the content in your response with a clear file path label for: ${permissions.workingDirectory}`
      : '';
    return `TASK:
${directive}

---
EXECUTE THIS TASK NOW by analyzing the source code and project structure provided in your context. Do NOT write code, scripts, or plans.
Examine the code provided in the context directly to perform the work and return the actual results.${saveNote}

When DONE, end with:
## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**What was done:** 1-3 sentence description of what you actually analyzed
**Known issues:** [None | list any issues]`;
  }

  if (permissions?.writePermissions) {
    if (stepType === 'enrich') {
      return `DIRECTIVE:
${directive}

---
STEP 1 — RESEARCH THE PROJECT:
Examine the project structure, source files, and existing documentation provided in your context.
Understand the architecture, patterns, conventions, and capabilities. Note what exists and what's missing.

STEP 2 — RESEARCH THE MARKET:
Analyze the competitive landscape, user needs, and industry trends relevant to this project.
Draw on your knowledge of the domain.
Consider: What do competing products offer? What do users expect? What are emerging trends?

STEP 3 — BRAINSTORM FEATURES:
Generate creative feature ideas and enhancements that go BEYOND the original spec. For each idea include:
- **Feature name** and brief description
- **User value** — why users would want this
- **Technical feasibility** — how hard to implement given the existing architecture
- **Implementation effort** — rough estimate (small / medium / large)
- **Priority** — recommended priority (P0 critical / P1 high / P2 medium / P3 nice-to-have)

STEP 4 — WRITE ENRICHMENT DOCUMENT:
Produce the enrichment document content in your response (e.g., enrichment.md) structured as:
- Executive Summary
- Codebase Analysis (architecture, patterns, gaps, opportunities)
- Market Research (competitive landscape, user needs, trends)
- Feature Ideas (the full brainstorm from Step 3)
- Prioritized Recommendations (top features to pursue, with rationale)

Do NOT modify any source code files — only create the enrichment document.
Produce the content in your response using a clearly labeled code block.

MANDATORY — When you are DONE, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/enrichment.md — brief description
**What was produced:** 1-3 sentence description of the enrichment document
**Known issues:** [None | list any issues]`;
    }

    if (stepType === 'review') {
      return `DIRECTIVE:
${directive}

---
STEP 1 — UNDERSTAND THE CODEBASE:
Examine the project structure, source files, and existing documentation provided in your context.
Understand the architecture, patterns, and conventions used.

STEP 2 — REVIEW CODE QUALITY:
Evaluate the codebase against the spec/requirements provided in the directive.
Note: code quality issues, spec adherence gaps, architectural concerns, and areas for improvement.

STEP 3 — WRITE DOCUMENTATION:
You MUST produce exactly THREE documentation artifacts in your response:

1. README.md — Project overview, setup instructions, usage guide, architecture summary
2. docs/ folder — Create multiple files covering: API reference, architecture decisions, developer guides
   (e.g., docs/architecture.md, docs/api-reference.md, docs/getting-started.md)
3. review.md — Code quality review including: spec adherence evaluation, issues found, recommendations, quality score

Do NOT modify any source code files — only create documentation files.
Produce the content in your response using clearly labeled code blocks for EACH file.

MANDATORY — When you are DONE, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- README.md — brief description
- docs/architecture.md — brief description
- docs/api-reference.md — brief description
- review.md — brief description
**What was produced:** 1-3 sentence description of the documentation
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
    }

    if (stepType === 'code_planning') {
      return `DIRECTIVE:
${directive}

---
IMPORTANT: You are a planning agent.
Your job is to produce a DETAILED PLAN DOCUMENT — NOT code.

Produce the plan document in your response (e.g., plan.md or PLAN.md) using a clearly labeled code block.
Do NOT write source code, implementation files, or any executable code.

The plan should be thorough and actionable, covering:
- Clear phases and steps
- Dependencies between steps
- Architecture and design decisions
- File/module structure
- Interface definitions
- Success criteria and acceptance tests

MANDATORY STRUCTURED SPEC — Your plan document MUST end with a ## STRUCTURED SPEC section
containing a JSON code block. This machine-readable spec allows downstream coding steps to
consume concrete features, acceptance criteria, and file trees. Format:

\`\`\`json
{
  "features": [
    {
      "name": "Feature name",
      "description": "What it does",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "files": ["src/path/to/file.ts"]
    }
  ],
  "architecture": {
    "fileTree": ["src/", "src/components/", "src/utils/"],
    "techStack": ["React", "TypeScript"]
  },
  "phases": [
    {
      "name": "Phase 1",
      "features": ["Feature name"],
      "dependencies": []
    }
  ]
}
\`\`\`

This structured spec is CRITICAL — downstream coding steps parse it to decompose work.

MANDATORY — When you are DONE, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/plan.md — brief description
**What was produced:** 1-3 sentence description of the plan
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
    }

    return `DIRECTIVE:
${directive}

---
STEP 1 — UNDERSTAND THE CODEBASE:
Before writing any code, examine the existing files provided in your context.
Understand the project structure, existing patterns, and conventions.
Your implementation must integrate with what already exists.

STEP 2 — IMPLEMENT:
You are an implementation agent.
DO NOT just describe what needs to be done or output vague summaries.
Produce the content in your response using clearly labeled code blocks:
\`\`\`filename: path/to/file.ts
// file contents here
\`\`\`

You MUST produce every file's content in your response — do not just show snippets.

MANDATORY — When you are DONE implementing, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/file1.ts — brief description
- path/to/file2.ts — brief description
**Files modified:**
- path/to/existing.ts — what changed
**What was built:** 1-3 sentence description of the working result
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
  }

  return `DIRECTIVE:
${directive}

---
Remember: Produce all output directly in your response. Use labeled code blocks for any files or code.

MANDATORY — When you are DONE, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files/sections produced:**
- filename or section — brief description
**What was built:** 1-3 sentence description of the result
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
}

/**
 * Worker revision - Section 9.7.1
 */
export function buildWorkerRevisionPrompt(
  directive: string,
  previousOutput: string,
  feedback: string,
  permissions?: WorkerPermissions,
  stepType?: CouncilStepType,
): string {
  if (permissions?.writePermissions) {
    if (stepType === 'enrich') {
      return `DIRECTIVE:
${directive}

YOUR PREVIOUS OUTPUT:
${previousOutput}

REVISION FEEDBACK:
${feedback}

Revise your enrichment document to address the feedback. Follow the original directive.
Only change what the feedback asks you to change.

IMPORTANT: Produce the updated enrichment document content in your response using a clearly labeled code block.
Review your previous output carefully, then produce the revised version.
Do NOT modify any source code files — only the enrichment document.

MANDATORY — When you are DONE with revisions, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/file — brief description
**Files modified:**
- path/to/file — what changed
**What was produced:** 1-3 sentence description of the enrichment document
**What was revised:** 1-2 sentences on what the feedback asked for and what you changed
**Known issues:** [None | list any issues]`;
    }

    if (stepType === 'review') {
      return `DIRECTIVE:
${directive}

YOUR PREVIOUS OUTPUT:
${previousOutput}

REVISION FEEDBACK:
${feedback}

Revise your documentation to address the feedback. Follow the original directive.
Only change what the feedback asks you to change.

IMPORTANT: Produce the updated documentation content in your response using clearly labeled code blocks.
Review your previous output carefully, then produce the revised versions.
You must maintain all three deliverables: README.md, docs/ folder, and review.md.
Do NOT modify any source code files — only documentation files.

MANDATORY — When you are DONE with revisions, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/file — brief description
**Files modified:**
- path/to/file — what changed
**What was produced:** 1-3 sentence description of the documentation
**What was revised:** 1-2 sentences on what the feedback asked for and what you changed
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
    }

    if (stepType === 'code_planning') {
      return `DIRECTIVE:
${directive}

YOUR PREVIOUS PLAN:
${previousOutput}

REVISION FEEDBACK:
${feedback}

Revise your plan document to address the feedback. Follow the original directive.
Only change what the feedback asks you to change.

IMPORTANT: Produce the updated plan document in your response using a clearly labeled code block.
Actually revise the plan content. Do NOT write source code or implementation files.

IMPORTANT: Preserve the ## STRUCTURED SPEC section with the JSON code block at the end of the plan.
Update the structured spec to reflect any changes from the revision. The structured spec must contain:
features (name, description, acceptanceCriteria, files), architecture (fileTree, techStack), and phases.

MANDATORY — When you are DONE with revisions, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/plan.md — brief description
**Files modified:**
- path/to/plan.md — what changed
**What was produced:** 1-3 sentence description of the plan
**What was revised:** 1-2 sentences on what the feedback asked for and what you changed
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
    }

    return `DIRECTIVE:
${directive}

YOUR PREVIOUS OUTPUT:
${previousOutput}

REVISION FEEDBACK:
${feedback}

Revise your implementation to address the feedback. Follow the original directive.
Only change what the feedback asks you to change.

IMPORTANT: Produce the updated file contents in your response using clearly labeled code blocks.
Review your previous output carefully, then produce the revised versions.

MANDATORY — When you are DONE with revisions, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created:**
- path/to/file1.ts — brief description
**Files modified:**
- path/to/existing.ts — what changed
**What was built:** 1-3 sentence description of the working result
**What was revised:** 1-2 sentences on what the feedback asked for and what you changed
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
  }

  return `DIRECTIVE:
${directive}

YOUR PREVIOUS OUTPUT:
${previousOutput}

REVISION FEEDBACK:
${feedback}

Revise your output to address the feedback. Follow the original
directive. Only change what the feedback asks you to change.

Remember: Produce all output directly in your response. Use labeled code blocks for any files or code.

MANDATORY — When you are DONE with revisions, you MUST end your response with a completion summary
in EXACTLY this format:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files/sections produced:**
- filename or section — brief description
**What was built:** 1-3 sentence description of the result
**What was revised:** 1-2 sentences on what the feedback asked for and what you changed
**Known issues:** [None | list any issues]

This summary is CRITICAL — the manager uses it to evaluate your work. Do NOT skip it.`;
}

// ============================================================================
// Coding Orchestrator Prompts
// ============================================================================

/**
 * Manager decomposes a spec into parallel modules for workers
 */
export function buildDecompositionPrompt(spec: string, workerCount: number): string {
  const contextPreamble = `BEFORE DECOMPOSING — EXAMINE THE CONTEXT:
The source code and project structure are provided in your context. Analyze them directly:
1. Review the existing project structure in the context (key directories and files)
2. Understand what code already exists (examine key files in the context)
3. Identify files that need to be modified vs. created from scratch
4. Note existing patterns, frameworks, and conventions

Your decomposition MUST account for existing code. Do not plan to recreate
things that already exist — plan to modify or extend them.

`;

  if (workerCount <= 1) {
    return `You are decomposing a specification into an implementation plan for a single worker.

${contextPreamble}SPECIFICATION:
${spec}

---

Since there is only 1 worker, produce a single module with the full implementation directive.

Respond as JSON:
{
  "modules": [
    {
      "name": "main",
      "files": ["list of files to create or modify"],
      "interfaces": "public interfaces this module exposes (types, exports, APIs)",
      "dependencies": [],
      "directive": "complete implementation directive for the worker"
    }
  ],
  "integrationNotes": "any notes about how the code fits together",
  "testStrategy": "how to verify the implementation works",
  "installCommand": "command to install dependencies (e.g. npm install, pip install -r requirements.txt). Empty string if not needed or if build handles it (cargo build).",
  "buildCommand": "command to compile/build the project (e.g. npm run build, tsc --noEmit, cargo build). Empty string if no build step needed."
}`;
  }

  return `You are decomposing a specification into ${workerCount} parallel modules for worker agents.

${contextPreamble}SPECIFICATION:
${spec}

---

Break this spec into ${workerCount} modules that can be implemented in parallel.

Requirements:
- Each module should be as independent as possible
- Define clear interfaces between modules so workers can code to a contract
- Each module gets its own list of files, a directive, and declared dependencies
- If modules depend on each other, list the dependency by module name
- Directives must be concrete and self-contained — workers only see their own module

Respond as JSON:
{
  "modules": [
    {
      "name": "descriptive-module-name",
      "files": ["list of files this module creates or modifies"],
      "interfaces": "public interfaces this module exposes (types, exports, APIs) that other modules may depend on",
      "dependencies": ["names of other modules this depends on"],
      "directive": "complete implementation directive for the worker assigned to this module"
    }
  ],
  "integrationNotes": "how the modules connect — shared types, import paths, integration points",
  "testStrategy": "how to verify the full implementation works end-to-end",
  "installCommand": "command to install dependencies (e.g. npm install, pip install -r requirements.txt). Empty string if not needed or if build handles it (cargo build).",
  "buildCommand": "command to compile/build the project (e.g. npm run build, tsc --noEmit, cargo build). Empty string if no build step needed."
}`;
}

/**
 * Per-worker directive with module scope and interfaces of other modules
 */
export function buildModuleDirectivePrompt(
  module: { name: string; files: string[]; interfaces: string; dependencies: string[]; directive: string },
  otherModuleInterfaces: Array<{ name: string; interfaces: string }>,
  integrationNotes: string,
  permissions?: WorkerPermissions,
): string {
  const interfacesSection = otherModuleInterfaces.length > 0
    ? `\n## OTHER MODULE INTERFACES (code to these contracts — do NOT implement them)\n${otherModuleInterfaces.map(
        (m) => `### ${m.name}\n${m.interfaces}`
      ).join('\n\n')}\n`
    : '';

  const depsSection = module.dependencies.length > 0
    ? `\nDependencies: This module depends on: ${module.dependencies.join(', ')}\nImport from the interfaces above — do not reimplement them.\n`
    : '';

  const scopeNote = permissions?.writePermissions
    ? `\nIMPORTANT: Produce every file's content in your response using clearly labeled code blocks:
\`\`\`filename: path/to/file.ts
// contents
\`\`\`
${permissions.workingDirectory
  ? (permissions.directoryConstrained
    ? `All file operations MUST be within: ${permissions.workingDirectory}`
    : `Working directory: ${permissions.workingDirectory}`)
  : 'You may produce content for files as needed.'}\n`
    : `\nOutput all code in labeled code blocks:\n\`\`\`filename: path/to/file.ts\n// contents\n\`\`\`\n`;

  return `## MODULE: ${module.name}
Files: ${module.files.join(', ')}

NOTE: The source code and project structure are provided in your context. Examine them before coding.
Your implementation must integrate with the existing codebase.

## DIRECTIVE
${module.directive}
${interfacesSection}${depsSection}
## INTEGRATION NOTES
${integrationNotes}
${scopeNote}
MANDATORY — When DONE, end with:

## COMPLETION SUMMARY
**Status:** [Complete | Partial — explain what's missing]
**Files created/modified:** list each with brief description
**What was built:** 1-3 sentence description
**Known issues:** [None | list any issues]`;
}

/**
 * Code reviewer evaluates all worker outputs against the original spec
 */
export function buildCodeReviewPrompt(
  spec: string,
  workerOutputs: Array<{ moduleName: string; output: string }>,
  expectedOutput?: string,
): string {
  const outputsSection = workerOutputs
    .map((w) => `### Module: ${w.moduleName}\n${w.output}`)
    .join('\n\n---\n\n');

  const expectedSection = expectedOutput
    ? `\n## EXPECTED OUTPUT\n${expectedOutput}\n`
    : '';

  return `You are a code reviewer. Review all worker implementations against the original specification.

## ORIGINAL SPECIFICATION
${spec}
${expectedSection}
## WORKER IMPLEMENTATIONS
${outputsSection}

The source code and project structure are provided in your context. Review the code in the context
to verify the implementation. Cross-reference the worker output against what exists in the codebase.

---

STEP 1 — INVESTIGATE:
Examine the code provided in the context. Verify that the worker's output is consistent with
the existing codebase and matches the specification. Note any discrepancies.

STEP 2 — ASSESS:
Review for:
1. **Correctness**: Does the implementation match the spec? Are all requirements met?
2. **Integration**: Will the modules work together? Are interfaces compatible?
3. **Quality**: Are there bugs, edge cases, or obvious issues?
4. **Completeness**: Is anything missing from the spec?

STEP 3 — RESPOND:
After your investigation, respond with ONLY a JSON block (no other text after it):

\`\`\`json
{
  "verdict": "pass" | "needs_revision",
  "issues": [
    {
      "module": "module-name",
      "severity": "critical" | "major" | "minor",
      "description": "Specific description of what is wrong — reference the exact file, function, or line",
      "suggestion": "Exact fix: what code to change, what to add, or what to remove"
    }
  ],
  "summary": "overall assessment of the implementation"
}
\`\`\`

CRITICAL RULES:
- If verdict is "needs_revision", the issues array MUST NOT be empty.
- Each issue MUST have a specific description (file path + what's wrong) and a concrete suggestion (what to change).
- Do NOT say "needs_revision" without explaining exactly what to fix — vague feedback wastes a revision cycle.
- If there are no critical or major issues, verdict MUST be "pass".
- Only use "needs_revision" for issues that would prevent the code from working correctly.`;
}

/**
 * Minimal system prompt for reviewer role (read-only)
 */
export function buildReviewerSystemPrompt(): string {
  return `You are a Code Reviewer agent. Your job is to evaluate code quality and correctness.
The source code and project structure are provided in your context. Examine them directly
when verifying worker implementations. Do not rely solely on worker output text.

You do NOT write code or modify files. You only review and provide feedback.
Your output must be structured JSON with a verdict and list of issues.

Be thorough but practical — flag real problems, not style preferences.
Focus on correctness, spec compliance, and integration issues.`;
}

/**
 * Debugger worker fixes test failures
 */
export function buildDebugFixPrompt(
  testOutput: string,
  allCode: string,
  spec: string,
  permissions?: WorkerPermissions,
  moduleName?: string,
  moduleFiles?: string[],
): string {
  const scopeNote = permissions?.writePermissions
    ? `\nIMPORTANT: Produce the fixed file contents in your response using clearly labeled code blocks.
Do NOT just describe fixes — produce the corrected code.
${permissions.workingDirectory
  ? (permissions.directoryConstrained
    ? `All file operations MUST be within: ${permissions.workingDirectory}`
    : `Working directory: ${permissions.workingDirectory}`)
  : 'You may produce content for files as needed.'}\n`
    : `\nOutput all fixes in labeled code blocks.\n`;

  const moduleContext = moduleName
    ? `\n## YOUR MODULE: ${moduleName}
${moduleFiles?.length ? `Files: ${moduleFiles.join(', ')}` : ''}
Focus your fixes on this module's code. Other modules are handled by other workers.\n`
    : '';

  return `You are a debugger. Tests/build are failing. Fix the code to make them pass.

## TEST OUTPUT (failures)
${testOutput}
${moduleContext}
## CURRENT CODE
${allCode}

## ORIGINAL SPECIFICATION
${spec}
${scopeNote}
Instructions:
- Analyze the test failures and identify root causes
- If failures indicate missing packages or modules (e.g. "Cannot find module", "ModuleNotFoundError",
  "command not found"), ensure dependencies are declared in the project manifest and installed
- Make MINIMAL, targeted fixes — do not rewrite or refactor unrelated code
- Fix only what's broken, preserve everything else
- If a test failure reveals a spec misunderstanding, fix the code to match the spec

MANDATORY — When DONE, end with:

## COMPLETION SUMMARY
**Status:** [Complete | Partial]
**Files modified:** list each with what was fixed
**Fixes applied:** brief description of each fix
**Known issues:** [None | list any remaining issues]`;
}

/**
 * Worker revision based on reviewer feedback
 */
export function buildRevisionFromReviewPrompt(
  reviewFeedback: string,
  previousOutput: string,
  moduleDirective: string,
  permissions?: WorkerPermissions,
): string {
  const scopeNote = permissions?.writePermissions
    ? `\nIMPORTANT: Produce the updated file contents in your response using clearly labeled code blocks.
Do NOT just describe changes — produce the corrected code.
${permissions.workingDirectory
  ? (permissions.directoryConstrained
    ? `All file operations MUST be within: ${permissions.workingDirectory}`
    : `Working directory: ${permissions.workingDirectory}`)
  : 'You may produce content for files as needed.'}\n`
    : `\nOutput all revised code in labeled code blocks.\n`;

  return `## ORIGINAL DIRECTIVE
${moduleDirective}

## YOUR PREVIOUS OUTPUT
${previousOutput}

## REVIEWER FEEDBACK
${reviewFeedback}

---

Revise your implementation to address the reviewer's feedback.
Only change what the feedback asks you to change — do not rewrite unrelated code.
${scopeNote}
MANDATORY — When DONE, end with:

## COMPLETION SUMMARY
**Status:** [Complete | Partial]
**Files created/modified:** list each with brief description
**What was revised:** 1-2 sentences on what the feedback asked for and what you changed
**Known issues:** [None | list any issues]`;
}
