/**
 * CLI ↔ GUI Session Import
 *
 * Discovers CLI session files from ~/.local/share/kondi/sessions/
 * and imports them into the data store.
 *
 * Node.js implementation (no Tauri dependency).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { KondiSession, Pipeline } from './types';
import { pipelineStore } from './store';
import { councilDataStore } from '../council/storage-cleanup';

export interface CliSessionSummary {
  filePath: string;
  fileName: string;
  pipelineId: string;
  pipelineName: string;
  status: 'completed' | 'failed';
  exportedAt: string;
  durationMs: number;
  councilCount: number;
  stageCount: number;
  alreadyImported: boolean;
}

const SESSIONS_REL_PATH = '.local/share/kondi/sessions';

/**
 * Discover CLI session files available for import.
 */
export async function discoverCliSessions(): Promise<CliSessionSummary[]> {
  try {
    const sessionsDir = join(homedir(), SESSIONS_REL_PATH);

    if (!existsSync(sessionsDir)) return [];

    const entries = readdirSync(sessionsDir);
    const jsonFiles = entries
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fullPath = join(sessionsDir, f);
        const stat = statSync(fullPath);
        return { name: f, path: fullPath, modified: stat.mtime };
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    const summaries: CliSessionSummary[] = [];
    const existingPipelines = pipelineStore.getAll();

    for (const file of jsonFiles) {
      try {
        const content = readFileSync(file.path, 'utf-8');
        const session: KondiSession = JSON.parse(content);

        if (session.version !== 1 || !session.pipeline) continue;

        const alreadyImported = existingPipelines.some(
          p => p.id === session.pipeline.id && p.source === 'cli'
        );

        summaries.push({
          filePath: file.path,
          fileName: file.name,
          pipelineId: session.pipeline.id,
          pipelineName: session.pipeline.name,
          status: session.execution.status,
          exportedAt: session.exportedAt,
          durationMs: session.execution.durationMs,
          councilCount: Object.keys(session.councilData).length,
          stageCount: session.pipeline.stages.length,
          alreadyImported,
        });
      } catch {
        continue;
      }
    }

    return summaries;
  } catch (err) {
    console.error('[SessionImport] Failed to discover sessions:', err);
    return [];
  }
}

/**
 * Import a CLI session into the in-memory data store.
 * Merges the pipeline, councils, and all deliberation data.
 */
export async function importCliSession(filePath: string): Promise<string> {
  const content = readFileSync(filePath, 'utf-8');
  const session: KondiSession = JSON.parse(content);

  if (session.version !== 1) {
    throw new Error(`Unsupported session version: ${session.version}`);
  }

  // 1. Import pipeline
  const pipeline = {
    ...session.pipeline,
    source: 'cli' as const,
    status: session.execution.status as Pipeline['status'],
  };
  const existingPipelines = pipelineStore.getAll();
  const existing = existingPipelines.find(p => p.id === pipeline.id);

  if (existing) {
    pipelineStore.update(pipeline.id, pipeline);
  } else {
    const raw = councilDataStore.getItem('mcp-pipelines');
    const data = raw
      ? JSON.parse(raw)
      : { version: 2, pipelines: [], lastUpdated: '' };
    data.pipelines.push(pipeline);
    data.lastUpdated = new Date().toISOString();
    councilDataStore.setItem('mcp-pipelines', JSON.stringify(data));
  }

  // 2. Import councils
  if (session.councils.length > 0) {
    const raw = councilDataStore.getItem('mcp-councils');
    const data = raw
      ? JSON.parse(raw)
      : { version: 2, councils: [], lastUpdated: '' };

    for (const council of session.councils) {
      const idx = data.councils.findIndex((c: any) => c.id === council.id);
      if (idx >= 0) {
        data.councils[idx] = council;
      } else {
        data.councils.push(council);
      }
    }

    data.lastUpdated = new Date().toISOString();
    councilDataStore.setItem('mcp-councils', JSON.stringify(data));
  }

  // 3. Import council data (ledger, context, decisions, etc.)
  for (const [councilId, cdata] of Object.entries(session.councilData)) {
    if (cdata.ledgerIndex) {
      councilDataStore.setItem(`ledger-index-${councilId}`, JSON.stringify(cdata.ledgerIndex));
    }
    for (const [n, chunk] of Object.entries(cdata.ledgerChunks)) {
      councilDataStore.setItem(`ledger-chunk-${councilId}-${n}`, JSON.stringify(chunk));
    }
    if (cdata.context) {
      councilDataStore.setItem(`context-${councilId}`, JSON.stringify(cdata.context));
    }
    if (cdata.contextHistory.length > 0) {
      councilDataStore.setItem(`context-history-${councilId}`, JSON.stringify(cdata.contextHistory));
    }
    if (cdata.contextPatches.length > 0) {
      councilDataStore.setItem(`context-patches-${councilId}`, JSON.stringify(cdata.contextPatches));
    }
    if (cdata.decision) {
      councilDataStore.setItem(`decision-${councilId}`, JSON.stringify(cdata.decision));
    }
    if (cdata.plan) {
      councilDataStore.setItem(`plan-${councilId}`, JSON.stringify(cdata.plan));
    }
    if (cdata.directive) {
      councilDataStore.setItem(`directive-${councilId}`, JSON.stringify(cdata.directive));
    }
    if (cdata.outputs.length > 0) {
      councilDataStore.setItem(`outputs-${councilId}`, JSON.stringify(cdata.outputs));
    }
  }

  // 4. Trigger store notification so consumers refresh
  pipelineStore.update(pipeline.id, { updatedAt: new Date().toISOString() });

  return pipeline.id;
}
