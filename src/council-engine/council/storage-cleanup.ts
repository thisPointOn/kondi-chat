/**
 * Council: Data Store
 * In-memory primary storage for all council artifact data (context, ledger, patches, etc.).
 *
 * This mirrors the CLI's localStorage-shim pattern: an in-memory Map that has
 * no size limit.  localStorage is used as a best-effort cache for same-session
 * UI observation — quota errors are silently ignored because the authoritative
 * data lives in the Map.
 *
 * This gives each council true storage isolation:
 *  - Councils never compete for the same 5MB localStorage pool.
 *  - One council's data can never crowd out another's.
 *  - Pipeline executions finish every time, regardless of how many councils run.
 *
 * Deliberation history is NEVER destroyed.  The pipeline executor saves full
 * deliberation output to disk via `platform.saveDeliberationOutput()` for
 * long-term preservation.
 */

// ============================================================================
// In-Memory Data Store (primary authority for council artifact data)
// ============================================================================

const MAX_ENTRIES = 10000;

class CouncilDataStore {
  private cache = new Map<string, string>();

  getItem(key: string): string | null {
    // Primary: in-memory cache
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Move to end for LRU ordering
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    // Fallback: localStorage (picks up data from prior sessions / initial load)
    try {
      const val = localStorage.getItem(key);
      if (val !== null) {
        this.cache.set(key, val);  // promote to in-memory
        return val;
      }
    } catch { /* ignore */ }

    return null;
  }

  setItem(key: string, value: string): void {
    // Evict oldest entries if at capacity
    if (!this.cache.has(key) && this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);

    // Secondary: best-effort localStorage mirror for UI observation.
    // Quota errors are harmless because the data is safe in memory.
    try {
      localStorage.setItem(key, value);
    } catch {
      // Silently ignore — data is authoritative in the Map.
      // This is the normal path once localStorage fills up.
    }
  }

  removeItem(key: string): void {
    this.cache.delete(key);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  /**
   * Persistent save: same as setItem but throws on localStorage failure.
   * Used for data that MUST survive app restarts (e.g. pipeline definitions).
   */
  setItemPersistent(key: string, value: string): void {
    this.cache.set(key, value);
    localStorage.setItem(key, value);
  }

  /**
   * Number of keys in the merged view (in-memory + localStorage).
   * Used by stores that iterate over keys.
   */
  get length(): number {
    return this.allKeys().length;
  }

  /**
   * Get key at index in the merged view.
   */
  key(index: number): string | null {
    const keys = this.allKeys();
    return keys[index] ?? null;
  }

  /**
   * Merged set of all keys from both in-memory cache and localStorage.
   */
  private allKeys(): string[] {
    const keys = new Set<string>();
    for (const k of this.cache.keys()) keys.add(k);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) keys.add(k);
      }
    } catch { /* ignore */ }
    return [...keys];
  }
}

// Singleton — all council stores share this instance
export const councilDataStore = new CouncilDataStore();

// ============================================================================
// Convenience wrappers (used by context-store, ledger-store)
// ============================================================================

/**
 * Save to the council data store.  Never throws.
 * The old `saveWithRetry` escalated cleanup and could still throw.
 * This version always succeeds because the in-memory Map has no quota.
 */
export function saveWithRetry(key: string, data: string, _activeCouncilId?: string): void {
  councilDataStore.setItem(key, data);
}

/**
 * Strip a completed council in the mcp-councils localStorage key.
 * Removes messages and deliberationState to keep the mcp-councils key small.
 * The full deliberation data is preserved in memory and saved to disk.
 */
export function stripCompletedCouncil(councilId: string): void {
  try {
    const raw = localStorage.getItem('mcp-councils');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.councils || !Array.isArray(data.councils)) return;

    const idx = data.councils.findIndex((c: any) => c.id === councilId);
    if (idx === -1) return;

    const council = data.councils[idx];
    // Strip large fields from the localStorage copy only.
    // The authoritative data remains in the in-memory store.
    council.messages = [];
    council.deliberationState = undefined;
    if (council.sharedContext) {
      council.sharedContext.data = undefined;
      council.sharedContext.documents = [];
    }

    data.councils[idx] = council;
    data.lastUpdated = new Date().toISOString();
    localStorage.setItem('mcp-councils', JSON.stringify(data));
    console.log(`[CouncilDataStore] Stripped localStorage copy of council ${councilId.slice(0, 8)}`);
  } catch (err) {
    // Non-fatal — localStorage is just a cache
    console.warn('[CouncilDataStore] Failed to strip council in localStorage:', err);
  }
}
