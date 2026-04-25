/**
 * Task Store — persists task cards to disk so they survive session
 * restarts. Active tasks are injected into context so the model
 * knows what it was working on.
 *
 * Storage:
 *   .kondi-chat/tasks/current.json — the active task (if any)
 *   .kondi-chat/tasks/history/     — completed tasks
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskCard } from '../types.ts';

export class TaskStore {
  private tasksDir: string;
  private currentPath: string;
  private historyDir: string;

  constructor(storageDir: string) {
    this.tasksDir = join(storageDir, 'tasks');
    this.currentPath = join(this.tasksDir, 'current.json');
    this.historyDir = join(this.tasksDir, 'history');
    mkdirSync(this.historyDir, { recursive: true });
  }

  /** Get the active task, if any. */
  getCurrent(): TaskCard | null {
    if (!existsSync(this.currentPath)) return null;
    try {
      return JSON.parse(readFileSync(this.currentPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Save or update the active task. */
  setCurrent(task: TaskCard): void {
    writeFileSync(this.currentPath, JSON.stringify(task, null, 2));
  }

  /** Move the active task to history (completed or abandoned). */
  complete(): void {
    const task = this.getCurrent();
    if (!task) return;
    const historyPath = join(this.historyDir, `${task.id}.json`);
    try {
      renameSync(this.currentPath, historyPath);
    } catch {
      // If rename fails, just delete current
      try { writeFileSync(this.currentPath, ''); } catch { /* ignore */ }
    }
  }

  /** Clear the active task without archiving. */
  clear(): void {
    if (existsSync(this.currentPath)) {
      try { writeFileSync(this.currentPath, ''); } catch { /* ignore */ }
    }
  }

  /** Format active task for injection into context. */
  formatForContext(): string {
    const task = this.getCurrent();
    if (!task) return '';
    const lines = [
      '## Active task',
      `Goal: ${task.goal}`,
      `Kind: ${task.kind}`,
      `Status: ${task.status}`,
    ];
    if (task.relevantFiles.length > 0) {
      lines.push(`Files: ${task.relevantFiles.join(', ')}`);
    }
    if (task.constraints.length > 0) {
      lines.push(`Constraints: ${task.constraints.join('; ')}`);
    }
    if (task.acceptanceCriteria.length > 0) {
      lines.push(`Acceptance: ${task.acceptanceCriteria.join('; ')}`);
    }
    if (task.failures > 0) {
      lines.push(`Failures: ${task.failures}`);
    }
    return lines.join('\n');
  }
}
