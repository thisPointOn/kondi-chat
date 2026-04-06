/**
 * Context Budget — assembles prompt context within a token budget.
 *
 * Fills from highest priority sections down. When budget is exceeded,
 * compressible sections are marked for summarization and lower-priority
 * sections are dropped entirely.
 */

import type { ContextSection } from '../types.ts';

/** Rough token estimate: ~4 chars per token for English text */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextBudget {
  private sections: ContextSection[] = [];
  private budget: number;
  private dropped: string[] = [];
  private compressed: string[] = [];

  constructor(tokenBudget: number) {
    this.budget = tokenBudget;
  }

  /** Add a section to the context assembly */
  add(key: string, content: string, priority: number, compressible = true): void {
    if (!content || content.trim().length === 0) return;
    this.sections.push({
      key,
      content,
      priority,
      compressible,
      tokenEstimate: estimateTokens(content),
    });
  }

  /**
   * Assemble context within the token budget.
   *
   * Strategy:
   * 1. Sort by priority (1 = highest, included first)
   * 2. Include sections while under budget
   * 3. When budget is tight, truncate compressible sections
   * 4. Drop sections that don't fit at all
   *
   * Returns the assembled context string.
   */
  assemble(): string {
    this.dropped = [];
    this.compressed = [];

    // Sort by priority ascending (1 first)
    const sorted = [...this.sections].sort((a, b) => a.priority - b.priority);

    const included: ContextSection[] = [];
    let usedTokens = 0;

    for (const section of sorted) {
      const remaining = this.budget - usedTokens;

      if (section.tokenEstimate <= remaining) {
        // Fits fully
        included.push(section);
        usedTokens += section.tokenEstimate;
      } else if (section.compressible && remaining > 200) {
        // Partially fits — truncate to remaining budget
        const charLimit = remaining * 4;
        const truncated = section.content.slice(0, charLimit) + '\n\n[... truncated ...]';
        included.push({
          ...section,
          content: truncated,
          tokenEstimate: estimateTokens(truncated),
        });
        usedTokens += estimateTokens(truncated);
        this.compressed.push(section.key);
      } else {
        // Doesn't fit
        this.dropped.push(section.key);
      }
    }

    return included.map(s => s.content).join('\n\n---\n\n');
  }

  /** Sections that were dropped due to budget */
  getDropped(): string[] {
    return this.dropped;
  }

  /** Sections that were truncated to fit */
  getCompressed(): string[] {
    return this.compressed;
  }

  /** Total estimated tokens of all sections before budget enforcement */
  getTotalEstimate(): number {
    return this.sections.reduce((sum, s) => sum + s.tokenEstimate, 0);
  }
}
