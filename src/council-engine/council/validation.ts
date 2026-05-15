/**
 * Council: Validation Schemas
 * Zod schemas for validating Council configurations
 */

import { z } from 'zod';

// ============================================================================
// Basic Schemas
// ============================================================================

export const stanceSchema = z.enum(['advocate', 'critic', 'neutral', 'wildcard']);

export const interactionStyleSchema = z.enum(['debate', 'build', 'question', 'synthesize', 'review']);

export const councilModeSchema = z.enum([
  'debate',
  'build',
  'review',
  'synthesis',
  'socratic',
  'freeform',
  'deliberation',
]);

export const turnStrategySchema = z.enum([
  'round-robin',
  'react',
  'popcorn',
  'volunteer',
  'moderator',
  'parallel',
  'relevance',
]);

export const verbositySchema = z.enum(['concise', 'balanced', 'thorough']);

export const speakerTypeSchema = z.enum(['persona', 'user', 'system']);

export const sentimentSchema = z.enum(['agree', 'disagree', 'partial', 'neutral', 'question']);

export const claimTypeSchema = z.enum(['assertion', 'question', 'proposal', 'objection']);

export const councilStatusSchema = z.enum(['active', 'paused', 'resolved']);

export const documentTypeSchema = z.enum(['text', 'pdf', 'image', 'data']);

// ============================================================================
// Predisposition Schema
// ============================================================================

export const predispositionSchema = z.object({
  systemPrompt: z.string().min(10, 'System prompt must be at least 10 characters'),
  stance: stanceSchema,
  arguesFor: z.string().optional(),
  arguesAgainst: z.string().optional(),
  traits: z.array(z.string()).min(1, 'At least one trait required'),
  interactionStyle: interactionStyleSchema,
  domain: z.string().optional(),
});

// ============================================================================
// Persona Schema
// ============================================================================

export const deliberationRoleSchema = z.enum(['manager', 'consultant', 'worker', 'reviewer']);

export const personaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, 'Name is required').max(50, 'Name too long'),
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  predisposition: predispositionSchema,
  avatar: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color'),
  temperature: z.number().min(0).max(1).optional(),
  verbosity: verbositySchema,
  muted: z.boolean().optional(),
  preferredDeliberationRole: deliberationRoleSchema.optional(),
  allowedServerIds: z.array(z.string()).optional(),
});

export const presetPersonaSchema = z.object({
  name: z.string().min(1),
  defaultProvider: z.string().min(1),
  defaultModel: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  avatar: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  verbosity: verbositySchema.optional(),
  predisposition: predispositionSchema,
});

// ============================================================================
// Document & Context Schemas
// ============================================================================

export const documentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: documentTypeSchema,
  content: z.string(),
});

export const sharedContextSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  documents: z.array(documentSchema).default([]),
  data: z.record(z.string(), z.unknown()).optional(),
  constraints: z.array(z.string()).optional(),
});

// ============================================================================
// Orchestration Schema
// ============================================================================

export const orchestrationConfigSchema = z.object({
  mode: councilModeSchema,
  turnStrategy: turnStrategySchema,
  maxTurnsPerRound: z.number().int().min(1).max(20).default(5),
  maxTotalTurns: z.number().int().min(1).max(100).optional(),
  autoSynthesize: z.boolean().default(true),
  synthesizerId: z.string().optional(),
  convergenceCriteria: z.string().optional(),
  requiresResolution: z.boolean().default(false),
});

// ============================================================================
// Message Schemas
// ============================================================================

export const claimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  type: claimTypeSchema,
  supportedBy: z.array(z.string().uuid()).optional(),
  opposedBy: z.array(z.string().uuid()).optional(),
});

export const councilMessageSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  speakerId: z.string(),
  speakerType: speakerTypeSchema,
  content: z.string().min(1),
  replyingTo: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  sentiment: sentimentSchema.optional(),
  stance: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  claims: z.array(claimSchema).optional(),
  tokensUsed: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
});

// ============================================================================
// Resolution Schema
// ============================================================================

export const resolutionSchema = z.object({
  summary: z.string().min(10),
  consensusLevel: z.number().min(0).max(1),
  keyDecisions: z.array(z.string()),
  agreements: z.array(z.string()).optional(),
  tensions: z.array(z.string()).optional(),
  dissent: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  generatedBy: z.string(),
});

// ============================================================================
// Council Schema
// ============================================================================

export const councilSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  topic: z.string().min(1),
  sharedContext: sharedContextSchema,
  personas: z.array(personaSchema).min(1, 'At least 1 persona required'),
  orchestration: orchestrationConfigSchema,
  messages: z.array(councilMessageSchema).default([]),
  status: councilStatusSchema,
  resolution: resolutionSchema.optional(),
  totalTokensUsed: z.number().int().min(0).default(0),
  estimatedCost: z.number().min(0).default(0),
  // Deliberation fields (optional, only when mode === 'deliberation')
  deliberation: z.lazy(() => deliberationConfigSchema).optional(),
  deliberationState: z.lazy(() => deliberationStateSchema).optional(),
  // Pipeline linkage (set when council was created by a pipeline step)
  pipelineId: z.string().optional(),
});

// ============================================================================
// Request Schemas
// ============================================================================

export const createCouncilRequestSchema = z.object({
  name: z.string().min(1).max(100),
  topic: z.string().min(5),
  sharedContext: sharedContextSchema.partial().optional(),
  personas: z.array(
    z.object({
      templateId: z.string().optional(),
    }).merge(personaSchema.partial())
  ).optional(),
  orchestration: orchestrationConfigSchema.partial().optional(),
});

export const addPersonaRequestSchema = z.object({
  templateId: z.string().optional(),
  persona: personaSchema.partial().optional(),
}).refine(
  (data) => data.templateId || data.persona,
  'Either templateId or persona must be provided'
);

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1),
  replyingTo: z.string().uuid().optional(),
});

export const askPersonaRequestSchema = z.object({
  personaId: z.string().uuid(),
  question: z.string().min(1),
});

export const debateRequestSchema = z.object({
  personaIds: z.tuple([z.string().uuid(), z.string().uuid()]),
  topic: z.string().optional(),
});

export const steelmanRequestSchema = z.object({
  askingPersonaId: z.string().uuid(),
  targetPersonaId: z.string().uuid(),
});

// ============================================================================
// Deliberation Schemas
// ============================================================================

export const ledgerEntryTypeSchema = z.enum([
  'problem_statement',
  'analysis',
  'proposal',
  'response',
  'context_acceptance',
  'context_rejection',
  'manager_question',
  'manager_redirect',
  'round_summary',
  'decision',
  'plan',
  'work_directive',
  'work_output',
  'review',
  'revision_request',
  're_deliberation',
  'cancellation',
  'error',
  'decomposition',
  'module_directive',
  'module_output',
  'code_review',
  'test_result',
  'debug_fix',
]);

export const deliberationPhaseSchema = z.enum([
  'created',
  'problem_framing',
  'round_independent',
  'round_interactive',
  'round_waiting_for_manager',
  'planning',
  'deciding',
  'directing',
  'executing',
  'reviewing',
  'revising',
  'decomposing',
  'implementing',
  'code_reviewing',
  'testing',
  'debugging',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);

export const artifactTypeSchema = z.enum([
  'context',
  'decision',
  'plan',
  'directive',
  'output',
]);

export const summaryModeSchema = z.enum([
  'manager',
  'automatic',
  'hybrid',
  'none',
]);

export const consultantErrorPolicySchema = z.enum(['retry', 'skip', 'fail']);

export const artifactRefSchema = z.object({
  artifactType: artifactTypeSchema,
  artifactId: z.string(),
  version: z.number().int().optional(),
});

export const contextArtifactSchema = z.object({
  id: z.string().uuid(),
  councilId: z.string().uuid(),
  version: z.number().int().min(1),
  content: z.string().min(1),
  createdFromVersion: z.number().int().optional(),
  changeSummary: z.string(),
  authorRole: deliberationRoleSchema,
  authorPersonaId: z.string().optional(),
  roundNumber: z.number().int().optional(),
  createdAt: z.string().datetime(),
});

export const decisionArtifactSchema = z.object({
  id: z.string().uuid(),
  councilId: z.string().uuid(),
  content: z.string().min(1),
  contextVersionAtDecision: z.number().int().min(1),
  acceptanceCriteria: z.string().optional(),
  createdAt: z.string().datetime(),
});

export const planArtifactSchema = z.object({
  id: z.string().uuid(),
  councilId: z.string().uuid(),
  content: z.string().min(1),
  decisionId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export const directiveArtifactSchema = z.object({
  id: z.string().uuid(),
  councilId: z.string().uuid(),
  content: z.string().min(1),
  decisionId: z.string().uuid(),
  planId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
});

export const outputArtifactSchema = z.object({
  id: z.string().uuid(),
  councilId: z.string().uuid(),
  content: z.string().min(1),
  directiveId: z.string().uuid(),
  version: z.number().int().min(1),
  isRevision: z.boolean(),
  previousOutputId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
});

export const contextPatchStatusSchema = z.enum(['pending', 'accepted', 'rejected']);

export const contextPatchSchema = z.object({
  id: z.string().uuid(),
  councilId: z.string().uuid(),
  targetContextId: z.string().uuid(),
  baseVersion: z.number().int().min(1),
  diff: z.string().min(1),
  rationale: z.string().min(1),
  authorPersonaId: z.string().uuid(),
  roundNumber: z.number().int().min(1),
  status: contextPatchStatusSchema,
  reviewedBy: z.string().uuid().optional(),
  reviewReason: z.string().optional(),
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
});

export const reviewOutcomeSchema = z.enum(['accept', 'revise', 're_deliberate']);

export const ledgerEntrySchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  authorRole: deliberationRoleSchema,
  authorPersonaId: z.string(),
  entryType: ledgerEntryTypeSchema,
  phase: deliberationPhaseSchema,
  roundNumber: z.number().int().optional(),
  content: z.string(),
  structured: z.record(z.string(), z.unknown()).optional(),
  artifactRefs: z.array(artifactRefSchema).optional(),
  referencedEntries: z.array(z.string().uuid()).optional(),
  reviewOutcome: reviewOutcomeSchema.optional(),
  tokensUsed: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0).optional(),
  error: z.string().optional(),
});

export const deliberationRoleAssignmentSchema = z.object({
  personaId: z.string().uuid(),
  role: deliberationRoleSchema,
  focusArea: z.string().optional(),
  stance: z.string().optional(),
  suppressPersona: z.boolean().optional(),
  writePermissions: z.boolean().optional(),
  allowedServerIds: z.array(z.string()).optional(),
  toolAccess: z.enum(['full', 'none']).optional(),
});

export const patchDecisionSchema = z.object({
  patchId: z.string().uuid(),
  accepted: z.boolean(),
  reason: z.string(),
});

export const managerEvaluationSchema = z.object({
  action: z.enum(['continue', 'decide', 'redirect']),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1).nullish().transform(v => v ?? undefined),
  missingInformation: z.array(z.string()).nullish().transform(v => v ?? undefined),
  question: z.string().nullish().transform(v => v ?? undefined),
  patchDecisions: z.array(patchDecisionSchema).nullish().transform(v => v ?? undefined),
});

export const managerReviewSchema = z.object({
  verdict: reviewOutcomeSchema,
  reasoning: z.string(),
  feedback: z.string().nullish().transform(v => v ?? undefined),
  newInformation: z.string().nullish().transform(v => v ?? undefined),
});

export const deliberationConfigSchema = z.object({
  enabled: z.boolean(),
  roleAssignments: z.array(deliberationRoleAssignmentSchema),
  minRounds: z.number().int().min(1).default(1),
  maxRounds: z.number().int().min(0).max(10).default(4),
  maxRevisions: z.number().int().min(0).max(10).default(3),
  decisionCriteria: z.array(z.string()).optional(),
  summaryMode: summaryModeSchema.default('manager'),
  summarizeAfterRound: z.number().int().min(1).default(2),
  contextTokenBudget: z.number().int().min(1000).default(80000),
  consultantErrorPolicy: consultantErrorPolicySchema.default('retry'),
  maxRetries: z.number().int().min(0).max(5).default(2),
  requirePlan: z.boolean().default(false),
  consultantExecution: z.enum(['parallel', 'sequential']).default('sequential'),
  workingDirectory: z.string().optional(),
  directoryConstrained: z.boolean().optional(),
  savedProblem: z.string().optional(),
  expectedOutput: z.string().optional(),
  saveDeliberation: z.boolean().optional(),
  saveDeliberationMode: z.enum(['full', 'abbreviated']).optional(),
  maxWordsPerResponse: z.number().optional(),
  stepType: z.enum(['council', 'code_planning', 'analysis', 'agent', 'coding', 'review', 'enrich']).optional(),
  testCommand: z.string().optional(),
  maxDebugCycles: z.number().int().optional(),
  maxReviewCycles: z.number().int().optional(),
  allowedServerIds: z.array(z.string()).optional(),
  bootstrapContext: z.boolean().optional(),
});

export const deliberationStateSchema = z.object({
  currentPhase: deliberationPhaseSchema,
  previousPhase: deliberationPhaseSchema.optional(),
  currentRound: z.number().int().min(0),
  roundRunId: z.string(),
  maxRounds: z.number().int().min(0),
  revisionCount: z.number().int().min(0),
  maxRevisions: z.number().int().min(0),
  roundSubmissions: z.record(z.string(), z.array(z.string())),
  roundSummaries: z.record(z.string(), z.string()),
  activeContextId: z.string(),
  activeContextVersion: z.number().int().min(0),
  pendingPatches: z.array(z.string()),
  managerLastEvaluation: managerEvaluationSchema.nullish().transform(v => v ?? undefined),
  finalDecisionId: z.string().nullish().transform(v => v ?? undefined),
  workDirectiveId: z.string().nullish().transform(v => v ?? undefined),
  currentOutputId: z.string().nullish().transform(v => v ?? undefined),
  reDeliberationCount: z.number().int().min(0).default(0).optional(),
  errorLog: z.array(z.string()),
  completionSummary: z.string().nullish().transform(v => v ?? undefined),
});

export const ledgerIndexSchema = z.object({
  councilId: z.string().uuid(),
  entryCount: z.number().int().min(0),
  chunkCount: z.number().int().min(0),
  chunkBoundaries: z.array(z.number().int()),
  totalTokens: z.number().int().min(0),
  lastUpdated: z.string().datetime(),
});

// Extended council schema with deliberation support
export const councilWithDeliberationSchema = councilSchema.extend({
  deliberation: deliberationConfigSchema.optional(),
  deliberationState: deliberationStateSchema.optional(),
});

// ============================================================================
// Type Exports
// ============================================================================

export type PredispositionInput = z.infer<typeof predispositionSchema>;
export type PersonaInput = z.infer<typeof personaSchema>;
export type CouncilInput = z.infer<typeof councilSchema>;
export type OrchestrationConfigInput = z.infer<typeof orchestrationConfigSchema>;
export type SharedContextInput = z.infer<typeof sharedContextSchema>;
export type CouncilMessageInput = z.infer<typeof councilMessageSchema>;
export type ResolutionInput = z.infer<typeof resolutionSchema>;

// Deliberation type exports
export type DeliberationRoleInput = z.infer<typeof deliberationRoleSchema>;
export type LedgerEntryTypeInput = z.infer<typeof ledgerEntryTypeSchema>;
export type DeliberationPhaseInput = z.infer<typeof deliberationPhaseSchema>;
export type ArtifactTypeInput = z.infer<typeof artifactTypeSchema>;
export type SummaryModeInput = z.infer<typeof summaryModeSchema>;
export type ContextArtifactInput = z.infer<typeof contextArtifactSchema>;
export type DecisionArtifactInput = z.infer<typeof decisionArtifactSchema>;
export type PlanArtifactInput = z.infer<typeof planArtifactSchema>;
export type DirectiveArtifactInput = z.infer<typeof directiveArtifactSchema>;
export type OutputArtifactInput = z.infer<typeof outputArtifactSchema>;
export type ContextPatchInput = z.infer<typeof contextPatchSchema>;
export type LedgerEntryInput = z.infer<typeof ledgerEntrySchema>;
export type DeliberationRoleAssignmentInput = z.infer<typeof deliberationRoleAssignmentSchema>;
export type ManagerEvaluationInput = z.infer<typeof managerEvaluationSchema>;
export type ManagerReviewInput = z.infer<typeof managerReviewSchema>;
export type DeliberationConfigInput = z.infer<typeof deliberationConfigSchema>;
export type DeliberationStateInput = z.infer<typeof deliberationStateSchema>;
export type LedgerIndexInput = z.infer<typeof ledgerIndexSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateCouncil(data: unknown) {
  return councilSchema.safeParse(data);
}

export function validatePersona(data: unknown) {
  return personaSchema.safeParse(data);
}

export function validateCreateCouncilRequest(data: unknown) {
  return createCouncilRequestSchema.safeParse(data);
}

export function validateAddPersonaRequest(data: unknown) {
  return addPersonaRequestSchema.safeParse(data);
}

/**
 * Validate and provide helpful error messages
 */
export function validateWithErrors<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; errors: string[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { success: false, errors };
}

// ============================================================================
// Deliberation Validation Helpers
// ============================================================================

export function validateDeliberationConfig(data: unknown) {
  return deliberationConfigSchema.safeParse(data);
}

export function validateDeliberationState(data: unknown) {
  return deliberationStateSchema.safeParse(data);
}

export function validateLedgerEntry(data: unknown) {
  return ledgerEntrySchema.safeParse(data);
}

export function validateContextArtifact(data: unknown) {
  return contextArtifactSchema.safeParse(data);
}

export function validateContextPatch(data: unknown) {
  return contextPatchSchema.safeParse(data);
}

export function validateManagerEvaluation(data: unknown) {
  return managerEvaluationSchema.safeParse(data);
}

export function validateManagerReview(data: unknown) {
  return managerReviewSchema.safeParse(data);
}

export function validateDeliberationRoleAssignment(data: unknown) {
  return deliberationRoleAssignmentSchema.safeParse(data);
}

export function validateCouncilWithDeliberation(data: unknown) {
  return councilWithDeliberationSchema.safeParse(data);
}
