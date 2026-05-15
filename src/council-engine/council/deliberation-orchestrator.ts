/**
 * Council: Deliberation Orchestrator
 * Deterministic state machine for structured multi-agent deliberation
 *
 * The orchestrator is CODE, not an agent. It:
 * - Drives the state machine
 * - Invokes agents with correct context
 * - Manages artifacts and ledger
 * - Enforces invariants
 */

import type {
  Council,
  Persona,
  LedgerEntry,
  LedgerEntryType,
  DeliberationPhase,
  DeliberationRole,
  DeliberationRoleAssignment,
  ManagerEvaluation,
  ManagerReview,
  ContextArtifact,
  ContextPatch,
  ArtifactRef,
} from './types';

import {
  ledgerStore,
  getEntries,
  getAllEntries,
  getLatestOfType,
  getEntriesForRound,
  getManagerNotes,
  getLedgerTokenCount,
  formatEntriesForContext,
  buildMechanicalSummary,
} from './ledger-store';

import {
  getCurrentContext,
  getContextHistory,
  createInitialContext,
  createContextVersion,
  getPendingPatches,
  createPatch,
  acceptPatch,
  rejectPatch,
  createDecision,
  createPlan,
  createDirective,
  createOutput,
  createRevisionOutput,
  getDecision,
  getPlan,
  getDirective,
  getLatestOutput,
} from './context-store';

import {
  councilStore,
  getPersonaByRole,
  getRoleAssignment,
  isDeliberationMode,
} from './store';

import { bootstrapDirectoryContext } from './context-bootstrap';
import { buildContextInspection } from './context-inspection';
import type { ContextInspection } from './types';

import {
  buildManagerFramingPrompt,
  buildManagerEvaluationPrompt,
  buildManagerDecisionPrompt,
  buildManagerForcedDecisionPrompt,
  buildManagerPlanPrompt,
  buildWorkDirectivePrompt,
  buildManagerReviewPrompt,
  buildManagerRoundSummaryPrompt,
  buildIndependentAnalysisPrompt,
  buildDeliberationResponsePrompt,
  buildConsultantFinalPositionPrompt,
  buildConsultantReviewPrompt,
  buildWorkerExecutionPrompt,
  buildWorkerRevisionPrompt,
  getMinimalWorkerSystemPrompt,
  type WorkerPermissions,
} from './prompts';

// ============================================================================
// Types
// ============================================================================

export interface AgentInvocation {
  personaId: string;
  systemPrompt: string;
  userMessage: string;
  /** When true, the invoker should NOT pass MCP tools (avoids slow MCP connections) */
  skipTools?: boolean;
  /** Restrict to specific tool names (e.g. ['Read', 'Write', 'Bash']) */
  allowedTools?: string[];
  /** MCP servers this invocation can access (undefined = all servers) */
  allowedServerIds?: string[];
  /** Working directory override for local tool calls (bypasses singleton) */
  workingDirectory?: string;
  /** Timeout in ms — set by invokeAgentSafe based on role/context defaults */
  timeoutMs?: number;
  /** Cacheable context (e.g., bootstrap directory scan) for Anthropic prompt caching */
  cacheableContext?: string;
}

export interface AgentResponse {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  structured?: Record<string, unknown>;
}

export type AgentInvoker = (invocation: AgentInvocation, persona: Persona) => Promise<AgentResponse>;

export interface OrchestratorConfig {
  invokeAgent: AgentInvoker;
  onPhaseChange?: (from: DeliberationPhase, to: DeliberationPhase) => void;
  onEntryAdded?: (entry: LedgerEntry) => void;
  onError?: (error: Error, context: string) => void;
  /** Called when a persona starts thinking (startedAt = Date.now() timestamp, prompt = user message sent) */
  onAgentThinkingStart?: (persona: Persona, startedAt: number, prompt?: string) => void;
  /** Called when a persona finishes thinking */
  onAgentThinkingEnd?: (persona: Persona) => void;
  /** Called when an agent times out (before retry). Enables UI timeout warnings. */
  onAgentTimeout?: (persona: Persona, context: string, elapsedMs: number) => void;
}

// ============================================================================
// Phase Transition Table
// ============================================================================

const PHASE_TRANSITIONS: Record<DeliberationPhase, {
  validNext: DeliberationPhase[];
  terminal: boolean;
}> = {
  created: { validNext: ['problem_framing', 'executing'], terminal: false },
  problem_framing: { validNext: ['round_independent', 'deciding'], terminal: false },
  round_independent: { validNext: ['round_waiting_for_manager'], terminal: false },
  round_interactive: { validNext: ['round_waiting_for_manager'], terminal: false },
  round_waiting_for_manager: { validNext: ['round_interactive', 'deciding', 'planning'], terminal: false },
  planning: { validNext: ['directing'], terminal: false },
  deciding: { validNext: ['planning', 'directing', 'completed'], terminal: false },
  directing: { validNext: ['executing'], terminal: false },
  executing: { validNext: ['reviewing', 'completed'], terminal: false },
  reviewing: { validNext: ['completed', 'revising', 'round_interactive'], terminal: false },
  revising: { validNext: ['reviewing', 'completed'], terminal: false },
  decomposing: { validNext: [], terminal: false },
  implementing: { validNext: [], terminal: false },
  code_reviewing: { validNext: [], terminal: false },
  testing: { validNext: [], terminal: false },
  debugging: { validNext: [], terminal: false },
  paused: { validNext: ['created', 'problem_framing', 'round_independent', 'round_interactive', 'round_waiting_for_manager', 'planning', 'deciding', 'directing', 'executing', 'reviewing', 'revising', 'decomposing', 'implementing', 'code_reviewing', 'testing', 'debugging'], terminal: false },
  completed: { validNext: [], terminal: true },
  cancelled: { validNext: [], terminal: true },
  failed: { validNext: [], terminal: true },
};

// ============================================================================
// Deliberation Orchestrator
// ============================================================================

export class DeliberationOrchestrator {
  private config: OrchestratorConfig;
  private activeCouncilId: string | null = null;
  /** Bootstrapped directory context — shared with all personas via prompt */
  private bootstrappedContext: string = '';

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  // ==========================================================================
  // Auto-Run: Full Deliberation Loop
  // ==========================================================================

  /**
   * Run the full deliberation automatically from start to completion.
   * Frames the problem then hands off to continueDeliberation.
   */
  async runFullDeliberation(council: Council, rawProblem: string): Promise<void> {
    const deliberationStart = Date.now();
    console.log('[Orchestrator] Starting full deliberation...');
    this.activeCouncilId = council.id;

    // Always read fresh from store to avoid stale React state
    council = councilStore.get(council.id) || council;

    // Pre-flight check: log role assignments and personas for debugging
    const roleAssignments = council.deliberation?.roleAssignments || [];
    const consultantAssignments = roleAssignments.filter(r => r.role === 'consultant');
    const managerAssignments = roleAssignments.filter(r => r.role === 'manager');
    const workerAssignments = roleAssignments.filter(r => r.role === 'worker');

    console.log('[Orchestrator] PRE-FLIGHT CHECK:', {
      totalPersonas: council.personas.length,
      personaNames: council.personas.map(p => `${p.name} (${p.id.slice(0, 8)})`),
      totalRoleAssignments: roleAssignments.length,
      roleBreakdown: {
        managers: managerAssignments.length,
        consultants: consultantAssignments.length,
        workers: workerAssignments.length,
      },
      consultantDetails: consultantAssignments.map(r => {
        const p = council.personas.find(p => p.id === r.personaId);
        return `${p?.name || 'MISSING'} (${r.personaId.slice(0, 8)})`;
      }),
      // Check for personas without role assignments
      unassignedPersonas: council.personas
        .filter(p => !roleAssignments.some(r => r.personaId === p.id))
        .map(p => `${p.name} (${p.id.slice(0, 8)})`),
      // Check for role assignments without matching personas
      orphanedAssignments: roleAssignments
        .filter(r => !council.personas.some(p => p.id === r.personaId))
        .map(r => `${r.role}:${r.personaId.slice(0, 8)}`),
    });

    if (consultantAssignments.length < 2 && consultantAssignments.length > 0) {
      console.warn(`[Orchestrator] WARNING: Only ${consultantAssignments.length} consultant(s) found. ` +
        `If you expected more, check role assignments in Setup.`);
    }

    // Auto-repair: ensure every persona has a role assignment
    const unassigned = council.personas.filter(
      p => !roleAssignments.some(r => r.personaId === p.id)
    );
    if (unassigned.length > 0) {
      console.warn(`[Orchestrator] REPAIRING: ${unassigned.length} persona(s) without role assignments:`,
        unassigned.map(p => p.name));
      const repairedAssignments = [
        ...roleAssignments,
        ...unassigned.map(p => ({
          personaId: p.id,
          role: (p.preferredDeliberationRole || 'consultant') as 'manager' | 'consultant' | 'worker',
        })),
      ];
      councilStore.setRoleAssignments(council.id, repairedAssignments);
      // Re-fetch council with repaired assignments
      council = councilStore.get(council.id)!;
    }

    // Special path: 0 managers → direct execution (worker-only council)
    if (managerAssignments.length === 0) {
      console.log('[Orchestrator] No manager — running direct execution path');
      await this.runDirectExecution(council, rawProblem);
      return;
    }

    // Lightweight council types (agent/analysis): skip full deliberation,
    // go straight to worker execution. The manager's system prompt is folded into
    // the worker's context so its guidance isn't lost.
    const stepType = council.deliberation?.stepType;
    if (stepType === 'agent' || stepType === 'analysis') {
      console.log(`[Orchestrator] Lightweight step type '${stepType}' — running direct execution path`);
      await this.runDirectExecution(council, rawProblem);
      return;
    }

    // Phase 1: Frame the problem
    const t0 = Date.now();
    await this.frameProblem(council, rawProblem);
    console.log(`[Orchestrator:Timing] frameProblem took ${((Date.now() - t0) / 1000).toFixed(1)}s (elapsed: ${((Date.now() - deliberationStart) / 1000).toFixed(0)}s)`);

    // Continue through all remaining phases automatically
    await this.continueDeliberation(council.id, deliberationStart);
  }

  /**
   * Continue deliberation from whatever phase it's currently in.
   * Used after initial start (runFullDeliberation) and after resume from pause.
   * Runs fully automatically — no manual step-by-step buttons needed.
   */
  async continueDeliberation(councilId: string, startTime?: number): Promise<void> {
    this.activeCouncilId = councilId;
    const elapsed = () => startTime ? ` (elapsed: ${((Date.now() - startTime) / 1000).toFixed(0)}s)` : '';
    let council = councilStore.get(councilId)!;

    // Phase 2: Deliberation rounds
    const maxRounds = council.deliberation?.maxRounds || 4;

    // Run rounds until manager decides or max rounds reached
    let loopGuard = 0;
    const maxLoopIterations = maxRounds * 3 + 10; // Safety limit

    while (loopGuard++ < maxLoopIterations) {
      council = councilStore.get(councilId)!;
      const phase = council.deliberationState?.currentPhase;

      // Stop on pause or terminal states
      if (phase === 'paused') {
        console.log('[Orchestrator] Deliberation paused — stopping auto-run');
        return;
      }
      if (phase === 'deciding' || phase === 'planning' || phase === 'directing' ||
          phase === 'executing' || phase === 'reviewing' || phase === 'revising' ||
          phase === 'completed' || phase === 'cancelled' || phase === 'failed') {
        break; // Move past deliberation rounds
      }

      try {
        const phaseStart = Date.now();
        if (phase === 'round_independent') {
          console.log(`[Orchestrator] Running independent round...`);
          await this.runIndependentRound(council);
          console.log(`[Orchestrator:Timing] round_independent took ${((Date.now() - phaseStart) / 1000).toFixed(1)}s${elapsed()}`);
          // Fallback: if phase didn't advance (isRoundComplete returned false), force it
          const afterPhase = councilStore.get(councilId)?.deliberationState?.currentPhase;
          if (afterPhase === 'round_independent') {
            console.warn('[Orchestrator] Round did not advance after independent round — forcing transition');
            this.transitionPhase(councilId, 'round_waiting_for_manager');
          }
        } else if (phase === 'round_waiting_for_manager') {
          console.log('[Orchestrator] Manager evaluating...');
          await this.managerEvaluate(council);
          console.log(`[Orchestrator:Timing] managerEvaluate took ${((Date.now() - phaseStart) / 1000).toFixed(1)}s${elapsed()}`);
        } else if (phase === 'round_interactive') {
          console.log('[Orchestrator] Running interactive round...');
          await this.runInteractiveRound(council);
          console.log(`[Orchestrator:Timing] round_interactive took ${((Date.now() - phaseStart) / 1000).toFixed(1)}s${elapsed()}`);
          // Fallback: if phase didn't advance, force it
          const afterPhase = councilStore.get(councilId)?.deliberationState?.currentPhase;
          if (afterPhase === 'round_interactive') {
            console.warn('[Orchestrator] Round did not advance after interactive round — forcing transition');
            this.transitionPhase(councilId, 'round_waiting_for_manager');
          }
        } else {
          console.log(`[Orchestrator] Unexpected phase during deliberation: ${phase}`);
          break;
        }
      } catch (error) {
        const errMsg = (error as Error).message || String(error);
        const isRateLimit = /\b(429|rate.limit|too many requests)\b/i.test(errMsg);

        if (isRateLimit) {
          // Rate limit during deliberation round — wait and retry this iteration
          const delayMs = 120_000; // 2 minutes
          console.warn(
            `[Orchestrator] Rate limit during ${phase}, waiting ${Math.round(delayMs / 1000)}s before retrying...`
          );
          this.createEntry(
            councilId, 'manager', this.getManager(council).id,
            'error', phase || 'failed',
            `Rate limited during ${phase} — waiting ${Math.round(delayMs / 1000)}s before retrying...`,
            0, 0, undefined, council.deliberationState?.currentRound
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
          loopGuard--; // don't count this as a loop iteration
          continue; // retry the same phase
        }

        console.error(`[Orchestrator] Error during phase ${phase}:`, errMsg);

        // Record the error as a ledger entry — attribute to the phase's active role
        const isConsultantPhase = phase === 'round_independent' || phase === 'round_interactive';
        const role = isConsultantPhase ? 'consultant' : 'manager';
        const fallbackPersona = isConsultantPhase
          ? (council.personas.find(p => p.preferredDeliberationRole === 'consultant') || this.getManager(council))
          : this.getManager(council);
        this.createEntry(
          councilId,
          role,
          fallbackPersona.id,
          'error',
          phase || 'failed',
          `Deliberation error during ${phase}: ${errMsg}`,
          0, 0, undefined,
          council.deliberationState?.currentRound
        );

        // Transition to failed state so UI reflects the problem
        this.transitionPhase(councilId, 'failed');
        throw error; // Re-throw so caller can handle
      }
    }

    // Phase 3: Decision + Plan + Directive + Execution
    // Wrapped with phase-level rate-limit retry: if a phase fails due to
    // rate limiting (after invokeAgentSafe's own 5 retries are exhausted),
    // we wait and retry from the current phase instead of failing the council.
    const PHASE_RETRY_MAX = 3;
    const PHASE_RETRY_BASE_MS = 120_000; // 2 minutes

    for (let phaseAttempt = 0; phaseAttempt <= PHASE_RETRY_MAX; phaseAttempt++) {
    try {
      council = councilStore.get(councilId)!;
      let phase = council.deliberationState?.currentPhase;

      // If still in round phases after max iterations, force to deciding
      if (phase === 'round_waiting_for_manager' || phase === 'round_interactive' || phase === 'round_independent') {
        console.log('[Orchestrator] Max rounds exhausted, forcing decision phase');
        this.transitionPhase(councilId, 'deciding');
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      if (phase === 'paused' || phase === 'failed') return;

      if (phase === 'deciding') {
        const t = Date.now();
        console.log('[Orchestrator] Making decision...');
        await this.makeDecision(council);
        console.log(`[Orchestrator:Timing] makeDecision took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      if (phase === 'paused' || phase === 'failed') return;

      if (phase === 'planning') {
        const t = Date.now();
        console.log('[Orchestrator] Creating plan...');
        await this.createPlan(council);
        console.log(`[Orchestrator:Timing] createPlan took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      if (phase === 'paused' || phase === 'failed') return;

      if (phase === 'directing') {
        const t = Date.now();
        console.log('[Orchestrator] Issuing directive...');
        await this.issueDirective(council);
        console.log(`[Orchestrator:Timing] issueDirective took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      // Phase 4: Execution loop
      const maxRevisions = council.deliberation?.maxRevisions || 3;
      let revisionCount = council.deliberationState?.revisionCount || 0;

      while (revisionCount < maxRevisions + 1) {
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;

        if (phase === 'paused' || phase === 'failed') {
          console.log('[Orchestrator] Deliberation paused/failed — stopping auto-run');
          return;
        }

        if (phase === 'executing') {
          const t = Date.now();
          console.log('[Orchestrator] Executing work...');
          await this.executeWork(council);
          console.log(`[Orchestrator:Timing] executeWork took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        } else if (phase === 'reviewing') {
          const t = Date.now();
          console.log('[Orchestrator] Reviewing work...');
          const { review } = await this.reviewWork(council);
          console.log(`[Orchestrator:Timing] reviewWork took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);

          if (review.verdict === 'accept') {
            console.log('[Orchestrator] Work approved!');
            break;
          } else if (review.verdict === 'revise') {
            revisionCount++;
            console.log(`[Orchestrator] Revision requested (${revisionCount}/${maxRevisions})`);
          } else if (review.verdict === 're_deliberate') {
            const reDelibCount = council.deliberationState?.reDeliberationCount || 0;
            if (reDelibCount >= 1) {
              console.log('[Orchestrator] Max re-deliberations reached — accepting with best effort');
              this.transitionPhase(councilId, 'completed');
              councilStore.setStatus(councilId, 'resolved');
              break;
            }
            console.log('[Orchestrator] Re-deliberation requested — looping back');
            councilStore.updateDeliberationState(councilId, {
              reDeliberationCount: reDelibCount + 1,
            });
            // Phase transitions back to round_interactive, re-enter deliberation loop
            await this.continueDeliberation(councilId);
            return;
          }
        } else if (phase === 'revising') {
          console.log('[Orchestrator] Revising work...');
          await this.requestRevision(council);
        } else if (phase === 'completed') {
          console.log('[Orchestrator] Deliberation completed!');
          break;
        } else {
          console.log(`[Orchestrator] Unexpected phase during execution: ${phase}`);
          break;
      }
    }

    // Success — break out of the phase-level retry loop
    break;

    } catch (error) {
      const errMsg = (error as Error).message || String(error);
      const isRateLimit = /\b(429|rate.limit|too many requests)\b/i.test(errMsg);

      council = councilStore.get(councilId)!;
      const errPhase = council.deliberationState?.currentPhase;

      if (isRateLimit && phaseAttempt < PHASE_RETRY_MAX) {
        const delayMs = PHASE_RETRY_BASE_MS * Math.pow(1.5, phaseAttempt);
        console.warn(
          `[Orchestrator] Rate limit during ${errPhase}, retrying phase in ${Math.round(delayMs / 1000)}s ` +
          `(phase attempt ${phaseAttempt + 1}/${PHASE_RETRY_MAX})`
        );
        this.createEntry(
          councilId, 'manager', this.getManager(council).id,
          'error', errPhase || 'failed',
          `Rate limited during ${errPhase} — waiting ${Math.round(delayMs / 1000)}s before retrying...`,
          0, 0, undefined, council.deliberationState?.currentRound
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue; // retry from current phase
      }

      console.error(`[Orchestrator] Error during post-round phase:`, errMsg);

      // Record error in ledger — attribute to the phase's active role
      try {
        const isWorkerPhase = errPhase === 'executing' || errPhase === 'revising';
        const role = isWorkerPhase ? 'worker' : 'manager';
        const persona = isWorkerPhase
          ? (council.personas.find(p => p.preferredDeliberationRole === 'worker') || this.getManager(council))
          : this.getManager(council);
        this.createEntry(
          councilId,
          role,
          persona.id,
          'error',
          errPhase || 'failed',
          `Deliberation error during ${errPhase}: ${errMsg}`,
          0, 0, undefined,
          council.deliberationState?.currentRound
        );
      } catch { /* best effort */ }

      this.transitionPhase(councilId, 'failed');
      throw error;
    }
    } // end phase-level retry loop

    console.log(`[Orchestrator] Auto-run finished${elapsed()}`);
  }

  // ==========================================================================
  // Phase 1: Problem Framing
  // ==========================================================================

  /**
   * Manager frames the problem, creating Context v1
   */
  async frameProblem(council: Council, rawProblem: string): Promise<LedgerEntry> {
    this.validatePhase(council, 'created');
    const manager = this.getManager(council);

    // Transition to problem_framing
    this.transitionPhase(council.id, 'problem_framing');

    // Show manager as thinking immediately (before bootstrap, which can be slow)
    this.config.onAgentThinkingStart?.(manager, Date.now(), rawProblem);

    // Bootstrap directory context if enabled — stored for all personas
    let enrichedProblem = rawProblem;
    if (council.deliberation?.bootstrapContext && council.deliberation?.workingDirectory) {
      try {
        const dirContext = await bootstrapDirectoryContext(council.deliberation.workingDirectory, { deep: true });
        if (dirContext) {
          this.bootstrappedContext = dirContext;
          enrichedProblem = `${dirContext}\n\n---\n\n${rawProblem}`;
        }
      } catch (error) {
        console.warn('[Orchestrator] Directory context bootstrap failed:', error);
      }
    }

    // Build prompts per Section 9.1
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildManagerFramingPrompt(enrichedProblem);

    // Note: onAgentThinkingStart was already called above (before bootstrap).
    // invokeAgentSafe will call it again (idempotent) and onAgentThinkingEnd when done.

    // Invoke manager
    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'problem_framing'
    );

    // Create Context v1
    const context = createInitialContext(council.id, response.content, manager.id);

    // Update deliberation state
    councilStore.setActiveContext(council.id, context.id, context.version);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'problem_statement',
      'problem_framing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'context', artifactId: context.id, version: 1 }],
      undefined,
      response.structured
    );

    // Check if consultants exist — skip deliberation rounds if none
    const consultants = this.getConsultants(council);
    if (consultants.length === 0) {
      console.log('[Orchestrator] 0 consultants — skipping deliberation rounds, moving to deciding');
      this.transitionPhase(council.id, 'deciding');
    } else {
      // Transition to round_independent
      this.transitionPhase(council.id, 'round_independent');
      councilStore.advanceRound(council.id);
    }

    return entry;
  }

  // ==========================================================================
  // Phase 2: Deliberation Rounds
  // ==========================================================================

  /**
   * Generate independent analysis for all consultants (Round 1)
   */
  async runIndependentRound(council: Council): Promise<LedgerEntry[]> {
    this.validatePhase(council, 'round_independent');
    const consultants = this.getConsultants(council);
    const context = getCurrentContext(council.id);

    // Detailed logging to debug missing consultant participation
    const allRoleAssignments = council.deliberation?.roleAssignments || [];
    const consultantRoles = allRoleAssignments.filter(r => r.role === 'consultant');
    console.log(`[Orchestrator] Independent round: ${consultants.length} consultant(s) ` +
      `from ${consultantRoles.length} consultant role assignment(s)`,
      {
        consultantNames: consultants.map(c => `${c.name} (${c.id.slice(0, 8)})`),
        consultantRoleIds: consultantRoles.map(r => r.personaId.slice(0, 8)),
        allPersonaIds: council.personas.map(p => `${p.name}:${p.id.slice(0, 8)}`),
      });

    if (!context) {
      throw new Error('No context found - problem must be framed first');
    }

    if (consultants.length === 0) {
      console.warn('[Orchestrator] No consultants assigned - skipping independent round');
      this.transitionPhase(council.id, 'round_waiting_for_manager');
      return [];
    }

    const entries: LedgerEntry[] = [];

    const runOne = async (consultant: Persona): Promise<LedgerEntry> => {
      const assignment = getRoleAssignment(council, consultant.id);
      const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';

      const systemPrompt = consultant.predisposition.systemPrompt;
      const userMessage = buildIndependentAnalysisPrompt(consultant, focusArea, context.content);

      const response = await this.invokeAgentSafe(
        { personaId: consultant.id, systemPrompt, userMessage },
        consultant,
        'independent_analysis'
      );

      const proposedPatch = this.extractContextProposal(response.content);

      const entry = this.createEntry(
        council.id,
        'consultant',
        consultant.id,
        'analysis',
        'round_independent',
        response.content,
        response.tokensUsed,
        response.latencyMs,
        undefined,
        council.deliberationState?.currentRound,
        response.structured
      );

      councilStore.recordSubmission(council.id, consultant.id);

      // Evolve context with consultant findings
      this.appendToContext(council.id, 'Consultant Analysis', consultant.name, response.content, 'consultant', consultant.id);

      if (proposedPatch) {
        const patch = createPatch(
          council.id,
          context.id,
          context.version,
          proposedPatch.diff,
          proposedPatch.rationale,
          consultant.id,
          council.deliberationState?.currentRound || 1
        );
        councilStore.addPendingPatch(council.id, patch.id);
      }

      return entry;
    };

    // Respect consultantExecution setting
    const isSequential = council.deliberation?.consultantExecution === 'sequential';

    if (isSequential) {
      // Sequential: run one at a time, each with retry
      for (const consultant of consultants) {
        const entry = await this.runConsultantWithRetry(council, consultant, () => runOne(consultant));
        if (entry) entries.push(entry);
      }
    } else {
      // Parallel: all at once, each with retry
      const results = await Promise.allSettled(
        consultants.map((consultant) =>
          this.runConsultantWithRetry(council, consultant, () => runOne(consultant))
        )
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          entries.push(result.value);
        }
      }
    }

    // Check if round is complete (all consultants submitted or accounted for)
    if (councilStore.isRoundComplete(council.id)) {
      this.transitionPhase(council.id, 'round_waiting_for_manager');
    }

    return entries;
  }

  /**
   * Generate deliberation response for a consultant (Round 2+)
   */
  async generateDeliberationResponse(council: Council, consultantId: string): Promise<LedgerEntry> {
    this.validatePhase(council, 'round_interactive');
    const consultant = council.personas.find((p) => p.id === consultantId);

    if (!consultant) {
      throw new Error(`Consultant not found: ${consultantId}`);
    }

    const assignment = getRoleAssignment(council, consultant.id);
    const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';

    // Build context per Section 9.3
    // In sequential mode, include current round entries so later consultants
    // can see and build on earlier consultants' responses from this round
    const isSequential = council.deliberation?.consultantExecution === 'sequential';
    const contextContent = this.buildRoundNContext(council, isSequential);

    // Build prompts
    const systemPrompt = consultant.predisposition.systemPrompt;
    const userMessage = buildDeliberationResponsePrompt(consultant, focusArea, contextContent);

    const response = await this.invokeAgentSafe(
      { personaId: consultant.id, systemPrompt, userMessage },
      consultant,
      'deliberation_response'
    );

    // Check for context change proposal
    const proposedPatch = this.extractContextProposal(response.content);
    const context = getCurrentContext(council.id);

    // Create ledger entry
    const entryType: LedgerEntryType = proposedPatch ? 'proposal' : 'response';
    const entry = this.createEntry(
      council.id,
      'consultant',
      consultant.id,
      entryType,
      'round_interactive',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      undefined,
      council.deliberationState?.currentRound,
      response.structured
    );

    // Record submission
    councilStore.recordSubmission(council.id, consultant.id);

    // Create patch if proposed
    if (proposedPatch && context) {
      const patch = createPatch(
        council.id,
        context.id,
        context.version,
        proposedPatch.diff,
        proposedPatch.rationale,
        consultant.id,
        council.deliberationState?.currentRound || 1
      );
      councilStore.addPendingPatch(council.id, patch.id);
    }

    return entry;
  }

  /**
   * Run a full interactive round for all consultants
   */
  async runInteractiveRound(council: Council): Promise<LedgerEntry[]> {
    this.validatePhase(council, 'round_interactive');
    const consultants = this.getConsultants(council);
    const entries: LedgerEntry[] = [];

    // Detailed logging to debug missing consultant participation
    const allRoleAssignments = council.deliberation?.roleAssignments || [];
    const consultantRoles = allRoleAssignments.filter(r => r.role === 'consultant');
    console.log(`[Orchestrator] Interactive round ${council.deliberationState?.currentRound}: ` +
      `${consultants.length} consultant(s) from ${consultantRoles.length} consultant role assignment(s)`,
      {
        consultantNames: consultants.map(c => `${c.name} (${c.id.slice(0, 8)})`),
        consultantRoleIds: consultantRoles.map(r => r.personaId.slice(0, 8)),
        allPersonaIds: council.personas.map(p => `${p.name}:${p.id.slice(0, 8)}`),
      });

    if (consultants.length === 0) {
      console.warn('[Orchestrator] No consultants assigned - skipping interactive round');
      this.transitionPhase(council.id, 'round_waiting_for_manager');
      return [];
    }

    // Respect consultantExecution setting
    const isSequential = council.deliberation?.consultantExecution === 'sequential';

    if (isSequential) {
      // Sequential: each consultant sees previous consultants' responses in this round
      for (const consultant of consultants) {
        const entry = await this.runConsultantWithRetry(
          council,
          consultant,
          () => this.generateDeliberationResponse(councilStore.get(council.id)!, consultant.id)
        );
        if (entry) entries.push(entry);
      }
    } else {
      // Parallel: all consultants respond simultaneously with same context
      const results = await Promise.allSettled(
        consultants.map((consultant) =>
          this.runConsultantWithRetry(
            council,
            consultant,
            () => this.generateDeliberationResponse(council, consultant.id)
          )
        )
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          entries.push(result.value);
        }
      }
    }

    // Check if round is complete (all consultants submitted or accounted for)
    const updatedCouncil = councilStore.get(council.id);
    if (updatedCouncil && councilStore.isRoundComplete(council.id)) {
      this.transitionPhase(council.id, 'round_waiting_for_manager');
    }

    return entries;
  }

  /**
   * Manager evaluates the round
   */
  async managerEvaluate(council: Council): Promise<ManagerEvaluation> {
    this.validatePhase(council, 'round_waiting_for_manager');
    const manager = this.getManager(council);

    // Build context per Section 9.4
    const evalContext = this.buildManagerEvalContext(council);
    const pendingPatches = getPendingPatches(council.id);
    const expectedOutput = council.deliberation?.expectedOutput;

    // Build prompts
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildManagerEvaluationPrompt(evalContext, pendingPatches, expectedOutput);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'manager_evaluation'
    );

    // Parse structured response
    const evaluation = this.parseManagerEvaluation(response.content);

    // Process patch decisions
    if (evaluation.patchDecisions) {
      for (const decision of evaluation.patchDecisions) {
        const patch = getPendingPatches(council.id).find((p) => p.id === decision.patchId);
        if (!patch) {
          console.warn(`[Deliberation] Patch not found: ${decision.patchId}`);
          continue;
        }

        if (decision.accepted) {
          const currentContext = getCurrentContext(council.id);

          // Check for staleness - patch was proposed against an older context version
          const isStale = currentContext ? patch.baseVersion < currentContext.version : false;

          if (isStale) {
            // For stale patches, we need to either:
            // 1. Reject and ask for rebase
            // 2. Apply with allowStale (if manager explicitly approves)
            // For now, we log a warning and allow with explicit flag
            console.warn(
              `[Deliberation] Accepting stale patch ${patch.id}: ` +
              `proposed against v${patch.baseVersion}, current is v${currentContext!.version}`
            );
          }

          // Intelligently integrate the patch into the current context
          // The patch.diff contains the proposed change/addition
          // Instead of naive append, use the manager's decision reason as context
          const integrationNote = isStale
            ? `[Context change from ${this.getPersonaDisplayName(council, patch.authorPersonaId)}, ` +
              `originally proposed against v${patch.baseVersion}, integrated at v${currentContext?.version || 1}]`
            : `[Context change from ${this.getPersonaDisplayName(council, patch.authorPersonaId)}]`;

          const newContent = currentContext
            ? `${currentContext.content}\n\n${integrationNote}:\n${patch.diff}`
            : patch.diff;

          const result = acceptPatch(
            council.id,
            decision.patchId,
            manager.id,
            decision.reason,
            newContent,
            {
              allowStale: true, // Manager made explicit decision to accept
              changeSummary: `${patch.rationale}${isStale ? ' (applied to newer context)' : ''}`,
            }
          );

          councilStore.removePendingPatch(council.id, decision.patchId);
          councilStore.setActiveContext(council.id, result.newContext.id, result.newContext.version);

          // Create acceptance ledger entry with staleness info
          this.createEntry(
            council.id,
            'manager',
            manager.id,
            'context_acceptance',
            'round_waiting_for_manager',
            `Accepted context change: ${decision.reason}${result.wasStale ? ' (applied to newer context version)' : ''}`,
            0, 0,
            [{ artifactType: 'context', artifactId: result.newContext.id, version: result.newContext.version }]
          );
        } else {
          rejectPatch(council.id, decision.patchId, manager.id, decision.reason);
          councilStore.removePendingPatch(council.id, decision.patchId);

          // Create rejection ledger entry
          this.createEntry(
            council.id,
            'manager',
            manager.id,
            'context_rejection',
            'round_waiting_for_manager',
            `Rejected context change: ${decision.reason}`,
            0, 0
          );
        }
      }
    }

    // Store evaluation
    councilStore.setManagerEvaluation(council.id, evaluation);

    // Handle action
    const currentRound = council.deliberationState?.currentRound || 1;
    const minRounds = council.deliberation?.minRounds || 1;
    const maxRounds = council.deliberation?.maxRounds || 4;

    // Enforce min rounds: if manager wants to decide but we haven't hit minRounds, continue instead
    const canDecide = currentRound >= minRounds;
    const mustDecide = currentRound >= maxRounds;

    if (mustDecide || (evaluation.action === 'decide' && canDecide)) {
      this.transitionPhase(council.id, 'deciding');
    } else if (!canDecide && evaluation.action === 'decide') {
      // Manager tried to decide too early — force another round
      console.log(`[Orchestrator] Manager wanted to decide at round ${currentRound}, but minRounds is ${minRounds}. Continuing.`);
      councilStore.advanceRound(council.id);
      this.transitionPhase(council.id, 'round_interactive');
    } else if (evaluation.action === 'continue' || evaluation.action === 'redirect') {
      // Create question/redirect entry if provided
      if (evaluation.question) {
        const entryType: LedgerEntryType = evaluation.action === 'redirect' ? 'manager_redirect' : 'manager_question';
        this.createEntry(
          council.id,
          'manager',
          manager.id,
          entryType,
          'round_waiting_for_manager',
          evaluation.question,
          response.tokensUsed,
          response.latencyMs,
          undefined,
          currentRound,
          response.structured
        );
      }

      // Generate summary if needed
      if (this.shouldSummarize(council)) {
        await this.generateRoundSummary(council);
      }

      // Advance to next round
      councilStore.advanceRound(council.id);
      this.transitionPhase(council.id, 'round_interactive');
    }

    return evaluation;
  }

  /**
   * Generate round summary
   */
  async generateRoundSummary(council: Council): Promise<LedgerEntry> {
    const manager = this.getManager(council);
    const currentRound = council.deliberationState?.currentRound || 1;
    const roundEntries = getEntriesForRound(council.id, currentRound);

    let summaryContent: string;
    let tokensUsed = 0;
    let latencyMs = 0;
    let summaryStructured: Record<string, unknown> | undefined;

    const summaryMode = council.deliberation?.summaryMode || 'manager';
    const summarizeAfterRound = council.deliberation?.summarizeAfterRound || 2;

    // Determine whether to use automatic or manager summary
    const useAutomatic = summaryMode === 'automatic' ||
      (summaryMode === 'hybrid' && currentRound <= summarizeAfterRound + 1);

    if (useAutomatic) {
      summaryContent = buildMechanicalSummary(roundEntries);
    } else {
      // Manager-generated summary
      const systemPrompt = manager.predisposition.systemPrompt;
      const userMessage = buildManagerRoundSummaryPrompt(roundEntries);

      const response = await this.invokeAgentSafe(
        { personaId: manager.id, systemPrompt, userMessage },
        manager,
        'round_summary'
      );

      summaryContent = response.content;
      tokensUsed = response.tokensUsed;
      latencyMs = response.latencyMs;
      summaryStructured = response.structured;
    }

    // Store summary
    councilStore.setRoundSummary(council.id, currentRound, summaryContent);

    // Create ledger entry
    return this.createEntry(
      council.id,
      'manager',
      manager.id,
      'round_summary',
      council.deliberationState?.currentPhase || 'round_waiting_for_manager',
      summaryContent,
      tokensUsed,
      latencyMs,
      undefined,
      currentRound,
      summaryStructured
    );
  }

  // ==========================================================================
  // Consultant Final Positions (before decision)
  // ==========================================================================

  private async collectConsultantFinalPositions(council: Council): Promise<string> {
    const consultants = this.getConsultants(council);
    if (consultants.length === 0) return '';

    const contextContent = this.buildRoundNContext(council, false);
    const positions: string[] = [];

    for (const consultant of consultants) {
      const assignment = getRoleAssignment(council, consultant.id);
      const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';
      const systemPrompt = consultant.predisposition.systemPrompt;
      const userMessage = buildConsultantFinalPositionPrompt(consultant, focusArea, contextContent);

      this.config.onAgentThinkingStart?.(consultant, Date.now(), userMessage);
      const response = await this.invokeAgentSafe(
        { personaId: consultant.id, systemPrompt, userMessage },
        consultant,
        'deliberation_response'  // reuse existing tool phase (READ_ONLY_TOOLS)
      );
      this.config.onAgentThinkingEnd?.(consultant);

      positions.push(`[${consultant.name} - ${focusArea}]: ${response.content}`);

      this.createEntry(council.id, 'consultant', consultant.id, 'response', 'deciding',
        response.content, response.tokensUsed, response.latencyMs, undefined,
        council.deliberationState?.currentRound, response.structured);
    }

    return positions.join('\n\n');
  }

  // ==========================================================================
  // Phase 3: Decision
  // ==========================================================================

  /**
   * Manager makes final decision
   */
  async makeDecision(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'deciding');
    const manager = this.getManager(council);

    // Collect consultant final positions before manager decides
    const consultantPositions = await this.collectConsultantFinalPositions(council);

    // Build context per Section 9.5
    const decisionContext = this.buildDecisionContext(council);
    const fullContext = consultantPositions
      ? `CONSULTANT FINAL POSITIONS:\n${consultantPositions}\n\n---\n\n${decisionContext}`
      : decisionContext;
    const decisionCriteria = council.deliberation?.decisionCriteria;
    const expectedOutput = council.deliberation?.expectedOutput;

    // Build prompts
    const systemPrompt = manager.predisposition.systemPrompt;
    const stepType = council.deliberation?.stepType;
    const userMessage = buildManagerDecisionPrompt(fullContext, decisionCriteria, expectedOutput, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'decision'
    );

    // Create decision artifact
    const context = getCurrentContext(council.id);
    const acceptanceCriteria = this.extractAcceptanceCriteria(response.content);

    const decision = createDecision(
      council.id,
      response.content,
      context?.version || 1,
      acceptanceCriteria
    );

    // Update state
    councilStore.setFinalDecision(council.id, decision.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'decision',
      'deciding',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'decision', artifactId: decision.id }],
      undefined,
      response.structured
    );

    // Check if workers exist — if not, decision IS the output
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      console.log('[Orchestrator] 0 workers — decision is the final output');
      councilStore.updateDeliberationState(council.id, { completionSummary: response.content });
      this.transitionPhase(council.id, 'completed');
      councilStore.setStatus(council.id, 'resolved');
      return entry;
    }

    // Transition to planning or directing
    const requirePlan = council.deliberation?.requirePlan || false;
    this.transitionPhase(council.id, requirePlan ? 'planning' : 'directing');

    return entry;
  }

  /**
   * Manager creates execution plan (optional)
   */
  async createPlan(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'planning');
    const manager = this.getManager(council);
    const decision = getDecision(council.id);

    if (!decision) {
      throw new Error('No decision found - must make decision first');
    }

    // Build prompts
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildManagerPlanPrompt(decision.content);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'plan'
    );

    // Create plan artifact
    const plan = createPlan(council.id, response.content, decision.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'plan',
      'planning',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'plan', artifactId: plan.id }],
      undefined,
      response.structured
    );

    this.transitionPhase(council.id, 'directing');
    return entry;
  }

  // ==========================================================================
  // Phase 4: Work Directive
  // ==========================================================================

  /**
   * Manager issues work directive
   */
  async issueDirective(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'directing');
    const manager = this.getManager(council);
    const decision = getDecision(council.id);
    const plan = getPlan(council.id);

    if (!decision) {
      throw new Error('No decision found - must make decision first');
    }

    // Check if the worker has write permissions (informs the directive to emphasize implementation)
    const worker = this.getWorker(council);
    const workerAssignment = getRoleAssignment(council, worker.id);
    const hasWritePermissions = !!(workerAssignment?.writePermissions);
    const stepType = council.deliberation?.stepType;

    // Build prompts per Section 9.6
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildWorkDirectivePrompt(decision.content, plan?.content, hasWritePermissions, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'directive'
    );

    // Create directive artifact
    const directive = createDirective(
      council.id,
      response.content,
      decision.id,
      plan?.id
    );

    // Update state
    councilStore.setWorkDirective(council.id, directive.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'work_directive',
      'directing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'directive', artifactId: directive.id }],
      undefined,
      response.structured
    );

    this.transitionPhase(council.id, 'executing');
    return entry;
  }

  // ==========================================================================
  // Phase 5: Execution
  // ==========================================================================

  /**
   * Worker executes directive
   */
  async executeWork(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'executing');
    const worker = this.getWorker(council);
    const directive = getDirective(council.id);

    if (!directive) {
      throw new Error('No directive found - must issue directive first');
    }

    // Get role assignment for suppress check
    const assignment = getRoleAssignment(council, worker.id);
    const suppressPersona = assignment?.suppressPersona !== false; // Default true for worker

    // Build worker permissions from role assignment + deliberation config
    const workerPermissions: WorkerPermissions = {
      writePermissions: assignment?.writePermissions,
      workingDirectory: council.deliberation?.workingDirectory,
      directoryConstrained: council.deliberation?.directoryConstrained,
    };

    // Build prompts per Section 9.7
    const stepType = council.deliberation?.stepType;
    const systemPrompt = suppressPersona
      ? getMinimalWorkerSystemPrompt(workerPermissions, stepType)
      : worker.predisposition.systemPrompt;

    const userMessage = buildWorkerExecutionPrompt(directive.content, workerPermissions, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: worker.id, systemPrompt, userMessage },
      worker,
      'execution'
    );

    // Create output artifact
    const output = createOutput(council.id, response.content, directive.id);

    // Update state
    councilStore.setCurrentOutput(council.id, output.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_output',
      'executing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'output', artifactId: output.id, version: output.version }],
      undefined,
      response.structured
    );

    // Evolve context with worker results
    this.appendToContext(council.id, 'Worker Execution', worker.name, response.content, 'worker', worker.id);

    this.transitionPhase(council.id, 'reviewing');
    return entry;
  }

  // ==========================================================================
  // Consultant Reviews (before manager verdict)
  // ==========================================================================

  private async collectConsultantReviews(council: Council): Promise<string> {
    const consultants = this.getConsultants(council);
    if (consultants.length === 0) return '';

    const output = getLatestOutput(council.id);
    const directive = getDirective(council.id);
    if (!output || !directive) return '';

    const expectedOutput = council.deliberation?.expectedOutput;

    // Run consultant reviews in parallel to reduce total time
    const reviewOne = async (consultant: Persona): Promise<string> => {
      const assignment = getRoleAssignment(council, consultant.id);
      const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';
      const systemPrompt = consultant.predisposition.systemPrompt;
      const userMessage = buildConsultantReviewPrompt(
        consultant, focusArea, output.content, directive.content, expectedOutput
      );

      const response = await this.invokeAgentSafe(
        { personaId: consultant.id, systemPrompt, userMessage },
        consultant,
        'consultant_review'
      );

      this.createEntry(council.id, 'consultant', consultant.id, 'review', 'reviewing',
        response.content, response.tokensUsed, response.latencyMs, undefined,
        council.deliberationState?.currentRound, response.structured);

      return `[${consultant.name} - ${focusArea}]: ${response.content}`;
    };

    const results = await Promise.allSettled(consultants.map(c => reviewOne(c)));

    const reviews: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        reviews.push(result.value);
      } else {
        console.warn('[Orchestrator] Consultant review failed:', result.reason);
      }
    }

    return reviews.join('\n\n');
  }

  // ==========================================================================
  // Phase 6: Review
  // ==========================================================================

  /**
   * Manager reviews work output
   */
  async reviewWork(council: Council): Promise<{ entry: LedgerEntry; review: ManagerReview }> {
    this.validatePhase(council, 'reviewing');
    const manager = this.getManager(council);
    const directive = getDirective(council.id);
    const output = getLatestOutput(council.id);
    const decision = getDecision(council.id);

    if (!directive || !output) {
      throw new Error('Missing directive or output for review');
    }

    // Collect consultant reviews first
    const consultantReviews = await this.collectConsultantReviews(council);

    // Check if worker had write permissions (affects review criteria)
    const worker = this.getWorker(council);
    const workerAssignment = getRoleAssignment(council, worker.id);
    const hasWritePermissions = !!(workerAssignment?.writePermissions);
    const stepType = council.deliberation?.stepType;

    // Build prompts per Section 9.8
    const systemPrompt = manager.predisposition.systemPrompt;
    const expectedOutput = council.deliberation?.expectedOutput;
    const userMessage = buildManagerReviewPrompt(
      output.content,
      directive.content,
      decision?.acceptanceCriteria,
      expectedOutput,
      hasWritePermissions,
      stepType,
      consultantReviews,
    );

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'review'
    );

    // Parse review
    const review = this.parseManagerReview(response.content);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'review',
      'reviewing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      undefined,
      undefined,
      response.structured,
      undefined,
      review.verdict
    );

    // Handle verdict
    if (review.verdict === 'accept') {
      this.transitionPhase(council.id, 'completed');
      councilStore.setStatus(council.id, 'resolved');
    } else if (review.verdict === 'revise') {
      const revisionCount = council.deliberationState?.revisionCount || 0;
      const maxRevisions = council.deliberation?.maxRevisions || 3;

      if (revisionCount >= maxRevisions) {
        // Max revisions reached - complete with best effort
        this.transitionPhase(council.id, 'completed');
        councilStore.setStatus(council.id, 'resolved');
      } else {
        // Request revision
        if (review.feedback) {
          this.createEntry(
            council.id,
            'manager',
            manager.id,
            'revision_request',
            'reviewing',
            review.feedback,
            0, 0
          );
        }
        councilStore.incrementRevisionCount(council.id);
        this.transitionPhase(council.id, 'revising');
      }
    } else if (review.verdict === 're_deliberate') {
      // Start new deliberation round with new information
      let newContextVersion: number | undefined;

      if (review.newInformation) {
        // Add new information to context
        const currentContext = getCurrentContext(council.id);
        if (currentContext) {
          const updatedContext = createContextVersion(
            council.id,
            `${currentContext.content}\n\n[New Information from Review]:\n${review.newInformation}`,
            'New information emerged during review - re-deliberation required',
            'manager',
            manager.id
          );
          newContextVersion = updatedContext.version;

          // Update council's active context reference
          councilStore.setActiveContext(council.id, updatedContext.id, updatedContext.version);
        }
      }

      // Write ledger entry for re-deliberation decision
      this.createEntry(
        council.id,
        'manager',
        manager.id,
        're_deliberation',
        'reviewing',
        `Re-deliberation requested: ${review.reasoning || 'New information requires additional deliberation'}${
          review.newInformation ? `\n\nNew information:\n${review.newInformation}` : ''
        }${newContextVersion ? `\n\n[Context updated to version ${newContextVersion}]` : ''}`,
        0, 0
      );

      councilStore.advanceRound(council.id);
      this.transitionPhase(council.id, 'round_interactive');
    }

    return { entry, review };
  }

  /**
   * Worker revises output based on feedback
   */
  async requestRevision(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'revising');
    const worker = this.getWorker(council);
    const directive = getDirective(council.id);
    const previousOutput = getLatestOutput(council.id);

    // Get latest revision request
    const revisionRequest = getLatestOfType(council.id, 'revision_request');

    if (!directive || !previousOutput || !revisionRequest) {
      throw new Error('Missing directive, previous output, or revision feedback');
    }

    // Get role assignment for suppress check
    const assignment = getRoleAssignment(council, worker.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    // Build worker permissions from role assignment + deliberation config
    const workerPermissions: WorkerPermissions = {
      writePermissions: assignment?.writePermissions,
      workingDirectory: council.deliberation?.workingDirectory,
      directoryConstrained: council.deliberation?.directoryConstrained,
    };

    // Build prompts per Section 9.7.1
    const stepType = council.deliberation?.stepType;
    const systemPrompt = suppressPersona
      ? getMinimalWorkerSystemPrompt(workerPermissions, stepType)
      : worker.predisposition.systemPrompt;

    const userMessage = buildWorkerRevisionPrompt(
      directive.content,
      previousOutput.content,
      revisionRequest.content,
      workerPermissions,
      stepType,
    );

    const response = await this.invokeAgentSafe(
      { personaId: worker.id, systemPrompt, userMessage },
      worker,
      'revision'
    );

    // Create revision output
    const output = createRevisionOutput(
      council.id,
      response.content,
      directive.id,
      previousOutput.id
    );

    // Update state
    councilStore.setCurrentOutput(council.id, output.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_output',
      'revising',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'output', artifactId: output.id, version: output.version }],
      undefined,
      response.structured
    );

    // Evolve context with revision results
    this.appendToContext(council.id, 'Worker Revision', worker.name, response.content, 'worker', worker.id);

    this.transitionPhase(council.id, 'reviewing');
    return entry;
  }

  // ==========================================================================
  // Direct Execution (0 managers — worker-only council)
  // ==========================================================================

  /**
   * Run direct execution: worker executes the raw input directly.
   * No manager framing, no deliberation, no review.
   * Used when a council has only worker(s) and no manager.
   */
  async runDirectExecution(council: Council, rawProblem: string): Promise<void> {
    this.activeCouncilId = council.id;
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No workers assigned for direct execution');
    }

    const worker = workers[0];
    const assignment = getRoleAssignment(council, worker.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    // Bootstrap directory context if enabled
    let enrichedProblem = rawProblem;
    if (council.deliberation?.bootstrapContext && council.deliberation?.workingDirectory) {
      try {
        const dirContext = await bootstrapDirectoryContext(council.deliberation.workingDirectory, { deep: true });
        if (dirContext) {
          enrichedProblem = `${dirContext}\n\n---\n\n${rawProblem}`;
        }
      } catch (error) {
        console.warn('[Orchestrator] Directory context bootstrap failed:', error);
      }
    }

    // Create a synthetic directive from the raw input
    this.transitionPhase(council.id, 'executing');

    const directive = createDirective(council.id, enrichedProblem, 'direct-execution');
    councilStore.setWorkDirective(council.id, directive.id);

    this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_directive',
      'executing',
      enrichedProblem,
      0, 0,
      [{ artifactType: 'directive', artifactId: directive.id }]
    );

    // Build worker permissions
    const workerPermissions: WorkerPermissions = {
      writePermissions: assignment?.writePermissions,
      workingDirectory: council.deliberation?.workingDirectory,
      directoryConstrained: council.deliberation?.directoryConstrained,
    };

    const stepType = council.deliberation?.stepType;
    const systemPrompt = suppressPersona
      ? getMinimalWorkerSystemPrompt(workerPermissions, stepType)
      : worker.predisposition.systemPrompt;

    const userMessage = buildWorkerExecutionPrompt(enrichedProblem, workerPermissions, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: worker.id, systemPrompt, userMessage },
      worker,
      'execution'
    );

    // Create output artifact
    const output = createOutput(council.id, response.content, directive.id);
    councilStore.setCurrentOutput(council.id, output.id);

    this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_output',
      'executing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'output', artifactId: output.id, version: output.version }],
      undefined,
      response.structured
    );

    // No review — first output is accepted
    councilStore.updateDeliberationState(council.id, { completionSummary: response.content });
    this.transitionPhase(council.id, 'completed');
    councilStore.setStatus(council.id, 'resolved');

    console.log('[Orchestrator] Direct execution completed');
  }

  // ==========================================================================
  // Control Operations
  // ==========================================================================

  /**
   * Pause deliberation
   */
  async pause(council: Council): Promise<void> {
    const currentPhase = council.deliberationState?.currentPhase;
    if (!currentPhase || PHASE_TRANSITIONS[currentPhase].terminal) {
      throw new Error('Cannot pause - deliberation is in terminal state');
    }

    councilStore.setDeliberationPhase(council.id, 'paused', currentPhase);
    councilStore.setStatus(council.id, 'paused');
  }

  /**
   * Resume deliberation
   */
  async resume(council: Council): Promise<void> {
    if (council.deliberationState?.currentPhase !== 'paused') {
      throw new Error('Council is not paused');
    }

    const previousPhase = council.deliberationState.previousPhase;
    if (!previousPhase) {
      throw new Error('No previous phase to resume from');
    }

    councilStore.setDeliberationPhase(council.id, previousPhase);
    councilStore.setStatus(council.id, 'active');
  }

  /**
   * Cancel and force decision
   */
  async cancelAndForceDecision(council: Council): Promise<LedgerEntry> {
    const manager = this.getManager(council);

    // Create cancellation entry
    this.createEntry(
      council.id,
      'manager',
      manager.id,
      'cancellation',
      council.deliberationState?.currentPhase || 'created',
      'Deliberation ended early by user - forcing decision',
      0, 0
    );

    // Build forced decision context per Section 9.9
    const contextContent = this.buildForcedDecisionContext(council);

    const systemPrompt = manager.predisposition.systemPrompt;
    const stepType = council.deliberation?.stepType;
    const userMessage = buildManagerForcedDecisionPrompt(contextContent, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'forced_decision'
    );

    // Create decision artifact
    const context = getCurrentContext(council.id);
    const decision = createDecision(
      council.id,
      response.content,
      context?.version || 1
    );

    councilStore.setFinalDecision(council.id, decision.id);

    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'decision',
      'deciding',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'decision', artifactId: decision.id }],
      undefined,
      response.structured
    );

    // Continue with normal flow
    this.transitionPhase(council.id, 'directing');

    return entry;
  }

  /**
   * Abort deliberation
   */
  async abort(council: Council): Promise<void> {
    const manager = this.getManager(council);

    this.createEntry(
      council.id,
      'manager',
      manager.id,
      'cancellation',
      council.deliberationState?.currentPhase || 'created',
      'Deliberation aborted by user',
      0, 0
    );

    this.transitionPhase(council.id, 'cancelled');
    councilStore.setStatus(council.id, 'resolved');
  }

  // ==========================================================================
  // Context Builders
  // ==========================================================================

  /**
   * Build context for Round 1 (independent analysis) - Section 9.2
   * ONLY context artifact, no other consultant output
   */
  buildRound1Context(council: Council): string {
    const context = getCurrentContext(council.id);
    if (!context) {
      throw new Error('No context found');
    }
    return `SHARED CONTEXT (v${context.version}):\n${context.content}`;
  }

  /**
   * Build context for Round 2+ (interactive deliberation) - Section 9.3
   * Context artifact + prior rounds (full or summarized) + manager notes
   * When includeCurrentRound is true (sequential mode), appends current round
   * entries so later consultants can see earlier consultants' contributions.
   */
  buildRoundNContext(council: Council, includeCurrentRound: boolean = false): string {
    const context = getCurrentContext(council.id);
    if (!context) {
      throw new Error('No context found');
    }

    let result = `SHARED CONTEXT (v${context.version}):\n${context.content}\n\n---\n`;

    const currentRound = council.deliberationState?.currentRound || 1;
    const useSummaries = this.shouldSummarize(council);
    const roundSummaries = council.deliberationState?.roundSummaries || {};

    // Always use summaries for old rounds (round 2+), full for most recent
    // This saves 30-40% of input tokens per round
    if (currentRound > 1) {
      // OLD rounds: summaries only (generate on-the-fly if missing)
      for (let r = 1; r < currentRound - 1; r++) {
        const summary = roundSummaries[r];
        if (summary) {
          result += `\nROUND ${r} SUMMARY:\n${summary}\n`;
        } else {
          // Fallback: generate mechanical summary instead of sending full entries
          const roundEntries = getEntriesForRound(council.id, r);
          if (roundEntries.length > 0) {
            const fallbackSummary = roundEntries
              .map(e => `${e.authorName || e.authorRole}: ${e.content.slice(0, 200)}`)
              .join('\n');
            result += `\nROUND ${r} SUMMARY:\n${fallbackSummary}\n`;
          }
        }
      }

      // MOST RECENT prior round: full entries (model needs detail for response)
      const recentEntries = getEntriesForRound(council.id, currentRound - 1);
      result += `\nROUND ${currentRound - 1}:\n`;
      result += formatEntriesForContext(recentEntries);
    }

    // Manager notes: summarize if more than 3, keep last 2 full
    const managerNotes = getManagerNotes(council.id, currentRound);
    if (managerNotes.length > 3) {
      const oldNotes = managerNotes.slice(0, -2);
      const recentNotes = managerNotes.slice(-2);
      result += `\n---\nMANAGER NOTES (earlier, summarized):\n`;
      result += oldNotes.map(n => `- ${n.content.slice(0, 150)}`).join('\n');
      result += `\n\nMANAGER NOTES (recent):\n`;
      result += formatEntriesForContext(recentNotes);
    } else if (managerNotes.length > 0) {
      result += `\n---\nMANAGER NOTES:\n`;
      result += formatEntriesForContext(managerNotes);
    }

    // In sequential mode, include current round entries so later consultants
    // can see what earlier consultants said in this round
    if (includeCurrentRound) {
      const currentRoundEntries = getEntriesForRound(council.id, currentRound);
      // Only include consultant entries (not manager entries which are from previous evaluation)
      const consultantEntries = currentRoundEntries.filter(e => e.authorRole === 'consultant');
      if (consultantEntries.length > 0) {
        result += `\n---\nCURRENT ROUND (so far):\n`;
        result += formatEntriesForContext(consultantEntries);
      }
    }

    return result;
  }

  /**
   * Build context for Manager evaluation - Section 9.4
   * Uses summaries for older rounds to keep token usage manageable.
   * Manager sees: shared context + summarised old rounds + full current round.
   */
  buildManagerEvalContext(council: Council): string {
    const context = getCurrentContext(council.id);
    const currentRound = council.deliberationState?.currentRound || 1;
    const roundSummaries = council.deliberationState?.roundSummaries || {};

    let result = `SHARED CONTEXT (v${context?.version || 1}):\n${context?.content || ''}\n\n---\n`;

    // For rounds 1-2 send full history (not much to summarize yet)
    // For rounds 3+ use summaries for older rounds, full for recent 2 rounds
    if (currentRound <= 2) {
      for (let r = 1; r <= currentRound; r++) {
        const roundEntries = getEntriesForRound(council.id, r);
        if (roundEntries.length > 0) {
          result += `\nROUND ${r}:\n`;
          result += formatEntriesForContext(roundEntries);
        }
      }
    } else {
      // Old rounds: summaries (rounds 1 to currentRound-2)
      for (let r = 1; r <= currentRound - 2; r++) {
        const summary = roundSummaries[r];
        if (summary) {
          result += `\nROUND ${r} SUMMARY:\n${summary}\n`;
        } else {
          // No summary available yet — use full entries as fallback
          const roundEntries = getEntriesForRound(council.id, r);
          result += `\nROUND ${r}:\n`;
          result += formatEntriesForContext(roundEntries);
        }
      }

      // Recent 2 rounds: full entries (manager needs detail for evaluation)
      for (let r = Math.max(1, currentRound - 1); r <= currentRound; r++) {
        const roundEntries = getEntriesForRound(council.id, r);
        if (roundEntries.length > 0) {
          result += `\nROUND ${r}:\n`;
          result += formatEntriesForContext(roundEntries);
        }
      }
    }

    // Manager notes for current round only (old notes are captured in summaries)
    const managerNotes = getManagerNotes(council.id, currentRound);
    if (managerNotes.length > 0) {
      result += `\n---\nMANAGER NOTES:\n`;
      result += formatEntriesForContext(managerNotes);
    }

    return result;
  }

  /**
   * Build context for decision - Section 9.5
   * Same as manager eval context (uses summaries for older rounds).
   */
  buildDecisionContext(council: Council): string {
    return this.buildManagerEvalContext(council);
  }

  /**
   * Build context for directive - Section 9.6
   */
  buildDirectiveContext(council: Council): string {
    const decision = getDecision(council.id);
    const plan = getPlan(council.id);

    let result = `YOUR DECISION:\n${decision?.content || ''}\n`;

    if (plan) {
      result += `\nPLAN:\n${plan.content}\n`;
    }

    return result;
  }

  /**
   * Build context for Worker - Section 9.7
   * ONLY directive, no deliberation history
   */
  buildWorkerContext(council: Council): string {
    const directive = getDirective(council.id);
    return `DIRECTIVE:\n${directive?.content || ''}`;
  }

  /**
   * Build context for revision - Section 9.7.1
   */
  buildRevisionContext(council: Council): string {
    const directive = getDirective(council.id);
    const previousOutput = getLatestOutput(council.id);
    const revisionRequest = getLatestOfType(council.id, 'revision_request');

    return `DIRECTIVE:\n${directive?.content || ''}\n\nYOUR PREVIOUS OUTPUT:\n${previousOutput?.content || ''}\n\nREVISION FEEDBACK:\n${revisionRequest?.content || ''}`;
  }

  /**
   * Build context for review - Section 9.8
   */
  buildReviewContext(council: Council): string {
    const directive = getDirective(council.id);
    const output = getLatestOutput(council.id);
    const decision = getDecision(council.id);

    let result = `WORK DIRECTIVE:\n${directive?.content || ''}\n`;

    if (decision?.acceptanceCriteria) {
      result += `\nACCEPTANCE CRITERIA:\n${decision.acceptanceCriteria}\n`;
    }

    result += `\nWORKER OUTPUT:\n${output?.content || ''}`;

    return result;
  }

  /**
   * Build context for forced decision - Section 9.9
   */
  buildForcedDecisionContext(council: Council): string {
    const context = getCurrentContext(council.id);
    const entries = getAllEntries(council.id);

    let result = `SHARED CONTEXT (v${context?.version || 1}):\n${context?.content || ''}\n\n---\n`;
    result += `DELIBERATION SO FAR (incomplete):\n`;
    result += formatEntriesForContext(entries);

    return result;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Determine if summarization should be used
   */
  shouldSummarize(council: Council): boolean {
    const config = council.deliberation;
    if (!config) return false;

    if (config.summaryMode === 'none') return false;

    const currentRound = council.deliberationState?.currentRound || 1;
    // Always summarize after round 1 completes
    if (currentRound <= 1) return false;

    // Always summarize from round 2+ (was round 3+, changed for cost efficiency)
    return true;

    return false;
  }

  /**
   * Get the next valid phase based on current state and action
   */
  getNextPhase(
    council: Council,
    action?: 'continue' | 'decide' | 'redirect' | 'accept' | 'revise' | 're_deliberate'
  ): DeliberationPhase {
    const currentPhase = council.deliberationState?.currentPhase || 'created';
    const validNext = PHASE_TRANSITIONS[currentPhase].validNext;

    if (validNext.length === 0) {
      return currentPhase; // Terminal state
    }

    // Determine next based on action
    switch (currentPhase) {
      case 'round_waiting_for_manager':
        if (action === 'decide') return 'deciding';
        if (action === 'continue' || action === 'redirect') return 'round_interactive';
        return 'deciding';

      case 'deciding':
        return council.deliberation?.requirePlan ? 'planning' : 'directing';

      case 'reviewing':
        if (action === 'accept') return 'completed';
        if (action === 'revise') return 'revising';
        if (action === 're_deliberate') return 'round_interactive';
        return 'completed';

      default:
        return validNext[0];
    }
  }

  /**
   * Check if current phase is complete and can transition
   */
  isPhaseComplete(council: Council): boolean {
    const phase = council.deliberationState?.currentPhase;

    switch (phase) {
      case 'round_independent':
      case 'round_interactive':
        return councilStore.isRoundComplete(council.id);
      default:
        return true;
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private getManager(council: Council): Persona {
    const managers = getPersonaByRole(council, 'manager');
    if (managers.length === 0) {
      throw new Error('No manager assigned to council');
    }
    return managers[0];
  }

  private getConsultants(council: Council): Persona[] {
    return getPersonaByRole(council, 'consultant');
  }

  private getWorker(council: Council): Persona {
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No worker assigned to council');
    }
    return workers[0];
  }

  private getPersonaDisplayName(council: Council, personaId: string): string {
    const persona = council.personas.find((p) => p.id === personaId);
    return persona?.name || personaId;
  }

  private validatePhase(council: Council, expected: DeliberationPhase): void {
    // If deliberationState is undefined, treat as 'created'
    const current = council.deliberationState?.currentPhase ?? 'created';
    if (current !== expected) {
      throw new Error(`Invalid phase: expected ${expected}, got ${current}`);
    }
  }

  private transitionPhase(councilId: string, to: DeliberationPhase): void {
    const council = councilStore.get(councilId);
    const from = council?.deliberationState?.currentPhase || 'created';

    // Validate transition
    const validNext = PHASE_TRANSITIONS[from].validNext;
    if (!validNext.includes(to) && from !== 'paused') {
      console.warn(`[Orchestrator] Invalid phase transition: ${from} -> ${to}`);
    }

    councilStore.setDeliberationPhase(councilId, to, from);
    this.config.onPhaseChange?.(from, to);

    console.log(`[Orchestrator] Phase transition: ${from} -> ${to}`);
  }

  private async invokeAgentSafe(
    invocation: AgentInvocation,
    persona: Persona,
    context: string
  ): Promise<AgentResponse> {
    // Scope tool access by phase/role:
    //   Built-in tools (WebSearch, WebFetch) are always included for any tool-enabled phase.
    //   Workers (execution, revision, debug): full tools + search
    //   Planning workers: limited tools (Read, Write, Glob — save plan doc, no code editing)
    //   Consultants (independent_analysis, deliberation_response): read-only + search
    //   Reviewers (code_review): read-only + search
    //   Manager phases: no tools
    const BUILTIN_TOOLS = ['WebSearch', 'WebFetch'];
    const FULL_TOOLS = [...BUILTIN_TOOLS, 'Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep'];
    const PLAN_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Write', 'Glob'];
    const READ_ONLY_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Grep', 'Glob'];
    const MANAGER_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Glob', 'Grep', 'Bash'];

    const council = this.activeCouncilId ? councilStore.get(this.activeCouncilId) : null;
    const stepType = council?.deliberation?.stepType;

    const workerToolPhases = ['execution', 'revision', 'debug'];
    const readOnlyToolPhases = ['independent_analysis', 'deliberation_response', 'code_review'];
    const managerToolPhases = ['problem_framing', 'directive', 'review'];

    if (workerToolPhases.includes(context)) {
      // Planning workers get limited tools (no Edit, Bash, Grep — prevents code writing)
      // Coding/other workers get full tools
      if (stepType === 'code_planning') {
        invocation = { ...invocation, allowedTools: PLAN_TOOLS };
      } else {
        invocation = { ...invocation, allowedTools: FULL_TOOLS };
      }
    } else if (readOnlyToolPhases.includes(context)) {
      invocation = { ...invocation, allowedTools: READ_ONLY_TOOLS };
    } else if (managerToolPhases.includes(context)) {
      invocation = { ...invocation, allowedTools: MANAGER_TOOLS };
    } else if (!invocation.skipTools) {
      invocation = { ...invocation, skipTools: true };
    }

    // Compute effective allowed servers (intersection of step + persona)
    const stepServers = council?.deliberation?.allowedServerIds;
    const personaServers = persona.allowedServerIds;
    let effectiveServers: string[] | undefined;
    if (stepServers && personaServers) {
      effectiveServers = stepServers.filter(id => personaServers.includes(id));
    } else {
      effectiveServers = personaServers || stepServers;
    }
    if (effectiveServers) {
      invocation = { ...invocation, allowedServerIds: effectiveServers };
    }

    // Apply per-persona tool access overrides from role assignment
    const roleAssignment = council?.deliberation?.roleAssignments
      ?.find(r => r.personaId === persona.id);

    console.log(`[Orchestrator:ToolAccess] persona=${persona.name} context=${context} roleAssignment.toolAccess=${roleAssignment?.toolAccess} roleAssignment.found=${!!roleAssignment} totalAssignments=${council?.deliberation?.roleAssignments?.length}`);

    if (roleAssignment?.toolAccess === 'none') {
      invocation = { ...invocation, skipTools: true };
    } else if (roleAssignment?.toolAccess === 'full') {
      const { skipTools: _, ...rest } = invocation;
      invocation = rest as AgentInvocation;
    }

    if (roleAssignment?.allowedServerIds) {
      invocation = { ...invocation, allowedServerIds: roleAssignment.allowedServerIds };
    }

    // Inject bootstrapped context into every prompt — cacheable if prompt caching is enabled.
    if (this.bootstrappedContext) {
      const hasContext = invocation.userMessage.includes(this.bootstrappedContext.slice(0, 100));
      if (!hasContext) {
        // Instead of injecting into userMessage, pass as separate cacheableContext
        // so Anthropic's prompt caching can deduplicate it across calls
        invocation = {
          ...invocation,
          cacheableContext: `## PROJECT CONTEXT\n\nThe complete source code and project structure are provided below. This is your primary source of information. Analyze the code directly from what is provided here.\n\n${this.bootstrappedContext}`,
          userMessage: invocation.userMessage, // Keep userMessage clean
        };
      }
    }

    // Inject brevity instruction if maxWordsPerResponse is configured
    const wordLimit = this.activeCouncilId
      ? councilStore.get(this.activeCouncilId)?.deliberation?.maxWordsPerResponse
      : undefined;
    if (wordLimit && wordLimit > 0) {
      invocation = {
        ...invocation,
        userMessage: invocation.userMessage +
          `\n\nIMPORTANT: Keep your response concise — aim for approximately ${wordLimit} words or fewer. Be direct and avoid unnecessary elaboration.`,
      };
    }

    // Thread working directory from council so each invocation uses its own dir
    const councilDir = council?.deliberation?.workingDirectory;
    if (councilDir) {
      invocation = { ...invocation, workingDirectory: councilDir };
    }

    // Apply role-based default timeouts if not already set
    const DEFAULT_TIMEOUTS: Record<string, number> = {
      // Worker contexts — 30 min
      execution: 1_800_000,
      revision: 1_800_000,
      debug: 1_800_000,
      direct_execution: 1_800_000,
      // Manager contexts — 10 min
      problem_framing: 600_000,
      evaluation: 600_000,
      manager_evaluation: 600_000,
      decision: 600_000,
      forced_decision: 600_000,
      directive: 600_000,
      plan: 600_000,
      review: 600_000,
      round_summary: 600_000,
      // Consultant contexts — 10 min
      independent_analysis: 600_000,
      deliberation_response: 600_000,
      final_position: 600_000,
      consultant_review: 600_000,
    };
    invocation = { ...invocation, timeoutMs: invocation.timeoutMs ?? DEFAULT_TIMEOUTS[context] ?? 600_000 };

    // Build context inspection for this call
    const toolScope: ContextInspection['toolScope'] = invocation.skipTools ? 'none'
      : invocation.allowedTools === FULL_TOOLS ? 'full'
      : invocation.allowedTools === PLAN_TOOLS ? 'plan'
      : invocation.allowedTools === READ_ONLY_TOOLS ? 'read_only'
      : invocation.allowedTools === MANAGER_TOOLS ? 'manager'
      : invocation.allowedTools ? 'read_only' // custom list after override
      : 'none';

    const systemPromptSource = workerToolPhases.includes(context) ? 'minimal_worker'
      : readOnlyToolPhases.includes(context) && context === 'code_review' ? 'reviewer'
      : readOnlyToolPhases.includes(context) ? 'persona_predisposition'
      : 'persona_predisposition';

    const inspection = buildContextInspection({
      systemPrompt: invocation.systemPrompt,
      systemPromptSource,
      userMessage: invocation.userMessage,
      toolScope,
      toolNames: invocation.allowedTools,
      effectiveServerIds: invocation.allowedServerIds,
      wordLimitApplied: wordLimit && wordLimit > 0 ? wordLimit : undefined,
      contextTokenBudget: council?.deliberation?.contextTokenBudget,
      timeoutMs: invocation.timeoutMs,
    });

    // Retry transient errors (rate limits, overload) with exponential backoff.
    // This covers ALL roles (manager, consultant, worker) uniformly.
    // Timeout errors get 1 retry (no backoff — the timeout itself was the wait).
    const MAX_TRANSIENT_RETRIES = 5;
    const BASE_DELAY_MS = 15_000; // 15 seconds

    const sysPromptKB = (invocation.systemPrompt.length / 1024).toFixed(1);
    const userMsgKB = (invocation.userMessage.length / 1024).toFixed(1);
    const toolCount = invocation.allowedTools?.length || 0;
    console.log(
      `[Orchestrator:Call] ${persona.name} (${context}) — ` +
      `system: ${sysPromptKB}KB, user: ${userMsgKB}KB, tools: ${toolCount}, ` +
      `timeout: ${Math.round((invocation.timeoutMs || 0) / 1000)}s`
    );

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        const startedAt = Date.now();
        this.config.onAgentThinkingStart?.(persona, startedAt, invocation.userMessage);
        const response = await this.config.invokeAgent(invocation, persona);
        this.config.onAgentThinkingEnd?.(persona);
        const callDuration = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[Orchestrator:Call] ${persona.name} (${context}) completed in ${callDuration}s — ${response.tokensUsed} tokens`);
        // Attach context inspection to the response
        response.structured = { ...response.structured, contextInspection: inspection };
        return response;
      } catch (error) {
        this.config.onAgentThinkingEnd?.(persona);

        const errMsg = error instanceof Error ? error.message : String(error);
        const isTransient = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);
        const isTimeout = /\btimed?\s*out\b/i.test(errMsg);

        // Timeout: retry once, then fail
        if (isTimeout && attempt === 0) {
          const elapsedMs = invocation.timeoutMs || 0;
          console.warn(`[Orchestrator] ${persona.name} (${context}) timed out after ${Math.round(elapsedMs / 1000)}s, retrying once...`);
          this.config.onAgentTimeout?.(persona, context, elapsedMs);
          this.config.onError?.(new Error(`${persona.name} timed out — retrying`), context);
          continue; // retry once
        }

        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[Orchestrator] Transient error for ${persona.name} (${context}), ` +
            `retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES}): ${errMsg}`
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }

        this.config.onError?.(error as Error, context);
        throw error;
      }
    }

    // Should not reach here
    throw new Error('Unexpected: exhausted transient retry loop');
  }

  /**
   * Clean JSON artifacts from LLM responses for display.
   * LLMs sometimes respond with JSON when prompted for structured output.
   * This extracts readable text from those responses.
   */
  cleanLLMResponse(content: string): string {
    if (!content || typeof content !== 'string') return content;

    const trimmed = content.trim();

    // Try to extract JSON from various formats
    const jsonStr = this.extractJsonString(trimmed);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        const formatted = this.formatParsedJson(parsed);
        if (formatted) return formatted;
      } catch {
        // Not valid JSON, fall through
      }
    }

    // Check if content is text followed by a raw JSON object at the end
    const trailingJsonMatch = trimmed.match(/^([\s\S]+?)\n\s*(\{[\s\S]*\})\s*$/);
    if (trailingJsonMatch) {
      const textPart = trailingJsonMatch[1].trim();
      try {
        JSON.parse(trailingJsonMatch[2]);
        if (textPart.length > 20) return textPart;
      } catch {
        // Not JSON, return as-is
      }
    }

    return content;
  }

  /**
   * Extract a JSON string from content that may be raw JSON, markdown-wrapped, etc.
   */
  private extractJsonString(trimmed: string): string | null {
    // Raw JSON object
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed;
    }

    // Markdown code block: ```json\n{...}\n```
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1];
    }

    return null;
  }

  /**
   * Format a parsed JSON object into readable text.
   * Handles evaluation/review/decision structured responses.
   */
  private formatParsedJson(parsed: Record<string, unknown>): string | null {
    // Check for structured responses FIRST (action/verdict indicate eval/review)
    // These have multiple important fields that should all be shown
    if (parsed.action || parsed.verdict) {
      const parts: string[] = [];
      if (parsed.verdict && typeof parsed.verdict === 'string')
        parts.push(`Verdict: ${parsed.verdict}`);
      if (parsed.action && typeof parsed.action === 'string')
        parts.push(`Action: ${parsed.action}`);
      if (parsed.confidence != null)
        parts.push(`Confidence: ${Math.round((parsed.confidence as number) * 100)}%`);
      if (parsed.reasoning && typeof parsed.reasoning === 'string')
        parts.push(parsed.reasoning);
      if (parsed.feedback && typeof parsed.feedback === 'string')
        parts.push(`Feedback: ${parsed.feedback}`);
      if (parsed.question && typeof parsed.question === 'string')
        parts.push(`Question: ${parsed.question}`);
      if (parsed.newInformation && typeof parsed.newInformation === 'string')
        parts.push(`New information: ${parsed.newInformation}`);
      if (Array.isArray(parsed.missingInformation) && parsed.missingInformation.length)
        parts.push(`Missing: ${parsed.missingInformation.join(', ')}`);
      if (parts.length > 0) return parts.join('\n\n');
    }

    // For plain content responses, extract the main text field
    const textFields = ['reasoning', 'content', 'message', 'summary', 'analysis', 'feedback', 'explanation'];
    for (const field of textFields) {
      if (parsed[field] && typeof parsed[field] === 'string') {
        return parsed[field] as string;
      }
    }

    return null;
  }

  private createEntry(
    councilId: string,
    role: DeliberationRole,
    authorId: string,
    entryType: LedgerEntryType,
    phase: DeliberationPhase,
    content: string,
    tokensUsed: number,
    latencyMs: number,
    artifactRefs?: ArtifactRef[],
    roundNumber?: number,
    structured?: Record<string, unknown>,
    referencedEntries?: string[],
    reviewOutcome?: 'accept' | 'revise' | 're_deliberate'
  ): LedgerEntry {
    // Clean JSON artifacts from LLM responses before storing
    const cleanedContent = this.cleanLLMResponse(content);

    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      authorRole: role,
      authorPersonaId: authorId,
      entryType,
      phase,
      content: cleanedContent,
      tokensUsed,
      latencyMs,
      artifactRefs,
      roundNumber,
      referencedEntries,
      reviewOutcome,
      structured,
    };

    // Use ledgerStore.append to notify subscribers (enables real-time UI updates)
    ledgerStore.append(councilId, entry);
    this.config.onEntryAdded?.(entry);

    return entry;
  }

  private extractContextProposal(content: string): { diff: string; rationale: string } | null {
    const proposalMatch = content.match(/PROPOSED CONTEXT CHANGE:\s*\n*What:\s*(.+?)(?:\n+Why:\s*(.+))?$/is);

    if (proposalMatch) {
      return {
        diff: proposalMatch[1].trim(),
        rationale: proposalMatch[2]?.trim() || 'No rationale provided',
      };
    }
    return null;
  }

  /**
   * Append a summary to the shared context document when evolveContext is enabled.
   * Creates a new context version with the appended information.
   */
  private appendToContext(
    councilId: string,
    label: string,
    personaName: string,
    content: string,
    role: 'consultant' | 'worker' | 'manager',
    personaId?: string,
  ): void {
    const council = this.activeCouncilId ? councilStore.get(this.activeCouncilId) : null;
    if (!council?.deliberation?.evolveContext) return;

    const currentContext = getCurrentContext(councilId);
    if (!currentContext) return;

    // Extract a concise summary — first 2000 chars or up to COMPLETION SUMMARY
    const summaryMatch = content.match(/## COMPLETION SUMMARY[\s\S]*/i);
    const summary = summaryMatch
      ? summaryMatch[0].slice(0, 1500)
      : content.slice(0, 2000);

    const round = council.deliberationState?.currentRound || 1;
    const appendText = `\n\n---\n[Round ${round} — ${label} by ${personaName}]:\n${summary}`;

    const updated = createContextVersion(
      councilId,
      currentContext.content + appendText,
      `${label} by ${personaName} (round ${round})`,
      role,
      personaId,
      round,
    );

    councilStore.setActiveContext(councilId, updated.id, updated.version);
    console.log(`[Orchestrator] Context evolved to v${updated.version}: ${label} by ${personaName}`);
  }

  private extractAcceptanceCriteria(content: string): string | undefined {
    const match = content.match(/ACCEPTANCE CRITERIA[:\s]*\n*([\s\S]*?)(?=\n\n|$)/i);
    return match?.[1]?.trim();
  }

  private parseManagerEvaluation(content: string): ManagerEvaluation {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Filter patchDecisions to only include entries with valid UUID patchIds
        // (the LLM may hallucinate non-UUID strings)
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const patchDecisions = Array.isArray(parsed.patchDecisions)
          ? parsed.patchDecisions.filter(
              (d: any) => d && typeof d.patchId === 'string' && UUID_RE.test(d.patchId)
            )
          : undefined;

        return {
          action: parsed.action || 'decide',
          reasoning: parsed.reasoning || content,
          confidence: parsed.confidence ?? undefined,
          missingInformation: parsed.missingInformation ?? undefined,
          question: parsed.question ?? undefined,
          patchDecisions: patchDecisions && patchDecisions.length > 0 ? patchDecisions : undefined,
        };
      }
    } catch {
      // Fall back to text parsing
    }

    // Default interpretation from text
    const lowerContent = content.toLowerCase();
    let action: 'continue' | 'decide' | 'redirect' = 'decide';

    if (lowerContent.includes('continue') || lowerContent.includes('another round')) {
      action = 'continue';
    } else if (lowerContent.includes('redirect') || lowerContent.includes('refocus')) {
      action = 'redirect';
    }

    return {
      action,
      reasoning: content,
    };
  }

  private parseManagerReview(content: string): ManagerReview {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          verdict: parsed.verdict || 'accept',
          reasoning: parsed.reasoning || content,
          feedback: parsed.feedback ?? undefined,
          newInformation: parsed.newInformation ?? undefined,
        };
      }
    } catch {
      // Fall back to text parsing
    }

    // Default interpretation
    const lowerContent = content.toLowerCase();
    let verdict: 'accept' | 'revise' | 're_deliberate' = 'accept';

    if (lowerContent.includes('revise') || lowerContent.includes('revision')) {
      verdict = 'revise';
    } else if (lowerContent.includes('re-deliberate') || lowerContent.includes('redeliberate')) {
      verdict = 're_deliberate';
    }

    return {
      verdict,
      reasoning: content,
    };
  }

  /**
   * Run a single consultant's contribution with retry logic.
   * Ensures every consultant gets a fair chance to contribute:
   * - 'retry' policy: retries up to maxRetries times with backoff
   * - 'skip' policy: records error and moves on
   * - 'fail' policy: fails the entire deliberation
   *
   * On final failure, records the submission anyway so the round can complete.
   */
  private async runConsultantWithRetry(
    council: Council,
    consultant: Persona,
    runFn: () => Promise<LedgerEntry>
  ): Promise<LedgerEntry | null> {
    const maxRetries = council.deliberation?.maxRetries || 2;
    const policy = council.deliberation?.consultantErrorPolicy || 'retry';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await runFn();
      } catch (error) {
        const isLastAttempt = attempt >= maxRetries || policy !== 'retry';

        console.error(
          `[Orchestrator] Consultant ${consultant.name} failed (attempt ${attempt + 1}/${maxRetries + 1}):`,
          (error as Error).message
        );

        councilStore.addError(
          council.id,
          `Consultant ${consultant.name}: ${(error as Error).message} (attempt ${attempt + 1})`
        );

        if (policy === 'fail') {
          this.transitionPhase(council.id, 'failed');
          throw error;
        }

        if (isLastAttempt) {
          // Record submission for failed consultant so the round can still complete
          councilStore.recordSubmission(council.id, consultant.id);

          // Create an error entry in the ledger so it's visible in the UI
          this.createEntry(
            council.id,
            'consultant',
            consultant.id,
            'error',
            council.deliberationState?.currentPhase || 'round_independent',
            `Failed to contribute after ${attempt + 1} attempt(s): ${(error as Error).message}`,
            0,
            0,
            undefined,
            council.deliberationState?.currentRound
          );

          return null;
        }

        // Delay before retry — longer backoff for rate limit errors
        const errMsg = (error as Error).message || '';
        const isRateLimit = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);
        const delayMs = isRateLimit
          ? 15_000 * Math.pow(2, attempt)  // 15s, 30s, 60s for rate limits
          : 2_000 * (attempt + 1);          // 2s, 4s, 6s for other errors
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return null;
  }
}
