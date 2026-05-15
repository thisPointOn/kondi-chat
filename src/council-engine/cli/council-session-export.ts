/**
 * CLI Council Session Export
 *
 * Exports a standalone council session for GUI import.
 * Parallel to session-export.ts but council-focused (no pipeline wrapper).
 *
 * Output: ~/.local/share/kondi/sessions/council-<councilId>-<timestamp>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SESSIONS_DIR = path.join(os.homedir(), '.local', 'share', 'kondi', 'sessions');

/** localStorage key conventions — must match store modules */
const KEYS = {
  councils: 'mcp-councils',
  ledgerIndex: (id: string) => `ledger-index-${id}`,
  ledgerChunk: (id: string, n: number) => `ledger-chunk-${id}-${n}`,
  context: (id: string) => `context-${id}`,
  contextHistory: (id: string) => `context-history-${id}`,
  contextPatches: (id: string) => `context-patches-${id}`,
  decision: (id: string) => `decision-${id}`,
  plan: (id: string) => `plan-${id}`,
  directive: (id: string) => `directive-${id}`,
  outputs: (id: string) => `outputs-${id}`,
};

interface CouncilExecutionInfo {
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  workingDirectory?: string;
}

/**
 * Export a standalone council session to a JSON file.
 * Reads all council data from the file-backed localStorage shim.
 */
export function exportCouncilSession(
  councilId: string,
  storage: Storage,
  execution: CouncilExecutionInfo,
): string | null {
  try {
    // Load council from store
    const councilsRaw = storage.getItem(KEYS.councils);
    const councilsData = councilsRaw ? JSON.parse(councilsRaw) : { councils: [] };
    const allCouncils = councilsData.councils || [];
    const council = allCouncils.find((c: any) => c.id === councilId);
    if (!council) {
      console.error('[CouncilSessionExport] Council not found:', councilId);
      return null;
    }

    // Collect ledger data
    const ledgerIndexRaw = storage.getItem(KEYS.ledgerIndex(councilId));
    const ledgerIndex = ledgerIndexRaw ? JSON.parse(ledgerIndexRaw) : null;

    const ledgerChunks: Record<number, any[]> = {};
    if (ledgerIndex) {
      const chunkCount = ledgerIndex.chunkCount ?? 0;
      for (let n = 0; n <= chunkCount; n++) {
        const chunkRaw = storage.getItem(KEYS.ledgerChunk(councilId, n));
        if (chunkRaw) {
          ledgerChunks[n] = JSON.parse(chunkRaw);
        }
      }
    }

    // Collect context artifacts
    const contextRaw = storage.getItem(KEYS.context(councilId));
    const contextHistoryRaw = storage.getItem(KEYS.contextHistory(councilId));
    const contextPatchesRaw = storage.getItem(KEYS.contextPatches(councilId));
    const decisionRaw = storage.getItem(KEYS.decision(councilId));
    const planRaw = storage.getItem(KEYS.plan(councilId));
    const directiveRaw = storage.getItem(KEYS.directive(councilId));
    const outputsRaw = storage.getItem(KEYS.outputs(councilId));

    const councilData = {
      ledgerIndex,
      ledgerChunks,
      context: contextRaw ? JSON.parse(contextRaw) : null,
      contextHistory: contextHistoryRaw ? JSON.parse(contextHistoryRaw) : [],
      contextPatches: contextPatchesRaw ? JSON.parse(contextPatchesRaw) : [],
      decision: decisionRaw ? JSON.parse(decisionRaw) : null,
      plan: planRaw ? JSON.parse(planRaw) : null,
      directive: directiveRaw ? JSON.parse(directiveRaw) : null,
      outputs: outputsRaw ? JSON.parse(outputsRaw) : [],
    };

    // Build session
    const session = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'cli-council',
      council,
      councilData: { [councilId]: councilData },
      execution,
    };

    // Write to sessions directory
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `council-${councilId}-${timestamp}.json`;
    const filePath = path.join(SESSIONS_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');

    return filePath;
  } catch (err) {
    console.error('[CouncilSessionExport] Failed to export session:', err);
    return null;
  }
}
