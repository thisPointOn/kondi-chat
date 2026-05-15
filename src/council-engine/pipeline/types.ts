/**
 * Pipeline System: Type Definitions
 * Councils as Workflow Steps — ordered stages with parallel steps
 */

// ============================================================================
// Step & Pipeline Status
// ============================================================================

/** All pipeline step types. Gate, script, and condition are non-council types. */
export const PIPELINE_STEP_TYPES = ['council', 'code_planning', 'analysis', 'agent', 'coding', 'review', 'enrich', 'gate', 'script', 'condition'] as const;
export type PipelineStepType = (typeof PIPELINE_STEP_TYPES)[number];

/** Council-based step types (excludes gate, script, condition). */
export const COUNCIL_STEP_TYPES = ['council', 'code_planning', 'analysis', 'agent', 'coding', 'review', 'enrich'] as const;
export type CouncilStepType = (typeof COUNCIL_STEP_TYPES)[number];

/** Human-readable labels for each step type */
export const STEP_TYPE_LABELS: Record<PipelineStepType, string> = {
  council: 'Council',
  code_planning: 'Code Planning',
  analysis: 'Analysis',
  agent: 'Agent',
  coding: 'Coding',
  review: 'Review',
  enrich: 'Enrich',
  gate: 'Gate',
  script: 'Script',
  condition: 'Condition',
};

/** What kind of data a step produces for downstream consumption */
export type OutputType = 'string' | 'file' | 'directory' | 'json';

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';

export type PipelineStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused';

// ============================================================================
// Step Artifacts (output produced by a completed step)
// ============================================================================

export interface StepArtifact {
  stepId: string;
  content: string;
  artifactType: 'decision' | 'output' | 'llm_response' | 'approval';
  metadata?: {
    councilId?: string;
    decisionId?: string;
    outputId?: string;
    model?: string;
    tokensUsed?: number;
    outputPath?: string;   // file path where output was saved (planning/coding steps)
    outputType?: OutputType; // what kind of data this artifact represents
    stepName?: string;     // human-readable name of the producing step
    stepType?: string;     // PipelineStepType value
  };
  createdAt: string;
}

// ============================================================================
// Memory Entry (persistent across scheduled runs)
// ============================================================================

export interface MemoryEntry {
  runNumber: number;
  runDate: string;
  /** Captured artifacts from designated steps, keyed by sanitized step name */
  captures: Record<string, string>;
  /** True if this entry is a compressed summary of multiple older entries */
  compressed?: boolean;
}

// ============================================================================
// Output Isolation Config
// ============================================================================

export interface PipelineOutputConfig {
  /** Enable structured output directories (default: true for new pipelines) */
  enabled: boolean;
  /** Max runs to keep on disk before pruning oldest (default: 50, 0 = unlimited) */
  maxRetainedRuns?: number;
  /** What to save per step */
  stepOutput: 'artifact_only' | 'artifact_and_deliberation';
}

/** Run manifest written to _manifest.json */
export interface RunManifest {
  runNumber: number;
  pipelineId: string;
  pipelineName: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  initialInput: string;
  stageCount: number;
  stepCount: number;
  totalTokens: number;
  totalDurationMs: number;
  /** Whether memory was updated from this run */
  memoryUpdated: boolean;
}

/** Step metadata written to _meta.json */
export interface StepMeta {
  stepId: string;
  stepName: string;
  stepType: string;
  stageIndex: number;
  stepIndex: number;
  startedAt?: string;
  completedAt?: string;
  status: PipelineStepStatus;
  outputType: OutputType;
  councilId?: string;
  model?: string;
  tokensUsed?: number;
  durationMs?: number;
}

// ============================================================================
// Pipeline Persona (full-featured, matches council persona capabilities)
// ============================================================================

export interface PipelinePersona {
  templateId?: string;
  name: string;
  role: 'manager' | 'consultant' | 'worker' | 'reviewer';
  model: string;
  provider: string;
  avatar?: string;
  color?: string;
  systemPrompt?: string;
  stance?: 'advocate' | 'critic' | 'neutral' | 'wildcard';
  traits?: string[];
  interactionStyle?: 'debate' | 'build' | 'question' | 'synthesize' | 'review';
  domain?: string;
  temperature?: number;
  verbosity?: 'concise' | 'balanced' | 'thorough';
  focusArea?: string;
  startingStance?: string;
  suppressPersona?: boolean;
  /** Worker-only: save the worker's output to the working directory (default: true) */
  saveOutput?: boolean;
  /** MCP servers this persona can access (undefined = all servers) */
  allowedServerIds?: string[];
  /** Override default tool behavior: 'full' = enable all tools, 'none' = disable tools */
  toolAccess?: 'full' | 'none';
}

// ============================================================================
// Step Configs
// ============================================================================

export interface CouncilStepConfig {
  type: CouncilStepType;
  councilSetup: {
    name: string;
    personas: PipelinePersona[];
    maxRounds?: number;
    maxRevisions?: number;
    expectedOutput?: string;
    decisionCriteria?: string[];
    workingDirectory?: string;
    directoryConstrained?: boolean;
    // Coding orchestrator config
    testCommand?: string;
    maxDebugCycles?: number;
    maxReviewCycles?: number;
    /** MCP servers this step can access (undefined = all servers) */
    allowedServerIds?: string[];
  };
  /** Standing instructions — what this step should DO (supplemental to input context) */
  task?: string;
  /** Template that renders previous step outputs as input context */
  inputTemplate: string;
  /** What kind of data this step produces (default: 'string') */
  outputType?: OutputType;
  /** Include pipeline's initial input as additional context, regardless of stage */
  includePipelineInput?: boolean;
}

export interface LlmStepConfig {
  type: 'analysis' | 'agent';
  model: string;
  provider: string;
  systemPrompt: string;
  inputTemplate: string;
  workingDirectory?: string;
  directoryConstrained?: boolean;
  /** MCP servers this step can access (undefined = all servers) */
  allowedServerIds?: string[];
}

export interface GateStepConfig {
  type: 'gate';
  approvalPrompt: string;
}

export interface ScriptStepConfig {
  type: 'script';
  /** Shell command to execute. Previous step output available as $KONDI_INPUT env var. */
  command: string;
  /** Template that renders previous step outputs into the $KONDI_INPUT env var */
  inputTemplate: string;
  /** What kind of data this step produces (default: 'string') */
  outputType?: OutputType;
  /** Include pipeline's initial input as additional context, regardless of stage */
  includePipelineInput?: boolean;
}

export type ConditionMode = 'contains' | 'regex' | 'equals';
export type ConditionAction = 'continue' | 'skip_next_stage' | 'stop';

export interface ConditionStepConfig {
  type: 'condition';
  /** The expression to match against (string literal, regex pattern, or exact match) */
  expression: string;
  /** How to evaluate the expression against input */
  mode: ConditionMode;
  /** Template that renders previous step outputs as input to evaluate */
  inputTemplate: string;
  /** Action when expression matches */
  trueAction: ConditionAction;
  /** Action when expression does not match */
  falseAction: ConditionAction;
  /** Include pipeline's initial input as additional context, regardless of stage */
  includePipelineInput?: boolean;
}

export type StepConfig = CouncilStepConfig | LlmStepConfig | GateStepConfig | ScriptStepConfig | ConditionStepConfig;

/** Helper: is this a council-based step type? Excludes gate, script, and condition. */
export function isCouncilType(type: PipelineStepType): boolean {
  return type !== 'gate' && type !== 'script' && type !== 'condition';
}

/** Helper: is this a lightweight council (single-agent, 0-round)? */
export function isLightweightCouncilType(type: PipelineStepType): boolean {
  return type === 'analysis' || type === 'agent';
}

/**
 * @deprecated Use isLightweightCouncilType instead.
 * Kept for backwards compatibility with existing code.
 */
export function isLlmType(type: PipelineStepType): boolean {
  return type === 'analysis' || type === 'agent';
}

/**
 * Migrate legacy LlmStepConfig to CouncilStepConfig.
 * Old pipelines may have { type: 'analysis'|'agent', model, provider, systemPrompt, ... }
 * without a councilSetup. This creates one from the flat fields.
 */
export function migrateLlmConfig(config: LlmStepConfig): CouncilStepConfig {
  const isAnalysis = config.type === 'analysis';
  return {
    type: config.type,
    councilSetup: {
      name: isAnalysis ? 'Analysis' : 'Agent',
      personas: [{
        name: isAnalysis ? 'Analyst' : 'Executor',
        role: isAnalysis ? 'manager' : 'worker',
        model: config.model,
        provider: config.provider,
        systemPrompt: config.systemPrompt,
        suppressPersona: true,
      }],
      maxRounds: 0,
      maxRevisions: 0,
      workingDirectory: config.workingDirectory,
      directoryConstrained: config.directoryConstrained,
      allowedServerIds: config.allowedServerIds,
    },
    inputTemplate: config.inputTemplate,
    outputType: 'string',
  };
}

// ============================================================================
// Pipeline Step
// ============================================================================

export interface PipelineStep {
  id: string;
  name: string;
  description?: string;
  config: StepConfig;
  status: PipelineStepStatus;
  artifact?: StepArtifact;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================================================
// Pipeline Stage
// ============================================================================

export interface PipelineStage {
  id: string;
  name: string;
  steps: PipelineStep[];
  /** How steps in this stage are executed (default: 'sequential') */
  executionMode?: 'sequential' | 'parallel';
}

// ============================================================================
// Pipeline
// ============================================================================

// ============================================================================
// Schedule Config
// ============================================================================

export interface PipelineSchedule {
  enabled: boolean;
  /** Time of day in HH:MM (24-hour) format */
  time: string;
  /** Recurrence mode */
  mode: 'once' | 'daily' | 'weekly';
  /** For 'once' mode: ISO date string (YYYY-MM-DD) */
  date?: string;
  /** For 'weekly' mode: 0 = Sunday, 1 = Monday, ... 6 = Saturday */
  dayOfWeek?: number;
  /** ISO timestamp of the last scheduled run (to avoid double-fires) */
  lastRunAt?: string;
  /** Maintain memory across scheduled runs */
  maintainMemory?: boolean;
  /** Max detailed entries before older ones get compressed (default: 30) */
  maxDetailedEntries?: number;
  /** Which steps' artifacts to capture into memory (step IDs).
   *  If empty/undefined, captures only the last completed step. */
  captureStepIds?: string[];
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  initialInput: string;
  stages: PipelineStage[];
  settings: {
    workingDirectory?: string;
    directoryConstrained?: boolean;
    failurePolicy: 'stop' | 'skip_step';
    schedule?: PipelineSchedule;
    outputConfig?: PipelineOutputConfig;
  };
  status: PipelineStatus;
  currentStageIndex: number;
  createdAt: string;
  updatedAt: string;
  /** Where this pipeline was executed — 'cli' for CLI-imported sessions */
  source?: 'cli' | 'gui';
}

// ============================================================================
// CLI ↔ GUI Session Export/Import
// ============================================================================

export interface KondiSessionCouncilData {
  ledgerIndex: any;
  ledgerChunks: Record<number, any[]>;
  context: any | null;
  contextHistory: any[];
  contextPatches: any[];
  decision: any | null;
  plan: any | null;
  directive: any | null;
  outputs: any[];
}

export interface KondiSession {
  version: 1;
  exportedAt: string;
  source: 'cli';
  pipeline: Pipeline;
  councils: any[];
  councilData: Record<string, KondiSessionCouncilData>;
  execution: {
    status: 'completed' | 'failed';
    startedAt: string;
    completedAt: string;
    durationMs: number;
    workingDirectory: string;
  };
}
