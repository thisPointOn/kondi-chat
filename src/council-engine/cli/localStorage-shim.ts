/**
 * File-backed localStorage polyfill for CLI mode.
 * Must be imported BEFORE any store modules that use localStorage.
 *
 * Persists all state to a JSON file so execution data (councils, personas,
 * step artifacts, deliberation logs) survives after the CLI run finishes.
 *
 * Default location: ~/.local/share/kondi/cli-state/localStorage.json
 * Override with KONDI_CLI_STATE_DIR env var.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = process.env.KONDI_CLI_STATE_DIR
  || path.join(os.homedir(), '.local', 'share', 'kondi', 'cli-state');

const STATE_FILE = path.join(STATE_DIR, 'localStorage.json');

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadFromDisk(): Record<string, string> {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[localStorage-shim] Failed to load state file, starting fresh:', err);
  }
  return {};
}

function saveToDisk(data: Record<string, string>) {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[localStorage-shim] WARNING: Failed to save state file — data may be lost:', err);
  }
}

class FileBackedStorage implements Storage {
  private data: Record<string, string>;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    ensureDir();
    this.data = loadFromDisk();
  }

  get length(): number {
    return Object.keys(this.data).length;
  }

  key(index: number): string | null {
    return Object.keys(this.data)[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = String(value);
    this.scheduleSave();
  }

  removeItem(key: string): void {
    delete this.data[key];
    this.scheduleSave();
  }

  clear(): void {
    this.data = {};
    this.scheduleSave();
  }

  /** Debounced save — writes at most every 500ms to avoid thrashing disk */
  private scheduleSave(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
        this.flushTimer = null;
      }, 500);
    }
  }

  /** Force an immediate write to disk */
  flush(): void {
    if (this.dirty) {
      saveToDisk(this.data);
      this.dirty = false;
    }
  }

  /** Get all data (for export/reporting) */
  getAll(): Record<string, string> {
    return { ...this.data };
  }
}

// Install globally before any module reads localStorage
const storage = new FileBackedStorage();
(globalThis as any).localStorage = storage;

// Flush on process exit so nothing is lost
process.on('exit', () => storage.flush());
process.on('SIGINT', () => { storage.flush(); process.exit(130); });
process.on('SIGTERM', () => { storage.flush(); process.exit(143); });

export { storage };
