/**
 * Council Factory
 * Unified council creation from a CouncilSetup descriptor.
 * Used by both standalone UI (CouncilLibrary) and pipeline executor.
 */

import type {
  Council,
  Persona,
  DeliberationRoleAssignment,
  SummaryMode,
} from './types';
import type { PipelinePersona } from '../pipeline/types';
import { councilStore } from './store';

// ============================================================================
// CouncilSetup — canonical input for creating a council
// ============================================================================

export interface CouncilSetup {
  name: string;
  topic?: string;
  /** Standing instructions — what this council should do (the task/directive) */
  task?: string;
  personas: PipelinePersona[];
  maxRounds?: number;                 // Default: 2
  maxRevisions?: number;              // Default: 3
  expectedOutput?: string;
  decisionCriteria?: string[];
  workingDirectory?: string;
  directoryConstrained?: boolean;     // Default: true
  consultantExecution?: 'sequential' | 'parallel';
  contextTokenBudget?: number;        // Default: 80000
  summaryMode?: SummaryMode;          // Default: 'hybrid'
  summarizeAfterRound?: number;       // Default: 2
  saveDeliberation?: boolean;
  saveDeliberationMode?: 'full' | 'abbreviated';
  maxWordsPerResponse?: number;
  bootstrapContext?: boolean;         // Default: true when workingDirectory is set
  evolveContext?: boolean;            // Default: false — append findings/results to context each phase
  stepType?: 'council' | 'code_planning' | 'analysis' | 'agent' | 'coding' | 'review' | 'enrich';
  testCommand?: string;
  maxDebugCycles?: number;
  maxReviewCycles?: number;
  allowedServerIds?: string[];
  pipelinePrefix?: string;           // Prepended to name (e.g. '[Pipeline]')
  pipelineId?: string;               // Links council to creating pipeline
}

// ============================================================================
// Default colors by role
// ============================================================================

const ROLE_COLORS: Record<string, string> = {
  manager: '#6366f1',
  worker: '#f59e0b',
  reviewer: '#0ea5e9',
  consultant: '#16a34a',
};

const ROLE_DEFAULT_TRAITS: Record<string, string[]> = {
  manager: ['analytical', 'decisive'],
  worker: ['thorough', 'detail-oriented'],
  reviewer: ['critical', 'quality-focused'],
  consultant: ['insightful', 'collaborative'],
};

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Council from a CouncilSetup descriptor.
 *
 * Handles:
 * - Persona UUID generation + default colors/traits
 * - Role assignment derivation from persona.role
 * - councilStore.create() call with unified defaults
 */
export function createCouncilFromSetup(setup: CouncilSetup): Council {
  const displayName = setup.pipelinePrefix
    ? `${setup.pipelinePrefix} ${setup.name}`
    : setup.name;

  // Convert PipelinePersona[] → Persona[]
  const personas: Persona[] = setup.personas.map((p) => ({
    id: crypto.randomUUID(),
    name: p.name,
    provider: p.provider,
    model: p.model,
    avatar: p.avatar,
    color: p.color || ROLE_COLORS[p.role] || '#16a34a',
    predisposition: {
      systemPrompt: p.systemPrompt || `You are ${p.name}, a ${p.role} in this deliberation.`,
      stance: p.stance || ('neutral' as const),
      traits: p.traits && p.traits.length > 0
        ? p.traits
        : ROLE_DEFAULT_TRAITS[p.role] || ['insightful', 'collaborative'],
      interactionStyle: p.interactionStyle || ('build' as const),
      domain: p.domain,
    },
    temperature: p.temperature ?? 0.7,
    verbosity: p.verbosity || ('balanced' as const),
    preferredDeliberationRole: p.role,
    allowedServerIds: p.allowedServerIds,
  }));

  // Derive role assignments from persona config
  const roleAssignments: DeliberationRoleAssignment[] = setup.personas.map(
    (p, i) => ({
      personaId: personas[i].id,
      role: p.role,
      focusArea: p.focusArea,
      stance: p.startingStance,
      suppressPersona: p.suppressPersona ?? (p.role === 'manager' || p.role === 'worker' || p.role === 'reviewer'),
      writePermissions: (p.role === 'worker' && p.toolAccess !== 'none') ? true : undefined,
      toolAccess: p.toolAccess,
      allowedServerIds: p.allowedServerIds,
    })
  );

  // Resolve bootstrapContext default
  const bootstrapContext = setup.bootstrapContext ?? (setup.workingDirectory ? true : false);

  // Create council via store
  const council = councilStore.create({
    name: displayName,
    topic: setup.topic || displayName,
    personas,
    orchestration: { mode: 'deliberation' },
    pipelineId: setup.pipelineId,
    deliberation: {
      enabled: true,
      roleAssignments,
      minRounds: 1,
      maxRounds: setup.maxRounds ?? 2,
      maxRevisions: setup.maxRevisions ?? 3,
      savedProblem: setup.task,
      expectedOutput: setup.expectedOutput,
      decisionCriteria: setup.decisionCriteria,
      workingDirectory: setup.workingDirectory,
      directoryConstrained: setup.directoryConstrained ?? true,
      summaryMode: setup.summaryMode ?? 'hybrid',
      summarizeAfterRound: setup.summarizeAfterRound ?? 2,
      contextTokenBudget: setup.contextTokenBudget ?? 80000,
      consultantErrorPolicy: 'retry',
      maxRetries: 2,
      requirePlan: false,
      consultantExecution: setup.consultantExecution ?? 'sequential',
      saveDeliberation: setup.saveDeliberation,
      saveDeliberationMode: setup.saveDeliberationMode ?? 'full',
      maxWordsPerResponse: setup.maxWordsPerResponse,
      bootstrapContext,
      evolveContext: setup.evolveContext ?? false,
      stepType: setup.stepType,
      testCommand: setup.testCommand,
      maxDebugCycles: setup.maxDebugCycles ?? 5,
      maxReviewCycles: setup.maxReviewCycles ?? 2,
      allowedServerIds: setup.allowedServerIds,
    },
  });

  return council;
}
