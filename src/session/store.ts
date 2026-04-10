/**
 * Session persistence — save/load sessions under `.kondi-chat/sessions/`.
 *
 * Single SessionStore. Two constants (AUTO_SAVE_MS, MAX_AGE_DAYS). Atomic
 * writes via temp+rename. The ledger files stay flat in storageDir as they
 * are today — see specs/06-session-resume/SPEC.md for the rationale.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Session } from '../types.ts';

export const AUTO_SAVE_MS = 30_000;
export const MAX_AGE_DAYS = 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface PersistedSession {
  version: 1;
  session: Session;
  activeProfile: string;
  overrideModel?: string;
  lastSavedAt: string;
  workingDirectory: string;
}

export interface SessionIndexEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  messageCount: number;
  totalCostUsd: number;
  activeModel?: string;
  profile: string;
  summary: string;
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  try { renameSync(tmp, path); } catch { writeFileSync(path, data); }
}

export class SessionStore {
  private sessionsDir: string;
  private indexPath: string;
  private activePath: string;
  private index: SessionIndexEntry[];

  constructor(storageDir: string) {
    this.sessionsDir = join(storageDir, 'sessions');
    this.indexPath = join(this.sessionsDir, 'index.json');
    this.activePath = join(this.sessionsDir, 'active.json');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.index = this.loadIndex();
  }

  save(session: Session, profile: string, overrideModel?: string): void {
    const persisted: PersistedSession = {
      version: 1,
      session,
      activeProfile: profile,
      overrideModel,
      lastSavedAt: new Date().toISOString(),
      workingDirectory: session.workingDirectory || '',
    };
    atomicWrite(
      join(this.sessionsDir, `${session.id}.json`),
      JSON.stringify(persisted, null, 2),
    );
    this.updateIndex({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      workingDirectory: session.workingDirectory || '',
      messageCount: session.messages.length,
      totalCostUsd: session.totalCostUsd,
      activeModel: session.activeModel,
      profile,
      summary: this.computeSummary(session),
    });
  }

  load(idOrPrefix: string): PersistedSession | null {
    const id = this.resolveId(idOrPrefix);
    if (!id) return null;
    const file = join(this.sessionsDir, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as PersistedSession;
    } catch {
      return null;
    }
  }

  loadLatest(workingDirectory?: string): PersistedSession | null {
    const entries = this.list(workingDirectory);
    if (entries.length === 0) return null;
    return this.load(entries[0].id);
  }

  list(workingDirectory?: string): SessionIndexEntry[] {
    const entries = workingDirectory
      ? this.index.filter(e => e.workingDirectory === workingDirectory)
      : [...this.index];
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(id: string): void {
    const resolved = this.resolveId(id) || id;
    const file = join(this.sessionsDir, `${resolved}.json`);
    if (existsSync(file)) { try { unlinkSync(file); } catch { /* ignore */ } }
    this.index = this.index.filter(e => e.id !== resolved);
    this.saveIndex();
  }

  /** Delete sessions older than MAX_AGE_DAYS. Returns count removed. */
  cleanup(): { deleted: number } {
    const cutoff = Date.now() - MAX_AGE_MS;
    let deleted = 0;
    for (const entry of [...this.index]) {
      const updated = new Date(entry.updatedAt).getTime();
      if (!isFinite(updated) || updated < cutoff) {
        this.delete(entry.id);
        deleted++;
      }
    }
    return { deleted };
  }

  setActive(id: string): void {
    atomicWrite(this.activePath, JSON.stringify({ id }));
  }

  getActive(): string | null {
    if (!existsSync(this.activePath)) return null;
    try { return JSON.parse(readFileSync(this.activePath, 'utf-8')).id || null; }
    catch { return null; }
  }

  format(workingDirectory?: string): string {
    const entries = this.list(workingDirectory);
    if (entries.length === 0) return 'No sessions yet.';
    const lines = ['Sessions (newest first):'];
    for (const e of entries.slice(0, 20)) {
      lines.push(
        `  ${e.id.slice(0, 8)}  ${e.updatedAt.slice(0, 19)}  ${e.messageCount}msg  $${e.totalCostUsd.toFixed(4)}`
        + (e.summary ? `\n    ${e.summary}` : ''),
      );
    }
    if (entries.length > 20) lines.push(`  ... and ${entries.length - 20} more`);
    return lines.join('\n');
  }

  /** Match by exact id, or ≥8-char prefix when unambiguous. */
  private resolveId(idOrPrefix: string): string | null {
    if (this.index.some(e => e.id === idOrPrefix)) return idOrPrefix;
    if (idOrPrefix.length < 8) return null;
    const matches = this.index.filter(e => e.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0].id : null;
  }

  private updateIndex(entry: SessionIndexEntry): void {
    const existing = this.index.findIndex(e => e.id === entry.id);
    if (existing >= 0) this.index[existing] = entry;
    else this.index.push(entry);
    this.saveIndex();
  }

  private loadIndex(): SessionIndexEntry[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf-8'));
      return Array.isArray(raw?.sessions) ? raw.sessions : [];
    } catch { return []; }
  }

  private saveIndex(): void {
    atomicWrite(this.indexPath, JSON.stringify({ sessions: this.index }, null, 2));
  }

  /** Spec 13 — save in-progress assistant content so a crash leaves a recoverable trail. */
  savePartialMessage(sessionId: string, content: string): void {
    const dir = join(this.sessionsDir, '..', 'recovery');
    const path = join(dir, `${sessionId}-partial.json`);
    atomicWrite(path, JSON.stringify({ sessionId, content, savedAt: new Date().toISOString() }));
  }

  /** Spec 13 — read any partial from a prior run; null if none. */
  checkForRecovery(sessionId: string): { content: string; savedAt: string } | null {
    const path = join(this.sessionsDir, '..', 'recovery', `${sessionId}-partial.json`);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
  }

  /** Delete the partial file once the session has integrated it. */
  clearRecovery(sessionId: string): void {
    const path = join(this.sessionsDir, '..', 'recovery', `${sessionId}-partial.json`);
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* ignore */ } }
  }

  private computeSummary(session: Session): string {
    if (session.state.goal) return session.state.goal.slice(0, 120);
    const firstUser = session.messages.find(m => m.role === 'user');
    return firstUser ? firstUser.content.slice(0, 120) : '';
  }
}
