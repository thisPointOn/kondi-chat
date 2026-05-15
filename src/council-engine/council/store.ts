/**
 * Council: Persistence Store
 * CRUD operations for councils with localStorage persistence
 */

import type {
  Council,
  Persona,
  CouncilMessage,
  OrchestrationConfig,
  SharedContext,
  Resolution,
  DeliberationConfig,
  DeliberationState,
  DeliberationRoleAssignment,
  DeliberationPhase,
  DeliberationRole,
} from './types';
import { validateCouncil } from './validation';
import { deleteLedger } from './ledger-store';
import { deleteAllArtifacts } from './context-store';
import { councilDataStore } from './storage-cleanup';

const STORAGE_KEY = 'mcp-councils';
const STORAGE_VERSION = 2;

interface StorageData {
  version: number;
  councils: Council[];
  lastUpdated: string;
}

// ============================================================================
// Storage Helpers
// ============================================================================

function loadFromStorage(): StorageData {
  try {
    const raw = councilDataStore.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: STORAGE_VERSION, councils: [], lastUpdated: new Date().toISOString() };
    }
    const data = JSON.parse(raw) as StorageData;
    // Handle version migrations
    if (data.version < STORAGE_VERSION) {
      console.log('[CouncilStore] Migrating from version', data.version, 'to', STORAGE_VERSION);
      data.councils = migrateCouncils(data.councils, data.version);
      data.version = STORAGE_VERSION;
      saveToStorage(data);
    }
    return data;
  } catch (error) {
    console.error('[CouncilStore] Failed to load from storage:', error);
    return { version: STORAGE_VERSION, councils: [], lastUpdated: new Date().toISOString() };
  }
}

/**
 * Migrate councils from older versions
 */
function migrateCouncils(councils: Council[], fromVersion: number): Council[] {
  let migrated = councils;

  // Migration from v1 to v2: Add deliberation fields
  if (fromVersion < 2) {
    migrated = migrated.map((council) => ({
      ...council,
      // Existing councils get undefined deliberation (backward compatible)
      deliberation: undefined,
      deliberationState: undefined,
    }));
    console.log('[CouncilStore] Migrated', migrated.length, 'councils from v1 to v2');
  }

  // Always sanitize status — old duplicates may have invalid values like 'created'
  migrated = migrated.map((council) => ({
    ...council,
    status: ['active', 'paused', 'resolved'].includes(council.status) ? council.status : 'active',
  }));

  return migrated;
}

function saveToStorage(data: StorageData): void {
  data.lastUpdated = new Date().toISOString();
  const json = JSON.stringify(data);
  councilDataStore.setItem(STORAGE_KEY, json);
  console.log('[CouncilStore] Saved', data.councils.length, 'councils');
}

// ============================================================================
// Council CRUD
// ============================================================================

/**
 * Get all councils
 */
export function getAllCouncils(): Council[] {
  const data = loadFromStorage();
  return data.councils.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Get a council by ID
 */
export function getCouncil(id: string): Council | null {
  const data = loadFromStorage();
  return data.councils.find((c) => c.id === id) || null;
}

/**
 * Create a new council
 */
export function createCouncil(params: {
  name: string;
  topic: string;
  sharedContext?: Partial<SharedContext>;
  personas?: Persona[];
  orchestration?: Partial<OrchestrationConfig>;
  deliberation?: Partial<DeliberationConfig>;
  pipelineId?: string;
}): Council {
  const now = new Date().toISOString();
  const isDeliberationMode = params.orchestration?.mode === 'deliberation';

  const council: Council = {
    id: crypto.randomUUID(),
    name: params.name,
    createdAt: now,
    updatedAt: now,
    topic: params.topic,
    sharedContext: {
      description: params.sharedContext?.description || params.topic,
      documents: params.sharedContext?.documents || [],
      data: params.sharedContext?.data,
      constraints: params.sharedContext?.constraints,
    },
    personas: params.personas || [],
    orchestration: {
      mode: params.orchestration?.mode || 'debate',
      turnStrategy: params.orchestration?.turnStrategy || 'round-robin',
      maxTurnsPerRound: params.orchestration?.maxTurnsPerRound || 5,
      maxTotalTurns: params.orchestration?.maxTotalTurns,
      autoSynthesize: params.orchestration?.autoSynthesize ?? true,
      synthesizerId: params.orchestration?.synthesizerId,
      convergenceCriteria: params.orchestration?.convergenceCriteria,
      requiresResolution: params.orchestration?.requiresResolution ?? false,
    },
    messages: [],
    status: 'active',
    totalTokensUsed: 0,
    estimatedCost: 0,
    // Deliberation config (only for deliberation mode)
    deliberation: isDeliberationMode ? {
      enabled: true,
      roleAssignments: params.deliberation?.roleAssignments || [],
      minRounds: params.deliberation?.minRounds ?? 1,
      maxRounds: params.deliberation?.maxRounds ?? 4,
      maxRevisions: params.deliberation?.maxRevisions ?? 3,
      expectedOutput: params.deliberation?.expectedOutput,
      decisionCriteria: params.deliberation?.decisionCriteria,
      summaryMode: params.deliberation?.summaryMode ?? 'hybrid',
      summarizeAfterRound: params.deliberation?.summarizeAfterRound ?? 1,
      contextTokenBudget: params.deliberation?.contextTokenBudget ?? 40000,
      consultantErrorPolicy: params.deliberation?.consultantErrorPolicy ?? 'retry',
      maxRetries: params.deliberation?.maxRetries ?? 2,
      requirePlan: params.deliberation?.requirePlan ?? false,
      consultantExecution: params.deliberation?.consultantExecution ?? 'sequential',
      workingDirectory: params.deliberation?.workingDirectory,
      directoryConstrained: params.deliberation?.directoryConstrained ?? true,
      saveDeliberation: params.deliberation?.saveDeliberation ?? false,
      saveDeliberationMode: params.deliberation?.saveDeliberationMode ?? 'full',
      maxWordsPerResponse: params.deliberation?.maxWordsPerResponse,
      bootstrapContext: params.deliberation?.bootstrapContext,
      stepType: params.deliberation?.stepType,
      testCommand: params.deliberation?.testCommand,
      maxDebugCycles: params.deliberation?.maxDebugCycles,
      maxReviewCycles: params.deliberation?.maxReviewCycles,
      allowedServerIds: params.deliberation?.allowedServerIds,
    } : undefined,
    // Deliberation state (initialized when deliberation starts)
    deliberationState: undefined,
    // Pipeline linkage
    pipelineId: params.pipelineId,
  };

  // Validate before saving
  const validation = validateCouncil(council);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    console.error('[CouncilStore] Invalid council on create:', issues, validation.error);
    throw new Error(`Invalid council data: ${issues}`);
  }

  const data = loadFromStorage();
  data.councils.push(council);
  saveToStorage(data);

  console.log('[CouncilStore] Created council:', council.id, council.name, isDeliberationMode ? '(deliberation mode)' : '');
  return council;
}

/**
 * Update a council
 */
export function updateCouncil(
  id: string,
  updates: Partial<Omit<Council, 'id' | 'createdAt'>>
): Council | null {
  const data = loadFromStorage();
  const index = data.councils.findIndex((c) => c.id === id);

  if (index === -1) {
    console.warn('[CouncilStore] Council not found:', id);
    return null;
  }

  const council = data.councils[index];
  const updated: Council = {
    ...council,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  // Coerce invalid status values to 'active' (e.g. 'created' from old duplicates)
  if (!['active', 'paused', 'resolved'].includes(updated.status)) {
    updated.status = 'active';
  }

  // Validate the updated council
  const validation = validateCouncil(updated);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    console.error('[CouncilStore] Invalid council update:', issues, validation.error);
    throw new Error(`Invalid council data: ${issues}`);
  }

  data.councils[index] = updated;
  saveToStorage(data);

  console.log('[CouncilStore] Updated council:', id);
  return updated;
}

/**
 * Delete a council
 */
export function deleteCouncil(id: string): boolean {
  const data = loadFromStorage();
  const index = data.councils.findIndex((c) => c.id === id);

  if (index === -1) {
    console.warn('[CouncilStore] Council not found:', id);
    return false;
  }

  data.councils.splice(index, 1);
  saveToStorage(data);

  console.log('[CouncilStore] Deleted council:', id);
  return true;
}

// ============================================================================
// Persona Operations
// ============================================================================

/**
 * Add a persona to a council
 */
export function addPersona(councilId: string, persona: Persona): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  // Check for duplicate names
  if (council.personas.some((p) => p.name === persona.name)) {
    throw new Error(`Persona "${persona.name}" already exists in this council`);
  }

  // Also add a role assignment if deliberation config exists
  const updates: Partial<Council> = {
    personas: [...council.personas, persona],
  };

  if (council.deliberation) {
    const existingAssignment = council.deliberation.roleAssignments.find(
      (r) => r.personaId === persona.id
    );
    if (!existingAssignment) {
      // Default new personas to 'consultant' role
      const role = persona.preferredDeliberationRole || 'consultant';
      updates.deliberation = {
        ...council.deliberation,
        roleAssignments: [
          ...council.deliberation.roleAssignments,
          { personaId: persona.id, role },
        ],
      };
    }
  }

  return updateCouncil(councilId, updates);
}

/**
 * Update a persona in a council
 */
export function updatePersona(
  councilId: string,
  personaId: string,
  updates: Partial<Omit<Persona, 'id'>>
): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  const personaIndex = council.personas.findIndex((p) => p.id === personaId);
  if (personaIndex === -1) {
    throw new Error(`Persona not found: ${personaId}`);
  }

  const updatedPersonas = [...council.personas];
  updatedPersonas[personaIndex] = {
    ...updatedPersonas[personaIndex],
    ...updates,
  };

  return updateCouncil(councilId, { personas: updatedPersonas });
}

/**
 * Remove a persona from a council
 */
export function removePersona(councilId: string, personaId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  const updates: Partial<Council> = {
    personas: council.personas.filter((p) => p.id !== personaId),
  };

  // Also remove the role assignment if deliberation config exists
  if (council.deliberation) {
    updates.deliberation = {
      ...council.deliberation,
      roleAssignments: council.deliberation.roleAssignments.filter(
        (r) => r.personaId !== personaId
      ),
    };
  }

  return updateCouncil(councilId, updates);
}

/**
 * Mute/unmute a persona
 */
export function setPersonaMuted(
  councilId: string,
  personaId: string,
  muted: boolean
): Council | null {
  return updatePersona(councilId, personaId, { muted });
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Add a message to a council
 */
export function addMessage(councilId: string, message: CouncilMessage): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  return updateCouncil(councilId, {
    messages: [...council.messages, message],
    totalTokensUsed: council.totalTokensUsed + message.tokensUsed,
  });
}

/**
 * Get messages for a council, optionally filtered
 */
export function getMessages(
  councilId: string,
  options?: {
    speakerId?: string;
    speakerType?: 'persona' | 'user' | 'system';
    limit?: number;
    offset?: number;
  }
): CouncilMessage[] {
  const council = getCouncil(councilId);
  if (!council) return [];

  let messages = council.messages;

  if (options?.speakerId) {
    messages = messages.filter((m) => m.speakerId === options.speakerId);
  }

  if (options?.speakerType) {
    messages = messages.filter((m) => m.speakerType === options.speakerType);
  }

  if (options?.offset) {
    messages = messages.slice(options.offset);
  }

  if (options?.limit) {
    messages = messages.slice(0, options.limit);
  }

  return messages;
}

// ============================================================================
// Status & Resolution Operations
// ============================================================================

/**
 * Update council status
 */
export function setCouncilStatus(
  councilId: string,
  status: Council['status']
): Council | null {
  return updateCouncil(councilId, { status });
}

/**
 * Set council resolution
 */
export function setResolution(
  councilId: string,
  resolution: Resolution
): Council | null {
  return updateCouncil(councilId, {
    resolution,
    status: 'resolved',
  });
}

/**
 * Update cost tracking
 */
export function updateCost(
  councilId: string,
  additionalTokens: number,
  additionalCost: number
): Council | null {
  const council = getCouncil(councilId);
  if (!council) return null;

  return updateCouncil(councilId, {
    totalTokensUsed: council.totalTokensUsed + additionalTokens,
    estimatedCost: council.estimatedCost + additionalCost,
  });
}

// ============================================================================
// Query Operations
// ============================================================================

/**
 * Search councils by name or topic
 */
export function searchCouncils(query: string): Council[] {
  const councils = getAllCouncils();
  const lowerQuery = query.toLowerCase();

  return councils.filter(
    (c) =>
      c.name.toLowerCase().includes(lowerQuery) ||
      c.topic.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get councils by status
 */
export function getCouncilsByStatus(status: Council['status']): Council[] {
  const councils = getAllCouncils();
  return councils.filter((c) => c.status === status);
}

/**
 * Get active councils (not resolved)
 */
export function getActiveCouncils(): Council[] {
  return getCouncilsByStatus('active');
}

/**
 * Get recent councils
 */
export function getRecentCouncils(limit = 10): Council[] {
  return getAllCouncils().slice(0, limit);
}

// ============================================================================
// Export/Import
// ============================================================================

/**
 * Export a council to JSON
 */
export function exportCouncil(councilId: string): string | null {
  const council = getCouncil(councilId);
  if (!council) return null;
  return JSON.stringify(council, null, 2);
}

/**
 * Import a council from JSON
 */
export function importCouncil(json: string): Council {
  const data = JSON.parse(json);

  // Validate the imported data
  const validation = validateCouncil(data);
  if (!validation.success) {
    throw new Error(`Invalid council data: ${validation.error.message}`);
  }

  // Generate new ID to avoid conflicts
  const council: Council = {
    ...validation.data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const storageData = loadFromStorage();
  storageData.councils.push(council);
  saveToStorage(storageData);

  return council;
}

/**
 * Duplicate a council
 */
export function duplicateCouncil(councilId: string, newName?: string): Council | null {
  const original = getCouncil(councilId);
  if (!original) return null;

  const now = new Date().toISOString();

  // Build persona ID mapping (old → new) so role assignments stay linked
  const personaIdMap = new Map<string, string>();
  const newPersonas = original.personas.map((p) => {
    const newId = crypto.randomUUID();
    personaIdMap.set(p.id, newId);
    return { ...p, id: newId };
  });

  // Remap role assignments to new persona IDs
  const newRoleAssignments = original.deliberation?.roleAssignments?.map((ra) => ({
    ...ra,
    personaId: personaIdMap.get(ra.personaId) || ra.personaId,
  }));

  const duplicate: Council = {
    ...original,
    id: crypto.randomUUID(),
    name: newName || `${original.name} (Copy)`,
    createdAt: now,
    updatedAt: now,
    messages: [],
    status: 'active',
    resolution: undefined,
    totalTokensUsed: 0,
    estimatedCost: 0,
    personas: newPersonas,
    deliberation: original.deliberation ? {
      ...original.deliberation,
      roleAssignments: newRoleAssignments || [],
    } : undefined,
    deliberationState: undefined,
  };

  const data = loadFromStorage();
  data.councils.push(duplicate);
  saveToStorage(data);

  return duplicate;
}

// ============================================================================
// Deliberation State Operations
// ============================================================================

/**
 * Initialize deliberation state for a council
 */
export function initializeDeliberationState(councilId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberation) return null;

  const initialState: DeliberationState = {
    currentPhase: 'created',
    currentRound: 0,
    roundRunId: crypto.randomUUID(),
    maxRounds: council.deliberation.maxRounds,
    revisionCount: 0,
    maxRevisions: council.deliberation.maxRevisions,
    roundSubmissions: {},
    roundSummaries: {},
    activeContextId: '',
    activeContextVersion: 0,
    pendingPatches: [],
    reDeliberationCount: 0,
    errorLog: [],
  };

  return updateCouncil(councilId, { deliberationState: initialState });
}

/**
 * Update deliberation state
 */
export function updateDeliberationState(
  councilId: string,
  updates: Partial<DeliberationState>
): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const updatedState: DeliberationState = {
    ...council.deliberationState,
    ...updates,
  };

  return updateCouncil(councilId, { deliberationState: updatedState });
}

/**
 * Update deliberation phase
 */
export function setDeliberationPhase(
  councilId: string,
  phase: DeliberationPhase,
  previousPhase?: DeliberationPhase
): Council | null {
  let council = getCouncil(councilId);
  if (!council) return null;

  // Initialize deliberationState if it doesn't exist
  if (!council.deliberationState) {
    council = initializeDeliberationState(councilId);
    if (!council) return null;
  }

  const updates: Partial<DeliberationState> = { currentPhase: phase };
  if (previousPhase !== undefined) {
    updates.previousPhase = previousPhase;
  }

  return updateDeliberationState(councilId, updates);
}

/**
 * Advance to next round
 */
export function advanceDeliberationRound(councilId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const newRound = council.deliberationState.currentRound + 1;

  return updateDeliberationState(councilId, {
    currentRound: newRound,
    roundRunId: crypto.randomUUID(),
  });
}

/**
 * Record a consultant submission for the current round
 */
export function recordRoundSubmission(
  councilId: string,
  personaId: string
): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const currentRound = council.deliberationState.currentRound;
  const submissions = { ...council.deliberationState.roundSubmissions };

  if (!submissions[currentRound]) {
    submissions[currentRound] = [];
  }

  if (!submissions[currentRound].includes(personaId)) {
    submissions[currentRound].push(personaId);
  }

  return updateDeliberationState(councilId, { roundSubmissions: submissions });
}

/**
 * Check if all consultants have submitted for the current round
 */
export function isRoundComplete(councilId: string): boolean {
  const council = getCouncil(councilId);
  if (!council || !council.deliberation || !council.deliberationState) return false;

  const currentRound = council.deliberationState.currentRound;
  const submissions = council.deliberationState.roundSubmissions[currentRound] || [];

  // Get consultant persona IDs from role assignments
  const consultantIds = council.deliberation.roleAssignments
    .filter((r) => r.role === 'consultant')
    .map((r) => r.personaId);

  return consultantIds.every((id) => submissions.includes(id));
}

/**
 * Set role assignments for a council
 */
export function setRoleAssignments(
  councilId: string,
  assignments: DeliberationRoleAssignment[]
): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberation) return null;

  const updatedDeliberation: DeliberationConfig = {
    ...council.deliberation,
    roleAssignments: assignments,
  };

  return updateCouncil(councilId, { deliberation: updatedDeliberation });
}

/**
 * Add a pending patch to deliberation state
 */
export function addPendingPatch(councilId: string, patchId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const pendingPatches = [...council.deliberationState.pendingPatches, patchId];

  return updateDeliberationState(councilId, { pendingPatches });
}

/**
 * Remove a pending patch from deliberation state
 */
export function removePendingPatch(councilId: string, patchId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const pendingPatches = council.deliberationState.pendingPatches.filter(
    (id) => id !== patchId
  );

  return updateDeliberationState(councilId, { pendingPatches });
}

/**
 * Set round summary
 */
export function setRoundSummary(
  councilId: string,
  round: number,
  summary: string
): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const roundSummaries = {
    ...council.deliberationState.roundSummaries,
    [round]: summary,
  };

  return updateDeliberationState(councilId, { roundSummaries });
}

/**
 * Set active context
 */
export function setActiveContext(
  councilId: string,
  contextId: string,
  version: number
): Council | null {
  return updateDeliberationState(councilId, {
    activeContextId: contextId,
    activeContextVersion: version,
  });
}

/**
 * Set manager's last evaluation
 */
export function setManagerEvaluation(
  councilId: string,
  evaluation: DeliberationState['managerLastEvaluation']
): Council | null {
  return updateDeliberationState(councilId, { managerLastEvaluation: evaluation });
}

/**
 * Set final decision ID
 */
export function setFinalDecision(councilId: string, decisionId: string): Council | null {
  return updateDeliberationState(councilId, { finalDecisionId: decisionId });
}

/**
 * Set work directive ID
 */
export function setWorkDirective(councilId: string, directiveId: string): Council | null {
  return updateDeliberationState(councilId, { workDirectiveId: directiveId });
}

/**
 * Set current output ID
 */
export function setCurrentOutput(councilId: string, outputId: string): Council | null {
  return updateDeliberationState(councilId, { currentOutputId: outputId });
}

/**
 * Increment revision count
 */
export function incrementRevisionCount(councilId: string): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  return updateDeliberationState(councilId, {
    revisionCount: council.deliberationState.revisionCount + 1,
  });
}

/**
 * Add error to log
 */
export function addErrorToLog(councilId: string, error: string): Council | null {
  const council = getCouncil(councilId);
  if (!council || !council.deliberationState) return null;

  const errorLog = [...council.deliberationState.errorLog, error];

  return updateDeliberationState(councilId, { errorLog });
}

/**
 * Get persona by role
 */
export function getPersonaByRole(
  council: Council,
  role: DeliberationRole
): Persona[] {
  if (!council.deliberation) return [];

  const roleAssignments = council.deliberation.roleAssignments.filter(
    (r) => r.role === role
  );

  return roleAssignments
    .map((r) => council.personas.find((p) => p.id === r.personaId))
    .filter((p): p is Persona => p !== undefined);
}

/**
 * Get role assignment for a persona
 */
export function getRoleAssignment(
  council: Council,
  personaId: string
): DeliberationRoleAssignment | undefined {
  return council.deliberation?.roleAssignments.find((r) => r.personaId === personaId);
}

/**
 * Check if council is in deliberation mode
 */
export function isDeliberationMode(council: Council): boolean {
  return council.orchestration.mode === 'deliberation' && council.deliberation?.enabled === true;
}

/**
 * Delete council and all associated deliberation data
 */
export function deleteCouncilWithData(id: string): boolean {
  // Delete ledger
  deleteLedger(id);

  // Delete artifacts
  deleteAllArtifacts(id);

  // Delete council
  return deleteCouncil(id);
}

// ============================================================================
// Store Class (for React integration)
// ============================================================================

export class CouncilStore {
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  getAll = getAllCouncils;
  get = getCouncil;

  create(params: Parameters<typeof createCouncil>[0]): Council {
    const council = createCouncil(params);
    this.notify();
    return council;
  }

  update(id: string, updates: Parameters<typeof updateCouncil>[1]): Council | null {
    const council = updateCouncil(id, updates);
    if (council) this.notify();
    return council;
  }

  delete(id: string): boolean {
    const success = deleteCouncilWithData(id);
    if (success) this.notify();
    return success;
  }

  addPersona(councilId: string, persona: Persona): Council | null {
    const council = addPersona(councilId, persona);
    if (council) this.notify();
    return council;
  }

  removePersona(councilId: string, personaId: string): Council | null {
    const council = removePersona(councilId, personaId);
    if (council) this.notify();
    return council;
  }

  updatePersona(councilId: string, personaId: string, updates: Partial<Omit<Persona, 'id'>>): Council | null {
    const council = updatePersona(councilId, personaId, updates);
    if (council) this.notify();
    return council;
  }

  addMessage(councilId: string, message: CouncilMessage): Council | null {
    const council = addMessage(councilId, message);
    if (council) this.notify();
    return council;
  }

  setStatus(councilId: string, status: Council['status']): Council | null {
    const council = setCouncilStatus(councilId, status);
    if (council) this.notify();
    return council;
  }

  resolve(councilId: string, resolution: Resolution): Council | null {
    const council = setResolution(councilId, resolution);
    if (council) this.notify();
    return council;
  }

  // ============================================================================
  // Deliberation Methods
  // ============================================================================

  initializeDeliberation(councilId: string): Council | null {
    const council = initializeDeliberationState(councilId);
    if (council) this.notify();
    return council;
  }

  updateDeliberationState(
    councilId: string,
    updates: Partial<DeliberationState>
  ): Council | null {
    const council = updateDeliberationState(councilId, updates);
    if (council) this.notify();
    return council;
  }

  setDeliberationPhase(
    councilId: string,
    phase: DeliberationPhase,
    previousPhase?: DeliberationPhase
  ): Council | null {
    const council = setDeliberationPhase(councilId, phase, previousPhase);
    if (council) this.notify();
    return council;
  }

  advanceRound(councilId: string): Council | null {
    const council = advanceDeliberationRound(councilId);
    if (council) this.notify();
    return council;
  }

  recordSubmission(councilId: string, personaId: string): Council | null {
    const council = recordRoundSubmission(councilId, personaId);
    if (council) this.notify();
    return council;
  }

  isRoundComplete(councilId: string): boolean {
    return isRoundComplete(councilId);
  }

  setRoleAssignments(
    councilId: string,
    assignments: DeliberationRoleAssignment[]
  ): Council | null {
    const council = setRoleAssignments(councilId, assignments);
    if (council) this.notify();
    return council;
  }

  addPendingPatch(councilId: string, patchId: string): Council | null {
    const council = addPendingPatch(councilId, patchId);
    if (council) this.notify();
    return council;
  }

  removePendingPatch(councilId: string, patchId: string): Council | null {
    const council = removePendingPatch(councilId, patchId);
    if (council) this.notify();
    return council;
  }

  setRoundSummary(councilId: string, round: number, summary: string): Council | null {
    const council = setRoundSummary(councilId, round, summary);
    if (council) this.notify();
    return council;
  }

  setActiveContext(councilId: string, contextId: string, version: number): Council | null {
    const council = setActiveContext(councilId, contextId, version);
    if (council) this.notify();
    return council;
  }

  setManagerEvaluation(
    councilId: string,
    evaluation: DeliberationState['managerLastEvaluation']
  ): Council | null {
    const council = setManagerEvaluation(councilId, evaluation);
    if (council) this.notify();
    return council;
  }

  setFinalDecision(councilId: string, decisionId: string): Council | null {
    const council = setFinalDecision(councilId, decisionId);
    if (council) this.notify();
    return council;
  }

  setWorkDirective(councilId: string, directiveId: string): Council | null {
    const council = setWorkDirective(councilId, directiveId);
    if (council) this.notify();
    return council;
  }

  setCurrentOutput(councilId: string, outputId: string): Council | null {
    const council = setCurrentOutput(councilId, outputId);
    if (council) this.notify();
    return council;
  }

  incrementRevisionCount(councilId: string): Council | null {
    const council = incrementRevisionCount(councilId);
    if (council) this.notify();
    return council;
  }

  addError(councilId: string, error: string): Council | null {
    const council = addErrorToLog(councilId, error);
    if (council) this.notify();
    return council;
  }

  getPersonaByRole = getPersonaByRole;
  getRoleAssignment = getRoleAssignment;
  isDeliberationMode = isDeliberationMode;
}

// Singleton instance for app-wide use
export const councilStore = new CouncilStore();
