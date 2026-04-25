/**
 * Skills — reusable task procedures loaded from .kondi-chat/skills/.
 *
 * Each skill is a SKILL.md file with structured instructions for how
 * to approach a category of task (debugging, adding features, refactoring,
 * code review, etc.). The skill router picks 1-3 relevant skills per
 * task and injects them into the system prompt so the model follows
 * a proven procedure instead of winging it.
 *
 * The router picks models. Skills teach models HOW to work.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface Skill {
  name: string;
  content: string;
  /** First line of the file, used as a short description for matching. */
  description: string;
}

const MAX_SKILL_SIZE = 5_000;

/**
 * Load skills from user-level + project-level .kondi-chat/skills/.
 * Project-level overrides user-level on name collision.
 */
export function loadSkills(workingDir: string): Skill[] {
  const skills = new Map<string, Skill>();

  // User-level first
  loadFromDir(join(homedir(), '.kondi-chat', 'skills'), skills);
  // Project-level overrides
  loadFromDir(join(workingDir, '.kondi-chat', 'skills'), skills);

  return [...skills.values()];
}

function loadFromDir(dir: string, skills: Map<string, Skill>): void {
  if (!existsSync(dir)) return;
  try {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      try {
        let content = readFileSync(join(dir, file), 'utf-8');
        if (content.length > MAX_SKILL_SIZE) {
          content = content.slice(0, MAX_SKILL_SIZE) + '\n(truncated)';
        }
        const name = basename(file, '.md').toLowerCase();
        const firstLine = content.split('\n').find(l => l.trim().length > 0 && !l.startsWith('#')) || '';
        skills.set(name, { name, content, description: firstLine.slice(0, 200) });
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir not readable */ }
}

/**
 * Pick the most relevant skills for a given task. Simple keyword
 * matching — no LLM call needed.
 */
export function selectSkills(task: string, skills: Skill[], max = 2): Skill[] {
  if (skills.length === 0) return [];
  const taskLower = task.toLowerCase();

  const scored = skills.map(skill => {
    let score = 0;
    // Match skill name against task words
    if (taskLower.includes(skill.name)) score += 10;
    // Match keywords from the skill description
    const descWords = skill.description.toLowerCase().split(/\s+/);
    for (const word of descWords) {
      if (word.length >= 4 && taskLower.includes(word)) score += 1;
    }
    return { skill, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(s => s.skill);
}

/**
 * Format selected skills for injection into the system prompt.
 */
export function formatSkillsForContext(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const sections = skills.map(s => `### Skill: ${s.name}\n${s.content}`);
  return `## Relevant procedures\n\n${sections.join('\n\n')}`;
}

/**
 * Seed default skills if the skills directory doesn't exist.
 */
export function seedDefaultSkills(workingDir: string): void {
  const dir = join(workingDir, '.kondi-chat', 'skills');
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });

  const defaults: Record<string, string> = {
    'debug': `# Debug

When debugging an issue:
1. Reproduce the problem — read the error message carefully
2. Find the source: search_code for the error text, read the relevant file
3. Understand the context: read related_files to see dependencies
4. Form a hypothesis about the root cause
5. Make the minimal fix — don't refactor while debugging
6. Verify: run the tests or typecheck to confirm the fix
7. Check for similar patterns elsewhere in the codebase`,

    'add-feature': `# Add Feature

When implementing a new feature:
1. Read existing code in the area — understand conventions, patterns, types
2. Check for tests — understand how existing features are tested
3. Plan the change: which files need modification, which are new
4. Implement incrementally — write, then verify with typecheck/tests
5. Follow existing patterns — don't introduce new conventions
6. Add tests if the project has them
7. Review your own diff before reporting done`,

    'refactor': `# Refactor

When refactoring code:
1. Understand WHY it needs refactoring — state the goal clearly
2. Read all the code you'll touch + its tests
3. Make sure existing tests pass BEFORE you start
4. Refactor in small steps — one file or one concept at a time
5. Run tests after each step
6. Don't change behavior — only structure
7. If you find bugs during refactoring, note them but don't fix them in the same change`,

    'review': `# Code Review

When reviewing code:
1. Read the full diff, not just the changed lines
2. Check: does it do what it claims? Are edge cases handled?
3. Look for: security issues, error handling gaps, race conditions
4. Check naming: are new names consistent with existing conventions?
5. Check tests: are new behaviors tested? Are old tests still valid?
6. Be specific: "line 42 misses the null case" not "needs more error handling"
7. Distinguish blocking issues from suggestions`,
  };

  for (const [name, content] of Object.entries(defaults)) {
    const path = join(dir, `${name}.md`);
    if (!existsSync(path)) {
      try { require('node:fs').writeFileSync(path, content); } catch { /* ignore */ }
    }
  }
}
