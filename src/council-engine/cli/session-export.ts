/**
 * CLI Session Export
 *
 * After a CLI pipeline run, exports a session file bundling the pipeline,
 * all referenced councils, and all deliberation artifacts. The GUI can
 * discover and import these files to make CLI results browsable.
 *
 * Output: ~/.local/share/kondi/sessions/<pipelineId>-<timestamp>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Pipeline } from '../pipeline/types';
import type { KondiSession, KondiSessionCouncilData } from '../pipeline/types';

const SESSIONS_DIR = path.join(os.homedir(), '.local', 'share', 'kondi', 'sessions');

/** localStorage key prefixes — must match the store modules exactly */
const KEYS = {
  pipelines: 'mcp-pipelines',
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

interface ExportExecutionInfo {
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  workingDirectory: string;
}

/**
 * Export a CLI pipeline session to a JSON file.
 *
 * Reads all relevant data from the file-backed localStorage shim
 * and writes a self-contained session file the GUI can import.
 */
export function exportSession(
  pipelineId: string,
  storage: Storage,
  execution: ExportExecutionInfo,
): string | null {
  try {
    // 1. Load pipeline from store
    const pipelinesRaw = storage.getItem(KEYS.pipelines);
    if (!pipelinesRaw) {
      console.error('[SessionExport] No pipelines found in storage');
      return null;
    }
    const pipelinesData = JSON.parse(pipelinesRaw);
    const pipelines: Pipeline[] = pipelinesData.pipelines || [];
    const pipeline = pipelines.find(p => p.id === pipelineId);
    if (!pipeline) {
      console.error('[SessionExport] Pipeline not found:', pipelineId);
      return null;
    }

    // 2. Collect council IDs from step artifacts
    const councilIds = new Set<string>();
    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        if (step.artifact?.metadata?.councilId) {
          councilIds.add(step.artifact.metadata.councilId);
        }
      }
    }

    // 3. Load councils
    const councilsRaw = storage.getItem(KEYS.councils);
    const councilsData = councilsRaw ? JSON.parse(councilsRaw) : { councils: [] };
    const allCouncils = councilsData.councils || [];
    const councils = allCouncils.filter((c: any) => councilIds.has(c.id));

    // 4. For each council, collect all associated localStorage keys
    const councilData: Record<string, KondiSessionCouncilData> = {};

    for (const councilId of councilIds) {
      // Ledger index
      const ledgerIndexRaw = storage.getItem(KEYS.ledgerIndex(councilId));
      const ledgerIndex = ledgerIndexRaw ? JSON.parse(ledgerIndexRaw) : null;

      // Ledger chunks — read until we get null
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

      // Context artifacts
      const contextRaw = storage.getItem(KEYS.context(councilId));
      const contextHistoryRaw = storage.getItem(KEYS.contextHistory(councilId));
      const contextPatchesRaw = storage.getItem(KEYS.contextPatches(councilId));
      const decisionRaw = storage.getItem(KEYS.decision(councilId));
      const planRaw = storage.getItem(KEYS.plan(councilId));
      const directiveRaw = storage.getItem(KEYS.directive(councilId));
      const outputsRaw = storage.getItem(KEYS.outputs(councilId));

      councilData[councilId] = {
        ledgerIndex: ledgerIndex,
        ledgerChunks,
        context: contextRaw ? JSON.parse(contextRaw) : null,
        contextHistory: contextHistoryRaw ? JSON.parse(contextHistoryRaw) : [],
        contextPatches: contextPatchesRaw ? JSON.parse(contextPatchesRaw) : [],
        decision: decisionRaw ? JSON.parse(decisionRaw) : null,
        plan: planRaw ? JSON.parse(planRaw) : null,
        directive: directiveRaw ? JSON.parse(directiveRaw) : null,
        outputs: outputsRaw ? JSON.parse(outputsRaw) : [],
      };
    }

    // 5. Build session object
    // Override pipeline.status with the definitive execution outcome —
    // the executor's store update and the export can race, so trust
    // the explicitly-passed execution status.
    const session: KondiSession = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'cli',
      pipeline: { ...pipeline, source: 'cli', status: execution.status },
      councils,
      councilData,
      execution,
    };

    // 6. Write to sessions directory
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${pipelineId}-${timestamp}.json`;
    const filePath = path.join(SESSIONS_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');

    console.log(`[SessionExport] Session exported to: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error('[SessionExport] Failed to export session:', err);
    return null;
  }
}
