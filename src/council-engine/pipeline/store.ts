/**
 * Pipeline Store: Persistence & State Management
 * localStorage-backed CRUD with subscribe/notify pattern (follows councilStore)
 */

import type {
  Pipeline,
  PipelineStage,
  PipelineStep,
  PipelineStepStatus,
  PipelineStatus,
  StepConfig,
  StepArtifact,
  LlmStepConfig,
} from './types';
import { migrateLlmConfig } from './types';
import { councilDataStore } from '../council/storage-cleanup';
import { deleteCouncilWithData } from '../council/store';

const STORAGE_KEY = 'mcp-pipelines';

interface StorageData {
  version: number;
  pipelines: Pipeline[];
  lastUpdated: string;
}

// ============================================================================
// Storage Helpers
// ============================================================================

function migrateV1toV2(data: StorageData): StorageData {
  if (data.version >= 2) return data;

  console.log('[PipelineStore] Migrating v1 \u2192 v2: council\u2192planning, execution stays, gate stays');
  for (const pipeline of data.pipelines) {
    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        if ((step.config as { type: string }).type === 'council') {
          (step.config as { type: string }).type = 'planning';
        }
        // 'execution' and 'gate' stay unchanged
      }
    }
  }
  data.version = 2;
  return data;
}

/**
 * v2 → v3: Convert legacy LlmStepConfig (flat model/provider/systemPrompt)
 * to CouncilStepConfig (with councilSetup). All non-gate step types are now councils.
 */
function migrateV2toV3(data: StorageData): StorageData {
  if (data.version >= 3) return data;

  let migrated = 0;
  for (const pipeline of data.pipelines) {
    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        const config = step.config as any;
        // Detect legacy LlmStepConfig: has type decisioning/execution but no councilSetup
        if ((config.type === 'decisioning' || config.type === 'execution') && !config.councilSetup) {
          step.config = migrateLlmConfig(config as LlmStepConfig);
          migrated++;
        }
      }
    }
  }

  if (migrated > 0) {
    console.log(`[PipelineStore] Migrating v2 → v3: converted ${migrated} LLM step(s) to council format`);
  }
  data.version = 3;
  return data;
}

/**
 * v3 → v4: Rename step types to broader names.
 * planning→council, decisioning→analysis, execution→agent, review-docs→review, enrichment→enrich.
 */
function migrateV3toV4(data: StorageData): StorageData {
  if (data.version >= 4) return data;

  const typeMap: Record<string, string> = {
    planning: 'council',
    decisioning: 'analysis',
    execution: 'agent',
    'review-docs': 'review',
    enrichment: 'enrich',
  };

  let migrated = 0;
  for (const pipeline of data.pipelines) {
    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        const config = step.config as { type: string };
        const newType = typeMap[config.type];
        if (newType) {
          config.type = newType;
          migrated++;
        }
      }
    }
  }

  if (migrated > 0) {
    console.log(`[PipelineStore] Migrating v3 → v4: renamed ${migrated} step type(s)`);
  }
  data.version = 4;
  return data;
}

/**
 * v4 → v5: Rename 'council' → 'code_planning'.
 * The old 'council' type was specifically for code planning (PLAN_TOOLS, planning prompts).
 * Now 'council' is a new open-ended deliberation type, and old council steps become 'code_planning'.
 */
function migrateV4toV5(data: StorageData): StorageData {
  if (data.version >= 5) return data;

  let migrated = 0;
  for (const pipeline of data.pipelines) {
    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        const config = step.config as { type: string };
        if (config.type === 'council') {
          config.type = 'code_planning';
          migrated++;
        }
      }
    }
  }

  if (migrated > 0) {
    console.log(`[PipelineStore] Migrating v4 → v5: renamed ${migrated} 'council' step(s) to 'code_planning'`);
  }
  data.version = 5;
  return data;
}

function loadFromStorage(): StorageData {
  try {
    const raw = councilDataStore.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: 5, pipelines: [], lastUpdated: new Date().toISOString() };
    }
    let data = JSON.parse(raw) as StorageData;
    data = migrateV1toV2(data);
    data = migrateV2toV3(data);
    data = migrateV3toV4(data);
    data = migrateV4toV5(data);
    return data;
  } catch (error) {
    console.error('[PipelineStore] Failed to load from storage:', error);
    return { version: 5, pipelines: [], lastUpdated: new Date().toISOString() };
  }
}

/**
 * Reset any pipelines/steps that were left in a transient state (running, waiting)
 * from a previous session. Called once on startup.
 */
function resetStaleExecutionStates(): void {
  const data = loadFromStorage();
  let dirty = false;

  for (const pipeline of data.pipelines) {
    if (pipeline.status === 'running' || pipeline.status === 'paused') {
      pipeline.status = 'failed';
      dirty = true;
    }

    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        if (step.status === 'running' || step.status === 'waiting_approval') {
          step.status = 'failed';
          step.error = 'Interrupted: application was restarted';
          step.completedAt = new Date().toISOString();
          dirty = true;
        }
      }
    }
  }

  if (dirty) {
    saveToStorage(data);
    console.log('[PipelineStore] Reset stale running/waiting states from previous session');
  }
}

// Run once on module load
resetStaleExecutionStates();

function saveToStorage(data: StorageData): void {
  data.lastUpdated = new Date().toISOString();
  // Use persistent save — pipeline configs MUST survive app restarts
  councilDataStore.setItemPersistent(STORAGE_KEY, JSON.stringify(data));
}

// ============================================================================
// Pipeline CRUD
// ============================================================================

export function getAllPipelines(): Pipeline[] {
  const data = loadFromStorage();
  return data.pipelines.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function getPipeline(id: string): Pipeline | null {
  const data = loadFromStorage();
  return data.pipelines.find((p) => p.id === id) || null;
}

export function createPipeline(params: {
  name: string;
  description?: string;
  initialInput?: string;
  settings?: Partial<Pipeline['settings']>;
}): Pipeline {
  const now = new Date().toISOString();

  const pipeline: Pipeline = {
    id: crypto.randomUUID(),
    name: params.name,
    description: params.description,
    initialInput: params.initialInput || '',
    stages: [],
    settings: {
      workingDirectory: params.settings?.workingDirectory,
      failurePolicy: params.settings?.failurePolicy || 'stop',
      directoryConstrained: params.settings?.directoryConstrained ?? true,
    },
    status: 'draft',
    currentStageIndex: 0,
    createdAt: now,
    updatedAt: now,
  };

  const data = loadFromStorage();
  data.pipelines.push(pipeline);
  saveToStorage(data);

  console.log('[PipelineStore] Created pipeline:', pipeline.id, pipeline.name);
  return pipeline;
}

export function updatePipeline(
  id: string,
  updates: Partial<Omit<Pipeline, 'id' | 'createdAt'>>
): Pipeline | null {
  const data = loadFromStorage();
  const index = data.pipelines.findIndex((p) => p.id === id);

  if (index === -1) {
    console.warn('[PipelineStore] Pipeline not found:', id);
    return null;
  }

  const updated: Pipeline = {
    ...data.pipelines[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  data.pipelines[index] = updated;
  saveToStorage(data);

  return updated;
}

export function deletePipeline(id: string): boolean {
  const data = loadFromStorage();
  const index = data.pipelines.findIndex((p) => p.id === id);

  if (index === -1) return false;

  data.pipelines.splice(index, 1);
  saveToStorage(data);

  console.log('[PipelineStore] Deleted pipeline:', id);
  return true;
}

export function duplicatePipeline(id: string, newName?: string): Pipeline | null {
  const original = getPipeline(id);
  if (!original) return null;

  const now = new Date().toISOString();

  // Deep clone stages with new IDs
  const clonedStages: PipelineStage[] = original.stages.map((stage) => ({
    id: crypto.randomUUID(),
    name: stage.name,
    steps: stage.steps.map((step) => ({
      ...step,
      id: crypto.randomUUID(),
      status: 'pending' as const,
      artifact: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
  }));

  const duplicate: Pipeline = {
    ...original,
    id: crypto.randomUUID(),
    name: newName || `${original.name} (Copy)`,
    stages: clonedStages,
    status: 'draft',
    currentStageIndex: 0,
    createdAt: now,
    updatedAt: now,
  };

  const data = loadFromStorage();
  data.pipelines.push(duplicate);
  saveToStorage(data);

  return duplicate;
}

// ============================================================================
// Stage Operations
// ============================================================================

export function addStage(
  pipelineId: string,
  name?: string,
  atIndex?: number
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stage: PipelineStage = {
    id: crypto.randomUUID(),
    name: name || `Stage ${pipeline.stages.length + 1}`,
    steps: [],
  };

  const stages = [...pipeline.stages];
  if (atIndex !== undefined && atIndex >= 0 && atIndex <= stages.length) {
    stages.splice(atIndex, 0, stage);
  } else {
    stages.push(stage);
  }

  return updatePipeline(pipelineId, { stages });
}

export function removeStage(pipelineId: string, stageId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  return updatePipeline(pipelineId, {
    stages: pipeline.stages.filter((s) => s.id !== stageId),
  });
}

export function updateStage(
  pipelineId: string,
  stageId: string,
  updates: Partial<Omit<PipelineStage, 'id'>>
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((s) =>
    s.id === stageId ? { ...s, ...updates } : s
  );

  return updatePipeline(pipelineId, { stages });
}

export function reorderStages(
  pipelineId: string,
  stageIds: string[]
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stageMap = new Map(pipeline.stages.map((s) => [s.id, s]));
  const reordered = stageIds
    .map((id) => stageMap.get(id))
    .filter((s): s is PipelineStage => s !== undefined);

  if (reordered.length !== pipeline.stages.length) return null;

  return updatePipeline(pipelineId, { stages: reordered });
}

// ============================================================================
// Step Operations
// ============================================================================

export function addStep(
  pipelineId: string,
  stageId: string,
  config: StepConfig,
  name?: string
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const step: PipelineStep = {
    id: crypto.randomUUID(),
    name: name || `Step ${pipeline.stages.find((s) => s.id === stageId)?.steps.length || 0 + 1}`,
    config,
    status: 'pending',
  };

  const stages = pipeline.stages.map((s) =>
    s.id === stageId ? { ...s, steps: [...s.steps, step] } : s
  );

  return updatePipeline(pipelineId, { stages });
}

export function removeStep(
  pipelineId: string,
  stageId: string,
  stepId: string
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((s) =>
    s.id === stageId
      ? { ...s, steps: s.steps.filter((st) => st.id !== stepId) }
      : s
  );

  return updatePipeline(pipelineId, { stages });
}

export function updateStep(
  pipelineId: string,
  stepId: string,
  updates: Partial<Omit<PipelineStep, 'id'>>
): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  const stages = pipeline.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) =>
      step.id === stepId ? { ...step, ...updates } : step
    ),
  }));

  return updatePipeline(pipelineId, { stages });
}

export function updateStepConfig(
  pipelineId: string,
  stepId: string,
  config: StepConfig
): Pipeline | null {
  return updateStep(pipelineId, stepId, { config });
}

// ============================================================================
// Execution State Operations
// ============================================================================

export function setStepStatus(
  pipelineId: string,
  stepId: string,
  status: PipelineStepStatus,
  error?: string
): Pipeline | null {
  const updates: Partial<PipelineStep> = { status };
  if (status === 'running') {
    updates.startedAt = new Date().toISOString();
    // Clear previous error and completion when starting fresh
    updates.error = undefined;
    updates.completedAt = undefined;
  }
  if (status === 'completed' || status === 'failed') {
    updates.completedAt = new Date().toISOString();
  }
  if (error) {
    updates.error = error;
  }
  return updateStep(pipelineId, stepId, updates);
}

export function setStepArtifact(
  pipelineId: string,
  stepId: string,
  artifact: StepArtifact
): Pipeline | null {
  return updateStep(pipelineId, stepId, { artifact });
}

export function setPipelineStatus(
  pipelineId: string,
  status: PipelineStatus
): Pipeline | null {
  return updatePipeline(pipelineId, { status });
}

export function advanceStage(pipelineId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  return updatePipeline(pipelineId, {
    currentStageIndex: pipeline.currentStageIndex + 1,
  });
}

/**
 * Delete council deliberation data (ledger, context, decisions) for steps
 * that are about to be reset.  Without this, the UI shows stale entries
 * from the previous run mixed with the new one.
 */
function purgeCouncilsForSteps(steps: PipelineStep[]): void {
  for (const step of steps) {
    const councilId = step.artifact?.metadata?.councilId;
    if (councilId) {
      try {
        deleteCouncilWithData(councilId);
      } catch (err) {
        console.warn('[PipelineStore] Failed to delete council data:', councilId, err);
      }
    }
  }
}

export function resetExecution(pipelineId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  // Delete all council deliberation data before resetting steps
  const allSteps = pipeline.stages.flatMap((s) => s.steps);
  purgeCouncilsForSteps(allSteps);

  const stages = pipeline.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => ({
      ...step,
      status: 'pending' as const,
      artifact: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
  }));

  return updatePipeline(pipelineId, {
    stages,
    status: 'draft',
    currentStageIndex: 0,
  });
}

/**
 * Reset a specific step and all subsequent steps to pending.
 * Sets currentStageIndex to the target step's stage so the executor
 * resumes from the right point. Earlier completed steps are preserved.
 */
export function resetStepAndAfter(pipelineId: string, stepId: string): Pipeline | null {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return null;

  // Find the step's stage index and step index
  let targetStageIndex = -1;
  let targetStepIndex = -1;
  for (let si = 0; si < pipeline.stages.length; si++) {
    for (let sti = 0; sti < pipeline.stages[si].steps.length; sti++) {
      if (pipeline.stages[si].steps[sti].id === stepId) {
        targetStageIndex = si;
        targetStepIndex = sti;
        break;
      }
    }
    if (targetStageIndex >= 0) break;
  }
  if (targetStageIndex < 0) return null;

  // Delete council deliberation data for steps being reset
  const stepsToReset: PipelineStep[] = [];
  for (let si = targetStageIndex; si < pipeline.stages.length; si++) {
    for (let sti = 0; sti < pipeline.stages[si].steps.length; sti++) {
      if (si > targetStageIndex || sti >= targetStepIndex) {
        stepsToReset.push(pipeline.stages[si].steps[sti]);
      }
    }
  }
  purgeCouncilsForSteps(stepsToReset);

  const stages = pipeline.stages.map((stage, si) => {
    if (si < targetStageIndex) return stage; // earlier stages untouched
    return {
      ...stage,
      steps: stage.steps.map((step, sti) => {
        // In the target stage: reset this step and all after it
        // In later stages: reset everything
        if (si > targetStageIndex || sti >= targetStepIndex) {
          return {
            ...step,
            status: 'pending' as const,
            artifact: undefined,
            error: undefined,
            startedAt: undefined,
            completedAt: undefined,
          };
        }
        return step;
      }),
    };
  });

  return updatePipeline(pipelineId, {
    stages,
    status: 'ready',
    currentStageIndex: targetStageIndex,
  });
}

// ============================================================================
// Store Class (for React integration)
// ============================================================================

export class PipelineStore {
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  getAll = getAllPipelines;
  get = getPipeline;

  create(params: Parameters<typeof createPipeline>[0]): Pipeline {
    const pipeline = createPipeline(params);
    this.notify();
    return pipeline;
  }

  update(id: string, updates: Parameters<typeof updatePipeline>[1]): Pipeline | null {
    const pipeline = updatePipeline(id, updates);
    if (pipeline) this.notify();
    return pipeline;
  }

  delete(id: string): boolean {
    const success = deletePipeline(id);
    if (success) this.notify();
    return success;
  }

  duplicate(id: string, newName?: string): Pipeline | null {
    const pipeline = duplicatePipeline(id, newName);
    if (pipeline) this.notify();
    return pipeline;
  }

  addStage(pipelineId: string, name?: string, atIndex?: number): Pipeline | null {
    const pipeline = addStage(pipelineId, name, atIndex);
    if (pipeline) this.notify();
    return pipeline;
  }

  removeStage(pipelineId: string, stageId: string): Pipeline | null {
    const pipeline = removeStage(pipelineId, stageId);
    if (pipeline) this.notify();
    return pipeline;
  }

  updateStage(pipelineId: string, stageId: string, updates: Partial<Omit<PipelineStage, 'id'>>): Pipeline | null {
    const pipeline = updateStage(pipelineId, stageId, updates);
    if (pipeline) this.notify();
    return pipeline;
  }

  reorderStages(pipelineId: string, stageIds: string[]): Pipeline | null {
    const pipeline = reorderStages(pipelineId, stageIds);
    if (pipeline) this.notify();
    return pipeline;
  }

  addStep(pipelineId: string, stageId: string, config: StepConfig, name?: string): Pipeline | null {
    const pipeline = addStep(pipelineId, stageId, config, name);
    if (pipeline) this.notify();
    return pipeline;
  }

  removeStep(pipelineId: string, stageId: string, stepId: string): Pipeline | null {
    const pipeline = removeStep(pipelineId, stageId, stepId);
    if (pipeline) this.notify();
    return pipeline;
  }

  updateStep(pipelineId: string, stepId: string, updates: Partial<Omit<PipelineStep, 'id'>>): Pipeline | null {
    const pipeline = updateStep(pipelineId, stepId, updates);
    if (pipeline) this.notify();
    return pipeline;
  }

  updateStepConfig(pipelineId: string, stepId: string, config: StepConfig): Pipeline | null {
    const pipeline = updateStepConfig(pipelineId, stepId, config);
    if (pipeline) this.notify();
    return pipeline;
  }

  setStepStatus(pipelineId: string, stepId: string, status: PipelineStepStatus, error?: string): Pipeline | null {
    const pipeline = setStepStatus(pipelineId, stepId, status, error);
    if (pipeline) this.notify();
    return pipeline;
  }

  setStepArtifact(pipelineId: string, stepId: string, artifact: StepArtifact): Pipeline | null {
    const pipeline = setStepArtifact(pipelineId, stepId, artifact);
    if (pipeline) this.notify();
    return pipeline;
  }

  setPipelineStatus(pipelineId: string, status: PipelineStatus): Pipeline | null {
    const pipeline = setPipelineStatus(pipelineId, status);
    if (pipeline) this.notify();
    return pipeline;
  }

  advanceStage(pipelineId: string): Pipeline | null {
    const pipeline = advanceStage(pipelineId);
    if (pipeline) this.notify();
    return pipeline;
  }

  resetExecution(pipelineId: string): Pipeline | null {
    const pipeline = resetExecution(pipelineId);
    if (pipeline) this.notify();
    return pipeline;
  }

  resetStepAndAfter(pipelineId: string, stepId: string): Pipeline | null {
    const pipeline = resetStepAndAfter(pipelineId, stepId);
    if (pipeline) this.notify();
    return pipeline;
  }
}

// Singleton instance
export const pipelineStore = new PipelineStore();
