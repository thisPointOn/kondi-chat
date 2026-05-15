/**
 * Council: Ledger Store
 * Append-only, chunked storage for deliberation audit trail
 *
 * Storage layout:
 * - ledger-index-{councilId}: LedgerIndex (entry count, chunk boundaries, total tokens)
 * - ledger-chunk-{councilId}-{n}: LedgerEntry[] (chunk of entries)
 */

import type { LedgerEntry, LedgerEntryType, LedgerIndex, DeliberationPhase } from './types';
import { councilDataStore } from './storage-cleanup';

const LEDGER_INDEX_PREFIX = 'ledger-index-';
const LEDGER_CHUNK_PREFIX = 'ledger-chunk-';
const ENTRIES_PER_CHUNK = 20;

// ============================================================================
// Ledger Index Operations
// ============================================================================

function getLedgerIndexKey(councilId: string): string {
  return `${LEDGER_INDEX_PREFIX}${councilId}`;
}

function getLedgerChunkKey(councilId: string, chunkIndex: number): string {
  return `${LEDGER_CHUNK_PREFIX}${councilId}-${chunkIndex}`;
}

function loadLedgerIndex(councilId: string): LedgerIndex {
  try {
    const key = getLedgerIndexKey(councilId);
    const raw = councilDataStore.getItem(key);
    if (!raw) {
      return createEmptyIndex(councilId);
    }
    return JSON.parse(raw) as LedgerIndex;
  } catch (error) {
    console.error('[LedgerStore] Failed to load index:', error);
    return createEmptyIndex(councilId);
  }
}

function saveLedgerIndex(index: LedgerIndex): void {
  const key = getLedgerIndexKey(index.councilId);
  index.lastUpdated = new Date().toISOString();
  councilDataStore.setItem(key, JSON.stringify(index));
}

function createEmptyIndex(councilId: string): LedgerIndex {
  return {
    councilId,
    entryCount: 0,
    chunkCount: 0,
    chunkBoundaries: [],
    totalTokens: 0,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// Chunk Operations
// ============================================================================

function loadChunk(councilId: string, chunkIndex: number): LedgerEntry[] {
  try {
    const key = getLedgerChunkKey(councilId, chunkIndex);
    const raw = councilDataStore.getItem(key);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as LedgerEntry[];
  } catch (error) {
    console.error('[LedgerStore] Failed to load chunk:', chunkIndex, error);
    return [];
  }
}

function saveChunk(councilId: string, chunkIndex: number, entries: LedgerEntry[]): void {
  const key = getLedgerChunkKey(councilId, chunkIndex);
  const data = JSON.stringify(entries);
  councilDataStore.setItem(key, data);
}

function deleteChunk(councilId: string, chunkIndex: number): void {
  try {
    const key = getLedgerChunkKey(councilId, chunkIndex);
    councilDataStore.removeItem(key);
  } catch (error) {
    console.error('[LedgerStore] Failed to delete chunk:', chunkIndex, error);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Append a new entry to the ledger (append-only)
 */
export function appendEntry(councilId: string, entry: LedgerEntry): void {
  const index = loadLedgerIndex(councilId);

  // Determine which chunk to write to
  let currentChunkIndex = index.chunkCount > 0 ? index.chunkCount - 1 : 0;
  let chunk = loadChunk(councilId, currentChunkIndex);

  // Check if we need a new chunk
  if (chunk.length >= ENTRIES_PER_CHUNK) {
    currentChunkIndex++;
    index.chunkBoundaries.push(index.entryCount);
    chunk = [];
  }

  // Append entry
  chunk.push(entry);
  saveChunk(councilId, currentChunkIndex, chunk);

  // Update index
  index.entryCount++;
  index.chunkCount = currentChunkIndex + 1;
  index.totalTokens += entry.tokensUsed ?? 0;
  saveLedgerIndex(index);

  console.log('[LedgerStore] Appended entry:', entry.id, 'type:', entry.entryType);
}

/**
 * Get entries with optional filtering
 */
export function getEntries(
  councilId: string,
  options?: {
    types?: LedgerEntryType[];
    phase?: DeliberationPhase;
    round?: number;
    authorPersonaId?: string;
    limit?: number;
    offset?: number;
  }
): LedgerEntry[] {
  const index = loadLedgerIndex(councilId);

  if (index.entryCount === 0) {
    return [];
  }

  // Load all entries
  let allEntries: LedgerEntry[] = [];
  for (let i = 0; i < index.chunkCount; i++) {
    const chunk = loadChunk(councilId, i);
    allEntries = allEntries.concat(chunk);
  }

  // Apply filters
  let filtered = allEntries;

  if (options?.types && options.types.length > 0) {
    filtered = filtered.filter((e) => options.types!.includes(e.entryType));
  }

  if (options?.phase) {
    filtered = filtered.filter((e) => e.phase === options.phase);
  }

  if (options?.round !== undefined) {
    filtered = filtered.filter((e) => e.roundNumber === options.round);
  }

  if (options?.authorPersonaId) {
    filtered = filtered.filter((e) => e.authorPersonaId === options.authorPersonaId);
  }

  // Apply offset and limit
  if (options?.offset) {
    filtered = filtered.slice(options.offset);
  }

  if (options?.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

/**
 * Get all entries (no filtering)
 */
export function getAllEntries(councilId: string): LedgerEntry[] {
  return getEntries(councilId);
}

/**
 * Get a single entry by ID
 */
export function getEntry(councilId: string, entryId: string): LedgerEntry | null {
  const entries = getEntries(councilId);
  return entries.find((e) => e.id === entryId) ?? null;
}

/**
 * Get the most recent entry of a specific type
 */
export function getLatestOfType(councilId: string, type: LedgerEntryType): LedgerEntry | null {
  const entries = getEntries(councilId, { types: [type] });
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * Get entries for a specific round
 */
export function getEntriesForRound(councilId: string, round: number): LedgerEntry[] {
  return getEntries(councilId, { round });
}

/**
 * Get entries by author
 */
export function getEntriesByAuthor(councilId: string, authorPersonaId: string): LedgerEntry[] {
  return getEntries(councilId, { authorPersonaId });
}

/**
 * Get the total token count for the ledger
 */
export function getLedgerTokenCount(councilId: string): number {
  const index = loadLedgerIndex(councilId);
  return index.totalTokens;
}

/**
 * Get the entry count for the ledger
 */
export function getLedgerEntryCount(councilId: string): number {
  const index = loadLedgerIndex(councilId);
  return index.entryCount;
}

/**
 * Get the ledger index
 */
export function getLedgerIndex(councilId: string): LedgerIndex {
  return loadLedgerIndex(councilId);
}

/**
 * Get entries for recent rounds (for context building)
 * Returns entries from the most recent N rounds
 */
export function getRecentRoundEntries(councilId: string, numRounds: number): LedgerEntry[] {
  const allEntries = getEntries(councilId);

  // Find all unique round numbers
  const rounds = new Set<number>();
  for (const entry of allEntries) {
    if (entry.roundNumber !== undefined) {
      rounds.add(entry.roundNumber);
    }
  }

  // Get the most recent N rounds
  const sortedRounds = Array.from(rounds).sort((a, b) => b - a);
  const recentRounds = sortedRounds.slice(0, numRounds);

  // Filter entries to only include recent rounds
  return allEntries.filter(
    (e) => e.roundNumber !== undefined && recentRounds.includes(e.roundNumber)
  );
}

/**
 * Get manager notes (questions and redirects) - these are never summarized
 */
export function getManagerNotes(councilId: string, beforeRound?: number): LedgerEntry[] {
  const entries = getEntries(councilId, {
    types: ['manager_question', 'manager_redirect'],
  });

  if (beforeRound !== undefined) {
    return entries.filter((e) => (e.roundNumber ?? 0) < beforeRound);
  }

  return entries;
}

/**
 * Clear all entries for a council (use with caution - violates append-only principle)
 * Only for testing or explicit user request
 */
export function clearLedger(councilId: string): void {
  const index = loadLedgerIndex(councilId);

  // Delete all chunks
  for (let i = 0; i < index.chunkCount; i++) {
    deleteChunk(councilId, i);
  }

  // Reset index
  saveLedgerIndex(createEmptyIndex(councilId));

  console.log('[LedgerStore] Cleared ledger for council:', councilId);
}

/**
 * Delete the entire ledger for a council
 */
export function deleteLedger(councilId: string): void {
  const index = loadLedgerIndex(councilId);

  // Delete all chunks
  for (let i = 0; i < index.chunkCount; i++) {
    deleteChunk(councilId, i);
  }

  // Delete index
  try {
    const key = getLedgerIndexKey(councilId);
    councilDataStore.removeItem(key);
  } catch (error) {
    console.error('[LedgerStore] Failed to delete index:', error);
  }

  console.log('[LedgerStore] Deleted ledger for council:', councilId);
}

/**
 * Check if a ledger exists for a council
 */
export function ledgerExists(councilId: string): boolean {
  const key = getLedgerIndexKey(councilId);
  return councilDataStore.getItem(key) !== null;
}

/**
 * Get paginated entries (for UI)
 */
export function getPaginatedEntries(
  councilId: string,
  page: number,
  pageSize: number = 20
): { entries: LedgerEntry[]; total: number; hasMore: boolean } {
  const index = loadLedgerIndex(councilId);
  const offset = page * pageSize;
  const entries = getEntries(councilId, { offset, limit: pageSize });

  return {
    entries,
    total: index.entryCount,
    hasMore: offset + entries.length < index.entryCount,
  };
}

/**
 * Format entries for context building
 */
export function formatEntriesForContext(entries: LedgerEntry[]): string {
  return entries
    .map((e) => {
      const roundLabel = e.roundNumber !== undefined ? `, Round ${e.roundNumber}` : '';
      return `[${e.authorPersonaId}${roundLabel}, ${e.entryType}]:\n${e.content}`;
    })
    .join('\n\n');
}

/**
 * Build mechanical summary (no API call)
 */
export function buildMechanicalSummary(entries: LedgerEntry[]): string {
  return entries
    .filter((e) => ['analysis', 'response', 'proposal'].includes(e.entryType))
    .map((e) => {
      const sentences = e.content.split(/[.!?]\s/);
      const firstTwo = sentences.slice(0, 2).join('. ') + '.';
      return `${e.authorPersonaId} (${e.entryType}): ${firstTwo}`;
    })
    .join('\n\n');
}

// ============================================================================
// Ledger Store Class (for React integration)
// ============================================================================

export class LedgerStore {
  private listeners: Map<string, Set<() => void>> = new Map();

  subscribe(councilId: string, listener: () => void): () => void {
    if (!this.listeners.has(councilId)) {
      this.listeners.set(councilId, new Set());
    }
    this.listeners.get(councilId)!.add(listener);
    return () => this.listeners.get(councilId)?.delete(listener);
  }

  private notify(councilId: string): void {
    this.listeners.get(councilId)?.forEach((listener) => listener());
  }

  append(councilId: string, entry: LedgerEntry): void {
    appendEntry(councilId, entry);
    this.notify(councilId);
  }

  getAll(councilId: string): LedgerEntry[] {
    return getAllEntries(councilId);
  }

  get(councilId: string, entryId: string): LedgerEntry | null {
    return getEntry(councilId, entryId);
  }

  getByType(councilId: string, type: LedgerEntryType): LedgerEntry[] {
    return getEntries(councilId, { types: [type] });
  }

  getByRound(councilId: string, round: number): LedgerEntry[] {
    return getEntriesForRound(councilId, round);
  }

  getLatest(councilId: string, type: LedgerEntryType): LedgerEntry | null {
    return getLatestOfType(councilId, type);
  }

  getTokenCount(councilId: string): number {
    return getLedgerTokenCount(councilId);
  }

  clear(councilId: string): void {
    clearLedger(councilId);
    this.notify(councilId);
  }

  delete(councilId: string): void {
    deleteLedger(councilId);
    this.listeners.delete(councilId);
  }
}

// Singleton instance for app-wide use
export const ledgerStore = new LedgerStore();
