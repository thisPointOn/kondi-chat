/**
 * Context Receipts — structured per-turn summaries that persist
 * across turns and sessions.
 *
 * After every turn, a receipt records what changed, why, which files
 * were touched, and what comes next. The last N receipts are injected
 * into the system prompt so the model has cross-turn continuity
 * without re-reading the entire conversation history.
 *
 * Receipts are cheap: no LLM call needed. They're assembled from
 * data already available in the turn (tool calls, model responses,
 * ledger entries). Storage is a simple JSONL file under the session.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface TurnReceipt {
  turnNumber: number;
  timestamp: string;
  userGoal: string;
  modelUsed: string;
  filesRead: string[];
  filesWritten: string[];
  toolsCalled: string[];
  outcome: string;
  remainingWork?: string;
}

export class ReceiptStore {
  private path: string;

  constructor(storageDir: string, sessionId: string) {
    const dir = join(storageDir, 'sessions');
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${sessionId}-receipts.jsonl`);
  }

  /** Append a receipt after a turn completes. */
  record(receipt: TurnReceipt): void {
    appendFileSync(this.path, JSON.stringify(receipt) + '\n');
  }

  /** Get the last N receipts for injection into context. */
  getRecent(count = 3): TurnReceipt[] {
    if (!existsSync(this.path)) return [];
    try {
      const lines = readFileSync(this.path, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-count).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  /** Format receipts for injection into the system prompt. */
  formatForContext(count = 3): string {
    const receipts = this.getRecent(count);
    if (receipts.length === 0) return '';

    const lines = ['## Recent turns'];
    for (const r of receipts) {
      lines.push(`Turn ${r.turnNumber}: ${r.userGoal.slice(0, 100)}`);
      if (r.filesWritten.length > 0) lines.push(`  wrote: ${r.filesWritten.join(', ')}`);
      if (r.filesRead.length > 0) lines.push(`  read: ${r.filesRead.join(', ')}`);
      lines.push(`  outcome: ${r.outcome.slice(0, 200)}`);
      if (r.remainingWork) lines.push(`  remaining: ${r.remainingWork}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}

/**
 * Build a receipt from turn data. Called at the end of handleSubmit
 * with whatever data is available — no LLM call needed.
 */
export function buildReceipt(
  turnNumber: number,
  userGoal: string,
  modelUsed: string,
  toolCalls: Array<{ name: string; args: string; is_error: boolean }>,
  finalContent: string,
): TurnReceipt {
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  const toolsCalled: string[] = [];

  for (const tc of toolCalls) {
    toolsCalled.push(tc.name);
    if (tc.name === 'read_file') filesRead.push(tc.args);
    if (tc.name === 'write_file' || tc.name === 'edit_file') filesWritten.push(tc.args);
  }

  // Extract a short outcome from the final content.
  const outcomeLines = finalContent.split('\n').filter(l => l.trim().length > 0);
  const outcome = outcomeLines.slice(0, 3).join(' ').slice(0, 300);

  return {
    turnNumber,
    timestamp: new Date().toISOString(),
    userGoal: userGoal.slice(0, 200),
    modelUsed,
    filesRead: [...new Set(filesRead)],
    filesWritten: [...new Set(filesWritten)],
    toolsCalled: [...new Set(toolsCalled)],
    outcome,
  };
}
