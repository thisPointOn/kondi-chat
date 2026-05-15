/**
 * Council: Multi-Model Deliberation System
 * Core type definitions
 */

export type { ContextInspection } from './context-inspection';

// ============================================================================
// Persona Types
// ============================================================================

export interface Predisposition {
  /** Core identity prompt defining the persona's role and behavior */
  systemPrompt: string;

  /** The fundamental stance this persona takes */
  stance: 'advocate' | 'critic' | 'neutral' | 'wildcard';

  /** What this persona champions and argues for */
  arguesFor?: string;

  /** What this persona pushes back on */
  arguesAgainst?: string;

  /** Personality traits that guide behavior */
  traits: string[];

  /** How this persona engages with others */
  interactionStyle: 'debate' | 'build' | 'question' | 'synthesize' | 'review';

  /** Optional domain expertise */
  domain?: string;
}

export interface Persona {
  id: string;
  name: string;

  /** Which LLM provider powers this persona */
  provider: string;

  /** Model ID (e.g., "claude-opus-4", "gpt-4o") */
  model: string;

  /** The attitude/predisposition defining behavior */
  predisposition: Predisposition;

  /** Visual identity - URL or emoji */
  avatar?: string;

  /** Hex color for UI theming */
  color: string;

  /** Temperature 0-1, higher = more creative/random */
  temperature?: number;

  /** Response length preference */
  verbosity: 'concise' | 'balanced' | 'thorough';

  /** Whether this persona is currently muted */
  muted?: boolean;

  /** Preferred role in deliberation mode (optional hint) */
  preferredDeliberationRole?: 'manager' | 'consultant' | 'worker' | 'reviewer';

  /** MCP servers this persona can access (undefined = all servers) */
  allowedServerIds?: string[];
}

export interface PresetPersona {
  name: string;
  defaultProvider: string;
  defaultModel: string;
  color: string;
  avatar?: string;
  temperature?: number;
  verbosity?: 'concise' | 'balanced' | 'thorough';
  predisposition: Predisposition;
}

// ============================================================================
// Council Types
// ============================================================================

export interface Document {
  id: string;
  name: string;
  type: 'text' | 'pdf' | 'image' | 'data';
  content: string;
}

export interface SharedContext {
  /** Text description of the situation being discussed */
  description: string;

  /** Attached files/documents all personas can see */
  documents: Document[];

  /** Structured data available to all personas */
  data?: Record<string, unknown>;

  /** Constraints or requirements to consider */
  constraints?: string[];
}

export type CouncilMode =
  | 'debate'        // Personas argue opposing positions
  | 'build'         // Personas collaborate, adding to each other
  | 'review'        // One presents, others critique
  | 'synthesis'     // Each offers perspective, then combine
  | 'socratic'      // One questions, others defend
  | 'freeform'      // No structure, natural conversation
  | 'deliberation'; // Structured Manager → Consultants → Worker workflow

export type TurnStrategy =
  | 'round-robin'   // Each speaks in fixed order
  | 'react'         // Respond to previous speaker
  | 'popcorn'       // Speaker chooses next speaker
  | 'volunteer'     // Personas decide if they have something to add
  | 'moderator'     // User directs who speaks
  | 'parallel'      // All respond simultaneously
  | 'relevance';    // System picks most relevant voice

export interface OrchestrationConfig {
  /** Primary interaction pattern */
  mode: CouncilMode;

  /** How turns are allocated */
  turnStrategy: TurnStrategy;

  /** Max turns before synthesis/checkpoint */
  maxTurnsPerRound: number;

  /** Hard stop for total turns */
  maxTotalTurns?: number;

  /** Generate synthesis after each round */
  autoSynthesize: boolean;

  /** Which persona synthesizes (or "system") */
  synthesizerId?: string;

  /** Natural language criteria for convergence */
  convergenceCriteria?: string;

  /** Must end with clear decision/output */
  requiresResolution: boolean;
}

export interface Council {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;

  /** What's being discussed */
  topic: string;

  /** Shared context for all personas */
  sharedContext: SharedContext;

  /** Participating personas */
  personas: Persona[];

  /** How personas interact */
  orchestration: OrchestrationConfig;

  /** The conversation (used in non-deliberation modes) */
  messages: CouncilMessage[];

  /** Current state */
  status: 'active' | 'paused' | 'resolved';

  /** Final resolution if resolved */
  resolution?: Resolution;

  /** Usage metrics */
  totalTokensUsed: number;
  estimatedCost: number;

  /** Deliberation configuration (only when mode === 'deliberation') */
  deliberation?: DeliberationConfig;

  /** Runtime deliberation state (only when mode === 'deliberation') */
  deliberationState?: DeliberationState;

  /** Pipeline ID if this council was created by a pipeline step */
  pipelineId?: string;
}

// ============================================================================
// Message Types
// ============================================================================

export interface Claim {
  id: string;
  text: string;
  type: 'assertion' | 'question' | 'proposal' | 'objection';
  supportedBy?: string[];
  opposedBy?: string[];
}

export interface CouncilMessage {
  id: string;
  timestamp: string;

  /** Who said it - Persona ID, "user", or "system" */
  speakerId: string;
  speakerType: 'persona' | 'user' | 'system';

  /** Message content */
  content: string;

  /** Message being responded to */
  replyingTo?: string;

  /** For branched conversations */
  threadId?: string;

  /** Semantic metadata (can be LLM-generated) */
  sentiment?: 'agree' | 'disagree' | 'partial' | 'neutral' | 'question';

  /** Brief summary of position taken */
  stance?: string;

  /** How strongly held (0-1) */
  confidence?: number;

  /** Claims made in this message */
  claims?: Claim[];

  /** Token usage for this message */
  tokensUsed: number;

  /** Response latency */
  latencyMs: number;
}

export interface Resolution {
  /** Summary of the deliberation */
  summary: string;

  /** Consensus level 0-1 */
  consensusLevel: number;

  /** Key decisions reached */
  keyDecisions: string[];

  /** Areas of agreement */
  agreements?: string[];

  /** Key tensions identified */
  tensions?: string[];

  /** Unresolved disagreements */
  dissent?: string[];

  /** Recommended next steps */
  nextSteps?: string[];

  /** Who generated this resolution */
  generatedBy: string;
}

// ============================================================================
// Event Types
// ============================================================================

export type CouncilEvent =
  | { type: 'persona-added'; persona: Persona }
  | { type: 'persona-removed'; personaId: string }
  | { type: 'persona-muted'; personaId: string }
  | { type: 'persona-unmuted'; personaId: string }
  | { type: 'turn-started'; personaId: string }
  | { type: 'turn-chunk'; personaId: string; content: string }
  | { type: 'turn-completed'; message: CouncilMessage }
  | { type: 'synthesis-started'; synthesizerId: string }
  | { type: 'synthesis-generated'; resolution: Resolution }
  | { type: 'consensus-updated'; level: number }
  | { type: 'council-resolved'; resolution: Resolution }
  | { type: 'council-paused' }
  | { type: 'council-resumed' }
  | { type: 'error'; error: string };

// ============================================================================
// Cost Estimation Types
// ============================================================================

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface RoundCostEstimate {
  personas: Array<{
    personaId: string;
    personaName: string;
    estimate: CostEstimate;
  }>;
  synthesis?: CostEstimate;
  total: number;
}

// ============================================================================
// Turn Context Types
// ============================================================================

export interface TurnContext {
  /** Recent messages for context */
  recentMessages: CouncilMessage[];

  /** Current topic being discussed */
  currentTopic: string;

  /** Unanswered questions */
  openQuestions: string[];

  /** User's direction for this turn */
  speakerInstruction?: string;

  /** Previous speaker (for react strategy) */
  previousSpeaker?: Persona;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateCouncilRequest {
  name: string;
  topic: string;
  sharedContext?: Partial<SharedContext>;
  personas?: Array<Partial<Persona> & { templateId?: string }>;
  orchestration?: Partial<OrchestrationConfig>;
}

export interface AddPersonaRequest {
  templateId?: string;
  persona?: Partial<Persona>;
}

export interface SendMessageRequest {
  content: string;
  replyingTo?: string;
}

export interface AskPersonaRequest {
  personaId: string;
  question: string;
}

export interface DebateRequest {
  personaIds: [string, string];
  topic?: string;
}

export interface SteelmanRequest {
  askingPersonaId: string;
  targetPersonaId: string;
}

// ============================================================================
// UI State Types
// ============================================================================

export interface CouncilViewState {
  selectedPersonaId: string | null;
  isAddingPersona: boolean;
  isGeneratingTurn: boolean;
  isGeneratingSynthesis: boolean;
  showArgumentMap: boolean;
  showPositionSpectrum: boolean;
  streamingContent: Map<string, string>;
}

export interface PersonaPosition {
  personaId: string;
  position: number; // -1 to 1 on spectrum
  label: string;
  confidence: number;
}

export interface ArgumentNode {
  id: string;
  claimId: string;
  text: string;
  type: 'for' | 'against' | 'modify';
  personaId: string;
  children: ArgumentNode[];
}

export interface ArgumentMap {
  rootClaim: string;
  nodes: ArgumentNode[];
}

// ============================================================================
// Deliberation Types - Structured Multi-Agent Workflow
// ============================================================================

/**
 * Deliberation roles define behavior and authority.
 * Personas define style, model choice, and personality.
 * Both are assigned per session.
 */
export type DeliberationRole = 'manager' | 'consultant' | 'worker' | 'reviewer';

/**
 * Ledger entry types - structured messaging for audit trail
 */
export type LedgerEntryType =
  | 'problem_statement'       // Manager frames problem → creates Context v1
  | 'analysis'                // Consultant round 1 (independent)
  | 'proposal'                // Consultant proposes context change
  | 'response'                // Consultant round 2+ (engaging others, no context change)
  | 'context_acceptance'      // Manager accepts a context patch → new Context version
  | 'context_rejection'       // Manager rejects a context patch
  | 'manager_question'        // Manager injects question between rounds
  | 'manager_redirect'        // Manager refocuses discussion
  | 'round_summary'           // Progressive summarization
  | 'decision'                // Manager's final decision → Decision artifact
  | 'plan'                    // Optional execution plan → Plan artifact
  | 'work_directive'          // Concrete task for Worker → Directive artifact
  | 'work_output'             // Worker's deliverable → Output artifact
  | 'review'                  // Manager reviews output
  | 'revision_request'        // Manager sends back for revision
  | 're_deliberation'         // Manager requests re-deliberation with new info
  | 'cancellation'            // Workflow cancelled
  | 'error'                   // Agent invocation error
  // Coding orchestrator entry types
  | 'decomposition'           // Manager's module breakdown
  | 'module_directive'        // Per-module directive
  | 'module_output'           // Per-module worker output
  | 'code_review'             // Reviewer's findings
  | 'test_result'             // Test command output
  | 'debug_fix';              // Debugger's targeted fix

/**
 * Workflow phases - deterministic state machine
 */
export type DeliberationPhase =
  | 'created'                     // Workflow created, not started
  | 'problem_framing'             // Manager framing the problem
  | 'round_independent'           // Round 1: consultants working independently
  | 'round_interactive'           // Round 2+: consultants engaging with each other
  | 'round_waiting_for_manager'   // All consultants submitted, Manager evaluating
  | 'planning'                    // Optional: Manager writing execution plan
  | 'deciding'                    // Manager writing decision
  | 'directing'                   // Manager writing work directive
  | 'executing'                   // Worker executing
  | 'reviewing'                   // Manager reviewing output
  | 'revising'                    // Worker revising based on feedback
  // Coding orchestrator phases
  | 'decomposing'                 // Manager decomposes spec into modules
  | 'implementing'                // Workers implement modules in parallel
  | 'code_reviewing'              // Reviewer reviews all worker output
  | 'testing'                     // Running test command
  | 'debugging'                   // Debugger worker fixing test failures
  // Terminal states
  | 'paused'                      // User paused without losing state
  | 'completed'                   // Workflow done
  | 'cancelled'                   // User aborted
  | 'failed';                     // Unrecoverable error

/**
 * Artifact types - versioned objects referenced by ledger entries
 */
export type ArtifactType =
  | 'context'       // Shared understanding document
  | 'decision'      // Manager's decision with rationale
  | 'plan'          // Optional breakdown of how to execute
  | 'directive'     // Concrete task for Worker
  | 'output';       // Worker's deliverable

/**
 * Reference to an artifact from a ledger entry
 */
export interface ArtifactRef {
  artifactType: ArtifactType;
  artifactId: string;
  version?: number;
}

/**
 * Context artifact - the canonical shared understanding
 * Version 1 is always the Manager's problem statement.
 * Version 2+ result from accepted consultant proposals.
 */
export interface ContextArtifact {
  id: string;
  councilId: string;
  version: number;              // Increments on each accepted change
  content: string;              // The current shared context document

  createdFromVersion?: number;  // Which version this was derived from
  changeSummary: string;        // What changed in this version

  authorRole: DeliberationRole;
  authorPersonaId?: string;
  roundNumber?: number;

  createdAt: string;
}

/**
 * Decision artifact - Manager's final decision
 */
export interface DecisionArtifact {
  id: string;
  councilId: string;
  content: string;
  contextVersionAtDecision: number;  // Which context version this was made against
  acceptanceCriteria?: string;
  createdAt: string;
}

/**
 * Plan artifact - optional execution breakdown
 */
export interface PlanArtifact {
  id: string;
  councilId: string;
  content: string;
  decisionId: string;
  createdAt: string;
}

/**
 * Directive artifact - concrete task for Worker
 */
export interface DirectiveArtifact {
  id: string;
  councilId: string;
  content: string;
  decisionId: string;
  planId?: string;
  createdAt: string;
}

/**
 * Output artifact - Worker's deliverable
 */
export interface OutputArtifact {
  id: string;
  councilId: string;
  content: string;
  directiveId: string;
  version: number;              // For revisions
  isRevision: boolean;
  previousOutputId?: string;
  createdAt: string;
}

/**
 * Context patch - consultant proposal to change shared context
 * Consultants don't modify context directly; they propose changes.
 */
export interface ContextPatch {
  id: string;
  councilId: string;
  targetContextId: string;      // Which context artifact this patches
  baseVersion: number;          // The version this patch was written against

  diff: string;                 // What to change (structured or natural language)
  rationale: string;            // Why this change is needed

  authorPersonaId: string;
  roundNumber: number;

  status: 'pending' | 'accepted' | 'rejected';
  reviewedBy?: string;          // Manager persona ID
  reviewReason?: string;        // Why accepted/rejected

  createdAt: string;
  reviewedAt?: string;
}

/**
 * Ledger entry - append-only audit trail
 */
export interface LedgerEntry {
  id: string;
  timestamp: string;

  authorRole: DeliberationRole;
  authorPersonaId: string;

  entryType: LedgerEntryType;
  phase: DeliberationPhase;
  roundNumber?: number;

  content: string;                  // Human-readable text
  structured?: Record<string, unknown>; // Machine-parseable data

  artifactRefs?: ArtifactRef[];     // References to artifacts created/modified
  referencedEntries?: string[];     // IDs of prior entries this responds to

  reviewOutcome?: 'accept' | 'revise' | 're_deliberate';

  tokensUsed?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Role assignment - maps persona to deliberation role
 */
export interface DeliberationRoleAssignment {
  personaId: string;
  role: DeliberationRole;
  focusArea?: string;            // Consultant specialization (e.g., "security", "UX")
  stance?: string;               // Optional: Consultant's starting position or bias
  suppressPersona?: boolean;     // Default: true for Worker, false for others
  writePermissions?: boolean;    // Worker: allow disk write operations
  /** Per-role MCP server override (undefined = inherit from step/persona) */
  allowedServerIds?: string[];
  /** Override default tool behavior: 'full' = enable all tools, 'none' = disable tools */
  toolAccess?: 'full' | 'none';
}

/**
 * Manager's structured evaluation output
 */
export interface ManagerEvaluation {
  action: 'continue' | 'decide' | 'redirect';
  reasoning: string;
  confidence?: number;            // 0.0-1.0, optional self-assessment
  missingInformation?: string[];  // What's still unknown
  question?: string;              // For 'continue' or 'redirect'
  patchDecisions?: {              // Accept/reject pending context patches
    patchId: string;
    accepted: boolean;
    reason: string;
  }[];
}

/**
 * Manager's review verdict
 */
export interface ManagerReview {
  verdict: 'accept' | 'revise' | 're_deliberate';
  reasoning: string;
  feedback?: string;              // Specific revision instructions (if revise)
  newInformation?: string;        // What changed (if re_deliberate)
}

/**
 * Code reviewer's verdict on implementation quality
 */
export interface ReviewVerdict {
  verdict: 'pass' | 'needs_revision';
  issues: Array<{
    module: string;
    severity: 'critical' | 'major' | 'minor';
    description: string;
    suggestion: string;
  }>;
  summary: string;
}

/**
 * Summary mode for managing context window
 */
export type SummaryMode =
  | 'manager'     // Manager writes summary (API call, higher quality)
  | 'automatic'   // Orchestrator extracts key points mechanically (no API call)
  | 'hybrid'      // Automatic for early rounds, Manager for later rounds
  | 'none';       // No summarization, always full context

/**
 * Deliberation configuration
 */
export interface DeliberationConfig {
  enabled: boolean;

  roleAssignments: DeliberationRoleAssignment[];

  minRounds: number;               // Default: 1
  maxRounds: number;               // Default: 4
  maxRevisions: number;            // Default: 3

  // Working directory for execution
  workingDirectory?: string;       // Directory path for task execution
  directoryConstrained?: boolean;  // If true, constrain all file operations to this directory

  // Saved problem/question for deliberation (before starting)
  savedProblem?: string;

  // Expected output/deliverable description
  expectedOutput?: string;         // What the worker should produce at the end

  // Decision guidance — what should the Manager optimize for?
  decisionCriteria?: string[];     // e.g., ["technical feasibility", "security"]

  summaryMode: SummaryMode;        // Default: 'manager'
  summarizeAfterRound: number;     // Default: 2
  contextTokenBudget: number;      // Default: 80000

  consultantErrorPolicy: 'retry' | 'skip' | 'fail';  // Default: 'retry'
  maxRetries: number;              // Default: 2

  requirePlan: boolean;            // Default: false

  /**
   * How consultants execute during a round:
   * - 'parallel': All consultants receive same context, respond simultaneously
   * - 'sequential': Each consultant sees previous consultants' responses
   */
  consultantExecution: 'parallel' | 'sequential';  // Default: 'sequential'

  /** Whether to save deliberation output to .kondi/outputs */
  saveDeliberation?: boolean;

  /** Save mode: 'full' writes 3 files, 'abbreviated' writes 1 summary file */
  saveDeliberationMode?: 'full' | 'abbreviated';

  /** Soft word limit per response — guides LLM to be concise, does not truncate */
  maxWordsPerResponse?: number;

  // Pipeline step type (informs prompt behavior)
  stepType?: 'council' | 'code_planning' | 'analysis' | 'agent' | 'coding' | 'review' | 'enrich';

  // Coding orchestrator configuration
  testCommand?: string;
  maxDebugCycles?: number;     // default 5
  maxReviewCycles?: number;    // default 2

  /** MCP servers this step/council can access (undefined = all servers) */
  allowedServerIds?: string[];

  /** Whether to auto-scan workingDirectory for context bootstrapping */
  bootstrapContext?: boolean;

  /** Enable Anthropic prompt caching for bootstrap context (default: true) */
  enablePromptCaching?: boolean;

  /** Whether to append consultant findings and worker results to the shared context document.
   *  When true, context evolves through the deliberation (v1 → v2 → v3...).
   *  When false (default), context stays at v1 and findings only live in the ledger. */
  evolveContext?: boolean;
}

/**
 * Deliberation state - runtime workflow state
 */
export interface DeliberationState {
  currentPhase: DeliberationPhase;
  previousPhase?: DeliberationPhase;  // For pause/resume
  currentRound: number;
  roundRunId: string;                 // Unique ID per round execution

  maxRounds: number;
  revisionCount: number;
  maxRevisions: number;

  roundSubmissions: Record<number, string[]>;  // round → persona IDs that submitted
  roundSummaries: Record<number, string>;

  activeContextId: string;            // Current context artifact ID
  activeContextVersion: number;       // Current context version number
  pendingPatches: string[];           // IDs of unreviewed context patches

  managerLastEvaluation?: ManagerEvaluation;

  finalDecisionId?: string;           // Decision artifact ID
  workDirectiveId?: string;           // Directive artifact ID
  currentOutputId?: string;           // Current output artifact ID

  reDeliberationCount?: number;

  errorLog: string[];

  /** Summary generated on completion for the Decision panel */
  completionSummary?: string;

  // Coding orchestrator state
  moduleDecomposition?: {
    modules: Array<{
      name: string;
      files: string[];
      interfaces: string;
      dependencies: string[];
      directive: string;
      assignedWorkerId?: string;
    }>;
    integrationNotes: string;
    testStrategy: string;
    buildCommand?: string;
    installCommand?: string;
  };
  moduleOutputs?: Record<string, string>;  // moduleName -> output content
  debugCycleCount?: number;
  reviewCycleCount?: number;
}

/**
 * Ledger index for chunked storage
 */
export interface LedgerIndex {
  councilId: string;
  entryCount: number;
  chunkCount: number;
  chunkBoundaries: number[];        // Entry indices where chunks start
  totalTokens: number;
  lastUpdated: string;
}

// ============================================================================
// Deliberation Events
// ============================================================================

export type DeliberationEvent =
  | { type: 'phase-changed'; from: DeliberationPhase; to: DeliberationPhase }
  | { type: 'round-started'; round: number }
  | { type: 'round-completed'; round: number }
  | { type: 'consultant-submitted'; personaId: string; round: number }
  | { type: 'context-updated'; version: number }
  | { type: 'patch-proposed'; patchId: string; authorId: string }
  | { type: 'patch-reviewed'; patchId: string; accepted: boolean }
  | { type: 'decision-made'; decisionId: string }
  | { type: 'directive-issued'; directiveId: string }
  | { type: 'work-submitted'; outputId: string }
  | { type: 'review-completed'; verdict: string }
  | { type: 'deliberation-completed'; councilId: string }
  | { type: 'deliberation-cancelled'; councilId: string }
  | { type: 'deliberation-failed'; councilId: string; error: string }
  | { type: 'deliberation-paused'; councilId: string }
  | { type: 'deliberation-resumed'; councilId: string };

// ============================================================================
// Extended Council Type for Deliberation
// ============================================================================

/**
 * Extended Council interface with deliberation support
 */
export interface CouncilWithDeliberation extends Council {
  /** Deliberation configuration (only when mode === 'deliberation') */
  deliberation?: DeliberationConfig;

  /** Runtime deliberation state */
  deliberationState?: DeliberationState;
}
