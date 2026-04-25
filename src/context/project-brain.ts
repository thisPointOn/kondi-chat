/**
 * Project Brain — unified context assembler.
 *
 * Pulls together every context source into one coherent block that
 * gets injected into the system prompt before every model call:
 *
 *   1. AGENTS.md / KONDI.md (project conventions)
 *   2. Recent receipts (what happened in prior turns)
 *   3. Relevant skills (procedures for this type of task)
 *   4. Preflight files (auto-loaded relevant code)
 *   5. Repo summary (from bootstrap)
 *
 * The brain doesn't decide which model runs — that's the router's
 * job. The brain decides what context that model should see.
 */

import { ReceiptStore } from './receipts.ts';
import { MemoryManager } from './memory.ts';
import { runPreflight } from './preflight.ts';
import { loadSkills, selectSkills, formatSkillsForContext, seedDefaultSkills } from './skills.ts';
import { TaskStore } from '../engine/task-store.ts';
import type { Session } from '../types.ts';

export interface BrainContext {
  /** Full assembled context for injection into system prompt. */
  fullContext: string;
  /** Files auto-loaded by preflight. */
  preflightFiles: string[];
  /** Skills matched for this task. */
  skillsUsed: string[];
}

/**
 * Assemble all context sources for a given task.
 * Called once per turn, before the agent loop starts.
 */
export function assembleBrainContext(
  workingDir: string,
  session: Session,
  task: string,
): BrainContext {
  const sections: string[] = [];
  const preflightFiles: string[] = [];
  const skillsUsed: string[] = [];

  // 1. Memory (AGENTS.md, KONDI.md)
  const memory = new MemoryManager(workingDir);
  const entries = memory.load();
  if (entries.length > 0) {
    sections.push(
      '## Project conventions\n\n' +
      entries.map(e => `### ${e.source}: ${e.path}\n${e.content}`).join('\n\n')
    );
  }

  // 2. Active task (persisted across sessions)
  const storageDir = `${workingDir}/.kondi-chat`;
  const taskStore = new TaskStore(storageDir);
  const activeTask = taskStore.formatForContext();
  if (activeTask) {
    sections.push(activeTask);
  }

  // 3. Recent receipts
  const receipts = new ReceiptStore(storageDir, session.id);
  const recentReceipts = receipts.formatForContext(3);
  if (recentReceipts) {
    sections.push(recentReceipts);
  }

  // 3. Skills
  seedDefaultSkills(workingDir);
  const skills = loadSkills(workingDir);
  const matched = selectSkills(task, skills, 2);
  if (matched.length > 0) {
    sections.push(formatSkillsForContext(matched));
    skillsUsed.push(...matched.map(s => s.name));
  }

  // 4. Preflight (relevant files)
  const preflight = runPreflight(workingDir, task);
  if (preflight.context) {
    sections.push(preflight.context);
    preflightFiles.push(...preflight.filesRead);
  }

  // 5. Repo summary (grounding context from bootstrap, if available)
  if (session.groundingContext) {
    // Already in the system prompt via cacheablePrefix — don't duplicate.
    // Just note it so the model knows it's there.
  }

  return {
    fullContext: sections.join('\n\n'),
    preflightFiles,
    skillsUsed,
  };
}
