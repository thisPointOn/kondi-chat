/**
 * Council: Context & Artifact Store
 * CRUD operations for context artifacts, patches, and other deliberation artifacts
 *
 * Storage layout:
 * - context-{councilId}: Current ContextArtifact (latest version)
 * - context-history-{councilId}: ContextArtifact[] (all versions)
 * - context-patches-{councilId}: ContextPatch[] (all proposals)
 * - decision-{councilId}: DecisionArtifact
 * - plan-{councilId}: PlanArtifact
 * - directive-{councilId}: DirectiveArtifact
 * - outputs-{councilId}: OutputArtifact[] (all outputs including revisions)
 */

import type {
  ContextArtifact,
  ContextPatch,
  DecisionArtifact,
  PlanArtifact,
  DirectiveArtifact,
  OutputArtifact,
  DeliberationRole,
} from './types';
import { councilDataStore } from './storage-cleanup';

// Storage key prefixes
const CONTEXT_PREFIX = 'context-';
const CONTEXT_HISTORY_PREFIX = 'context-history-';
const CONTEXT_PATCHES_PREFIX = 'context-patches-';
const DECISION_PREFIX = 'decision-';
const PLAN_PREFIX = 'plan-';
const DIRECTIVE_PREFIX = 'directive-';
const OUTPUTS_PREFIX = 'outputs-';

// ============================================================================
// Helper Functions
// ============================================================================

function loadJson<T>(key: string, defaultValue: T): T {
  try {
    const raw = councilDataStore.getItem(key);
    if (!raw) return defaultValue;
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error('[ContextStore] Failed to load:', key, error);
    return defaultValue;
  }
}

function saveJson<T>(key: string, value: T): void {
  councilDataStore.setItem(key, JSON.stringify(value));
}

function removeKey(key: string): void {
  councilDataStore.removeItem(key);
}

// ============================================================================
// Context Artifact Operations
// ============================================================================

/**
 * Get the current (latest) context artifact for a council
 */
export function getCurrentContext(councilId: string): ContextArtifact | null {
  const key = `${CONTEXT_PREFIX}${councilId}`;
  return loadJson<ContextArtifact | null>(key, null);
}

/**
 * Get all context versions for a council
 */
export function getContextHistory(councilId: string): ContextArtifact[] {
  const key = `${CONTEXT_HISTORY_PREFIX}${councilId}`;
  return loadJson<ContextArtifact[]>(key, []);
}

/**
 * Get a specific context version
 */
export function getContextVersion(councilId: string, version: number): ContextArtifact | null {
  const history = getContextHistory(councilId);
  return history.find((c) => c.version === version) ?? null;
}

/**
 * Create the initial context (version 1) from problem statement
 */
export function createInitialContext(
  councilId: string,
  content: string,
  authorPersonaId?: string
): ContextArtifact {
  const context: ContextArtifact = {
    id: crypto.randomUUID(),
    councilId,
    version: 1,
    content,
    changeSummary: 'Initial problem statement',
    authorRole: 'manager',
    authorPersonaId,
    createdAt: new Date().toISOString(),
  };

  // Save as current and to history
  saveJson(`${CONTEXT_PREFIX}${councilId}`, context);
  saveJson(`${CONTEXT_HISTORY_PREFIX}${councilId}`, [context]);

  console.log('[ContextStore] Created initial context v1 for council:', councilId);
  return context;
}

/**
 * Create a new context version from an accepted patch
 */
export function createContextVersion(
  councilId: string,
  newContent: string,
  changeSummary: string,
  authorRole: DeliberationRole,
  authorPersonaId?: string,
  roundNumber?: number
): ContextArtifact {
  const current = getCurrentContext(councilId);
  const baseVersion = current?.version ?? 0;

  const context: ContextArtifact = {
    id: crypto.randomUUID(),
    councilId,
    version: baseVersion + 1,
    content: newContent,
    createdFromVersion: baseVersion,
    changeSummary,
    authorRole,
    authorPersonaId,
    roundNumber,
    createdAt: new Date().toISOString(),
  };

  // Save as current
  saveJson(`${CONTEXT_PREFIX}${councilId}`, context);

  // Append to history
  const history = getContextHistory(councilId);
  history.push(context);
  saveJson(`${CONTEXT_HISTORY_PREFIX}${councilId}`, history);

  console.log('[ContextStore] Created context v', context.version, 'for council:', councilId);
  return context;
}

/**
 * Get diff between two context versions (simple text comparison)
 */
export function getContextDiff(
  councilId: string,
  fromVersion: number,
  toVersion: number
): { from: string; to: string; changeSummary: string } | null {
  const fromContext = getContextVersion(councilId, fromVersion);
  const toContext = getContextVersion(councilId, toVersion);

  if (!fromContext || !toContext) return null;

  return {
    from: fromContext.content,
    to: toContext.content,
    changeSummary: toContext.changeSummary,
  };
}

// ============================================================================
// Context Patch Operations
// ============================================================================

/**
 * Get all patches for a council
 */
export function getAllPatches(councilId: string): ContextPatch[] {
  const key = `${CONTEXT_PATCHES_PREFIX}${councilId}`;
  return loadJson<ContextPatch[]>(key, []);
}

/**
 * Get pending patches for a council
 */
export function getPendingPatches(councilId: string): ContextPatch[] {
  return getAllPatches(councilId).filter((p) => p.status === 'pending');
}

/**
 * Get a patch by ID
 */
export function getPatch(councilId: string, patchId: string): ContextPatch | null {
  const patches = getAllPatches(councilId);
  return patches.find((p) => p.id === patchId) ?? null;
}

/**
 * Create a new context patch proposal
 */
export function createPatch(
  councilId: string,
  targetContextId: string,
  baseVersion: number,
  diff: string,
  rationale: string,
  authorPersonaId: string,
  roundNumber: number
): ContextPatch {
  const patch: ContextPatch = {
    id: crypto.randomUUID(),
    councilId,
    targetContextId,
    baseVersion,
    diff,
    rationale,
    authorPersonaId,
    roundNumber,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const patches = getAllPatches(councilId);
  patches.push(patch);
  saveJson(`${CONTEXT_PATCHES_PREFIX}${councilId}`, patches);

  console.log('[ContextStore] Created patch:', patch.id, 'for council:', councilId);
  return patch;
}

/**
 * Accept a patch and create new context version
 *
 * @param councilId - The council ID
 * @param patchId - The patch to accept
 * @param reviewedBy - The persona ID of the reviewer (manager)
 * @param reviewReason - The reason for acceptance
 * @param newContent - The new context content with patch applied
 * @param options - Optional settings
 * @param options.allowStale - If true, accept stale patches with a warning (default: false throws error)
 * @param options.changeSummary - Override the change summary (default: uses patch rationale)
 */
export function acceptPatch(
  councilId: string,
  patchId: string,
  reviewedBy: string,
  reviewReason: string,
  newContent: string,
  options?: {
    allowStale?: boolean;
    changeSummary?: string;
  }
): { patch: ContextPatch; newContext: ContextArtifact; wasStale: boolean } {
  const patches = getAllPatches(councilId);
  const patchIndex = patches.findIndex((p) => p.id === patchId);

  if (patchIndex === -1) {
    throw new Error(`Patch not found: ${patchId}`);
  }

  const patch = patches[patchIndex];
  const current = getCurrentContext(councilId);
  const wasStale = current ? patch.baseVersion < current.version : false;

  // Check if patch is stale (base version no longer current)
  if (wasStale) {
    if (!options?.allowStale) {
      throw new Error(
        `Patch is stale: baseVersion ${patch.baseVersion} < currentVersion ${current!.version}. ` +
        `The patch needs to be rebased or explicitly accepted with allowStale: true.`
      );
    }
    console.warn(
      '[ContextStore] Accepting stale patch - base version:',
      patch.baseVersion,
      'current:',
      current!.version
    );
  }

  // Update patch status
  patch.status = 'accepted';
  patch.reviewedBy = reviewedBy;
  patch.reviewReason = reviewReason;
  patch.reviewedAt = new Date().toISOString();
  patches[patchIndex] = patch;
  saveJson(`${CONTEXT_PATCHES_PREFIX}${councilId}`, patches);

  // Use the patch's rationale as the change summary, or allow override
  const changeSummary = options?.changeSummary || patch.rationale || `Accepted change from consultant`;

  // Create new context version
  const newContext = createContextVersion(
    councilId,
    newContent,
    changeSummary,
    'manager',
    reviewedBy,
    patch.roundNumber
  );

  console.log(
    '[ContextStore] Accepted patch:',
    patchId,
    '-> context v',
    newContext.version,
    wasStale ? '(STALE)' : ''
  );
  return { patch, newContext, wasStale };
}

/**
 * Reject a patch
 */
export function rejectPatch(
  councilId: string,
  patchId: string,
  reviewedBy: string,
  reviewReason: string
): ContextPatch {
  const patches = getAllPatches(councilId);
  const patchIndex = patches.findIndex((p) => p.id === patchId);

  if (patchIndex === -1) {
    throw new Error(`Patch not found: ${patchId}`);
  }

  const patch = patches[patchIndex];
  patch.status = 'rejected';
  patch.reviewedBy = reviewedBy;
  patch.reviewReason = reviewReason;
  patch.reviewedAt = new Date().toISOString();
  patches[patchIndex] = patch;
  saveJson(`${CONTEXT_PATCHES_PREFIX}${councilId}`, patches);

  console.log('[ContextStore] Rejected patch:', patchId);
  return patch;
}

/**
 * Check if a patch is stale (base version is no longer current)
 */
export function isPatchStale(councilId: string, patchId: string): boolean {
  const patch = getPatch(councilId, patchId);
  const current = getCurrentContext(councilId);

  if (!patch || !current) return false;
  return patch.baseVersion < current.version;
}

// ============================================================================
// Decision Artifact Operations
// ============================================================================

/**
 * Get the decision artifact for a council
 */
export function getDecision(councilId: string): DecisionArtifact | null {
  const key = `${DECISION_PREFIX}${councilId}`;
  return loadJson<DecisionArtifact | null>(key, null);
}

/**
 * Create a decision artifact
 */
export function createDecision(
  councilId: string,
  content: string,
  contextVersionAtDecision: number,
  acceptanceCriteria?: string
): DecisionArtifact {
  const decision: DecisionArtifact = {
    id: crypto.randomUUID(),
    councilId,
    content,
    contextVersionAtDecision,
    acceptanceCriteria,
    createdAt: new Date().toISOString(),
  };

  saveJson(`${DECISION_PREFIX}${councilId}`, decision);
  console.log('[ContextStore] Created decision for council:', councilId);
  return decision;
}

// ============================================================================
// Plan Artifact Operations
// ============================================================================

/**
 * Get the plan artifact for a council
 */
export function getPlan(councilId: string): PlanArtifact | null {
  const key = `${PLAN_PREFIX}${councilId}`;
  return loadJson<PlanArtifact | null>(key, null);
}

/**
 * Create a plan artifact
 */
export function createPlan(
  councilId: string,
  content: string,
  decisionId: string
): PlanArtifact {
  const plan: PlanArtifact = {
    id: crypto.randomUUID(),
    councilId,
    content,
    decisionId,
    createdAt: new Date().toISOString(),
  };

  saveJson(`${PLAN_PREFIX}${councilId}`, plan);
  console.log('[ContextStore] Created plan for council:', councilId);
  return plan;
}

// ============================================================================
// Directive Artifact Operations
// ============================================================================

/**
 * Get the directive artifact for a council
 */
export function getDirective(councilId: string): DirectiveArtifact | null {
  const key = `${DIRECTIVE_PREFIX}${councilId}`;
  return loadJson<DirectiveArtifact | null>(key, null);
}

/**
 * Create a directive artifact
 */
export function createDirective(
  councilId: string,
  content: string,
  decisionId: string,
  planId?: string
): DirectiveArtifact {
  const directive: DirectiveArtifact = {
    id: crypto.randomUUID(),
    councilId,
    content,
    decisionId,
    planId,
    createdAt: new Date().toISOString(),
  };

  saveJson(`${DIRECTIVE_PREFIX}${councilId}`, directive);
  console.log('[ContextStore] Created directive for council:', councilId);
  return directive;
}

// ============================================================================
// Output Artifact Operations
// ============================================================================

/**
 * Get all outputs for a council
 */
export function getAllOutputs(councilId: string): OutputArtifact[] {
  const key = `${OUTPUTS_PREFIX}${councilId}`;
  return loadJson<OutputArtifact[]>(key, []);
}

/**
 * Get the latest output for a council
 */
export function getLatestOutput(councilId: string): OutputArtifact | null {
  const outputs = getAllOutputs(councilId);
  return outputs.length > 0 ? outputs[outputs.length - 1] : null;
}

/**
 * Get an output by ID
 */
export function getOutput(councilId: string, outputId: string): OutputArtifact | null {
  const outputs = getAllOutputs(councilId);
  return outputs.find((o) => o.id === outputId) ?? null;
}

/**
 * Create initial work output
 */
export function createOutput(
  councilId: string,
  content: string,
  directiveId: string
): OutputArtifact {
  const output: OutputArtifact = {
    id: crypto.randomUUID(),
    councilId,
    content,
    directiveId,
    version: 1,
    isRevision: false,
    createdAt: new Date().toISOString(),
  };

  const outputs = getAllOutputs(councilId);
  outputs.push(output);
  saveJson(`${OUTPUTS_PREFIX}${councilId}`, outputs);

  console.log('[ContextStore] Created output v1 for council:', councilId);
  return output;
}

/**
 * Create a revision output
 */
export function createRevisionOutput(
  councilId: string,
  content: string,
  directiveId: string,
  previousOutputId: string
): OutputArtifact {
  const outputs = getAllOutputs(councilId);
  const previousOutput = outputs.find((o) => o.id === previousOutputId);

  if (!previousOutput) {
    throw new Error(`Previous output not found: ${previousOutputId}`);
  }

  const output: OutputArtifact = {
    id: crypto.randomUUID(),
    councilId,
    content,
    directiveId,
    version: previousOutput.version + 1,
    isRevision: true,
    previousOutputId,
    createdAt: new Date().toISOString(),
  };

  outputs.push(output);
  saveJson(`${OUTPUTS_PREFIX}${councilId}`, outputs);

  console.log('[ContextStore] Created revision output v', output.version, 'for council:', councilId);
  return output;
}

// ============================================================================
// Cleanup Operations
// ============================================================================

/**
 * Delete all artifacts for a council
 */
export function deleteAllArtifacts(councilId: string): void {
  removeKey(`${CONTEXT_PREFIX}${councilId}`);
  removeKey(`${CONTEXT_HISTORY_PREFIX}${councilId}`);
  removeKey(`${CONTEXT_PATCHES_PREFIX}${councilId}`);
  removeKey(`${DECISION_PREFIX}${councilId}`);
  removeKey(`${PLAN_PREFIX}${councilId}`);
  removeKey(`${DIRECTIVE_PREFIX}${councilId}`);
  removeKey(`${OUTPUTS_PREFIX}${councilId}`);

  console.log('[ContextStore] Deleted all artifacts for council:', councilId);
}

/**
 * Check if artifacts exist for a council
 */
export function hasArtifacts(councilId: string): boolean {
  return getCurrentContext(councilId) !== null;
}

// ============================================================================
// Context Store Class (for React integration)
// ============================================================================

export class ContextStore {
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

  // Context operations
  getCurrentContext(councilId: string): ContextArtifact | null {
    return getCurrentContext(councilId);
  }

  getContextHistory(councilId: string): ContextArtifact[] {
    return getContextHistory(councilId);
  }

  getContextVersion(councilId: string, version: number): ContextArtifact | null {
    return getContextVersion(councilId, version);
  }

  createInitialContext(
    councilId: string,
    content: string,
    authorPersonaId?: string
  ): ContextArtifact {
    const context = createInitialContext(councilId, content, authorPersonaId);
    this.notify(councilId);
    return context;
  }

  createContextVersion(
    councilId: string,
    newContent: string,
    changeSummary: string,
    authorRole: DeliberationRole,
    authorPersonaId?: string,
    roundNumber?: number
  ): ContextArtifact {
    const context = createContextVersion(
      councilId,
      newContent,
      changeSummary,
      authorRole,
      authorPersonaId,
      roundNumber
    );
    this.notify(councilId);
    return context;
  }

  // Patch operations
  getPendingPatches(councilId: string): ContextPatch[] {
    return getPendingPatches(councilId);
  }

  getAllPatches(councilId: string): ContextPatch[] {
    return getAllPatches(councilId);
  }

  createPatch(
    councilId: string,
    targetContextId: string,
    baseVersion: number,
    diff: string,
    rationale: string,
    authorPersonaId: string,
    roundNumber: number
  ): ContextPatch {
    const patch = createPatch(
      councilId,
      targetContextId,
      baseVersion,
      diff,
      rationale,
      authorPersonaId,
      roundNumber
    );
    this.notify(councilId);
    return patch;
  }

  acceptPatch(
    councilId: string,
    patchId: string,
    reviewedBy: string,
    reviewReason: string,
    newContent: string,
    options?: { allowStale?: boolean; changeSummary?: string }
  ): { patch: ContextPatch; newContext: ContextArtifact; wasStale: boolean } {
    const result = acceptPatch(councilId, patchId, reviewedBy, reviewReason, newContent, options);
    this.notify(councilId);
    return result;
  }

  rejectPatch(
    councilId: string,
    patchId: string,
    reviewedBy: string,
    reviewReason: string
  ): ContextPatch {
    const patch = rejectPatch(councilId, patchId, reviewedBy, reviewReason);
    this.notify(councilId);
    return patch;
  }

  // Decision operations
  getDecision(councilId: string): DecisionArtifact | null {
    return getDecision(councilId);
  }

  createDecision(
    councilId: string,
    content: string,
    contextVersionAtDecision: number,
    acceptanceCriteria?: string
  ): DecisionArtifact {
    const decision = createDecision(councilId, content, contextVersionAtDecision, acceptanceCriteria);
    this.notify(councilId);
    return decision;
  }

  // Plan operations
  getPlan(councilId: string): PlanArtifact | null {
    return getPlan(councilId);
  }

  createPlan(councilId: string, content: string, decisionId: string): PlanArtifact {
    const plan = createPlan(councilId, content, decisionId);
    this.notify(councilId);
    return plan;
  }

  // Directive operations
  getDirective(councilId: string): DirectiveArtifact | null {
    return getDirective(councilId);
  }

  createDirective(
    councilId: string,
    content: string,
    decisionId: string,
    planId?: string
  ): DirectiveArtifact {
    const directive = createDirective(councilId, content, decisionId, planId);
    this.notify(councilId);
    return directive;
  }

  // Output operations
  getLatestOutput(councilId: string): OutputArtifact | null {
    return getLatestOutput(councilId);
  }

  getAllOutputs(councilId: string): OutputArtifact[] {
    return getAllOutputs(councilId);
  }

  createOutput(councilId: string, content: string, directiveId: string): OutputArtifact {
    const output = createOutput(councilId, content, directiveId);
    this.notify(councilId);
    return output;
  }

  createRevisionOutput(
    councilId: string,
    content: string,
    directiveId: string,
    previousOutputId: string
  ): OutputArtifact {
    const output = createRevisionOutput(councilId, content, directiveId, previousOutputId);
    this.notify(councilId);
    return output;
  }

  // Cleanup
  deleteAll(councilId: string): void {
    deleteAllArtifacts(councilId);
    this.listeners.delete(councilId);
  }
}

// Singleton instance for app-wide use
export const contextStore = new ContextStore();
