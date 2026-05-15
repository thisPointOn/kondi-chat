/**
 * Council: Coding Orchestrator
 * Structured multi-worker implementation flow for coding pipeline steps.
 *
 * Flow: spec → decompose → implement (parallel) → review → test → debug loop
 *
 * Reuses the same agent invocation, ledger, and store patterns as
 * DeliberationOrchestrator but skips consultant deliberation entirely.
 */

import type {
  Council,
  Persona,
  LedgerEntry,
  LedgerEntryType,
  DeliberationPhase,
  DeliberationRole,
  ArtifactRef,
  ReviewVerdict,
} from './types';

import {
  ledgerStore,
} from './ledger-store';

import {
  createOutput,
  getCurrentContext,
  createContextVersion,
} from './context-store';

import {
  councilStore,
  getPersonaByRole,
  getRoleAssignment,
} from './store';

import {
  buildDecompositionPrompt,
  buildModuleDirectivePrompt,
  buildCodeReviewPrompt,
  buildReviewerSystemPrompt,
  buildDebugFixPrompt,
  buildRevisionFromReviewPrompt,
  getMinimalWorkerSystemPrompt,
  type WorkerPermissions,
} from './prompts';

import { bootstrapDirectoryContext } from './context-bootstrap';
import { detectTestCommand } from '../pipeline/test-detect';
import { detectBuildCommand } from '../pipeline/build-detect';
import { detectInstallCommand } from '../pipeline/install-detect';

// Re-use the same agent invocation types from deliberation-orchestrator
export interface AgentInvocation {
  personaId: string;
  systemPrompt: string;
  userMessage: string;
  skipTools?: boolean;
  /** MCP servers this invocation can access (undefined = all servers) */
  allowedServerIds?: string[];
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

export interface CodingOrchestratorConfig {
  invokeAgent: AgentInvoker;
  runCommand?: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;
  readFile?: (path: string) => Promise<string | null>;
  onPhaseChange?: (from: DeliberationPhase, to: DeliberationPhase) => void;
  onEntryAdded?: (entry: LedgerEntry) => void;
  onError?: (error: Error, context: string) => void;
  onAgentThinkingStart?: (persona: Persona, startedAt: number) => void;
  onAgentThinkingEnd?: (persona: Persona) => void;
  onAgentTimeout?: (persona: Persona, context: string, elapsedMs: number) => void;
}

// ============================================================================
// Phase Transition Table (coding-specific)
// ============================================================================

const CODING_PHASE_TRANSITIONS: Record<string, {
  validNext: DeliberationPhase[];
  terminal: boolean;
}> = {
  created:        { validNext: ['decomposing'], terminal: false },
  decomposing:    { validNext: ['implementing'], terminal: false },
  implementing:   { validNext: ['code_reviewing', 'completed'], terminal: false },
  code_reviewing: { validNext: ['implementing', 'testing', 'completed'], terminal: false },
  testing:        { validNext: ['completed', 'debugging'], terminal: false },
  debugging:      { validNext: ['testing'], terminal: false },
  completed:      { validNext: [], terminal: true },
  failed:         { validNext: [], terminal: true },
  cancelled:      { validNext: [], terminal: true },
};

// ============================================================================
// Coding Orchestrator
// ============================================================================

export class CodingOrchestrator {
  private config: CodingOrchestratorConfig;
  /** Active council ID for the current workflow */
  private activeCouncilId: string | null = null;
  /** Bootstrapped directory context — shared with all personas via prompt */
  private bootstrappedContext: string = '';
  /** Phase-level rate limit retry count (reset per workflow start) */
  private phaseRetryCount = 0;

  constructor(config: CodingOrchestratorConfig) {
    this.config = config;
  }

  /**
   * Main entry point: run the full coding workflow.
   */
  async runCodingWorkflow(council: Council, spec: string): Promise<void> {
    console.log('[CodingOrchestrator] Starting coding workflow...');
    this.activeCouncilId = council.id;

    // Always read fresh from store
    council = councilStore.get(council.id) || council;

    const maxReviewCycles = council.deliberation?.maxReviewCycles ?? 2;
    const maxDebugCycles = council.deliberation?.maxDebugCycles ?? 5;

    let snapshotSha: string | null = null;
    this.phaseRetryCount = 0;

    const warnings: string[] = [];

    // Bootstrap directory context if enabled — stored for all personas
    let enrichedSpec = spec;
    if (council.deliberation?.bootstrapContext && council.deliberation?.workingDirectory) {
      try {
        const dirContext = await bootstrapDirectoryContext(council.deliberation.workingDirectory, { deep: true });
        if (dirContext) {
          this.bootstrappedContext = dirContext;
          enrichedSpec = `${dirContext}\n\n---\n\n${spec}`;
        }
      } catch (error) {
        console.warn('[CodingOrchestrator] Directory context bootstrap failed:', error);
      }
    }

    try {
      // Git snapshot before any changes
      snapshotSha = await this.createGitSnapshot(council);

      // Phase 1: Decompose
      this.transitionPhase(council.id, 'decomposing');
      try {
        await this.decomposeSpec(council, enrichedSpec);
      } catch (decomposeError) {
        const errMsg = (decomposeError as Error).message || String(decomposeError);
        console.error('[CodingOrchestrator] Decompose failed, using fallback single-module:', errMsg);
        warnings.push(`Decomposition failed (${errMsg}) — used raw spec as single module`);

        const manager = this.getManager(council);
        this.createEntry(
          council.id, 'manager', manager.id, 'error', 'decomposing',
          `Decomposition failed: ${errMsg}. Falling back to single-module plan.`,
          0, 0
        );

        // Fallback: single "main" module using the raw spec as the directive
        councilStore.updateDeliberationState(council.id, {
          moduleDecomposition: {
            modules: [{ name: 'main', files: [], interfaces: '', dependencies: [], directive: spec }],
            integrationNotes: '',
            testStrategy: '',
            buildCommand: '',
            installCommand: '',
          },
          moduleOutputs: {},
        });
      }

      // Phase 2+3: Implement → Review loop
      let reviewCycleCount = 0;
      while (true) {
        council = councilStore.get(council.id)!;

        this.transitionPhase(council.id, 'implementing');
        await this.implementModules(council, spec, reviewCycleCount > 0);
        council = councilStore.get(council.id)!;

        // Check if reviewer exists
        const reviewers = getPersonaByRole(council, 'reviewer');
        if (reviewers.length === 0) {
          console.log('[CodingOrchestrator] No reviewer configured — skipping code review');
          break;
        }

        this.transitionPhase(council.id, 'code_reviewing');
        let verdict: ReviewVerdict;
        try {
          verdict = await this.reviewCode(council, spec);
        } catch (reviewError) {
          const errMsg = (reviewError as Error).message || String(reviewError);
          console.error('[CodingOrchestrator] Review failed, skipping:', errMsg);
          warnings.push(`Code review skipped (${errMsg})`);

          const reviewers = getPersonaByRole(council, 'reviewer');
          const authorId = reviewers[0]?.id || this.getManager(council).id;
          this.createEntry(
            council.id, 'reviewer', authorId, 'error', 'code_reviewing',
            `Code review failed: ${errMsg}. Skipping review phase.`,
            0, 0
          );

          verdict = { verdict: 'pass', issues: [], summary: `Review skipped due to error: ${errMsg}` };
        }

        if (verdict.verdict === 'pass') {
          console.log('[CodingOrchestrator] Code review passed');
          break;
        }

        reviewCycleCount++;
        councilStore.updateDeliberationState(council.id, { reviewCycleCount });

        if (reviewCycleCount >= maxReviewCycles) {
          console.log(`[CodingOrchestrator] Max review cycles (${maxReviewCycles}) reached — proceeding`);
          break;
        }

        // Store formatted review issues so revision workers get clear, actionable feedback
        // instead of raw LLM output mixed with tool-use noise
        this.storeFormattedReviewFeedback(council, verdict);

        console.log(`[CodingOrchestrator] Review cycle ${reviewCycleCount}/${maxReviewCycles} — revising`);
        council = councilStore.get(council.id)!;
      }

      // Phase 4: Test loop (build + test verification)
      council = councilStore.get(council.id)!;
      const decomposition = council.deliberationState?.moduleDecomposition;
      const installCommand = decomposition?.installCommand || await this.autoDetectInstallCommand(council);
      const buildCommand = decomposition?.buildCommand || await this.autoDetectBuildCommand(council);
      const testCommand = council.deliberation?.testCommand || await this.autoDetectTestCommand(council);

      // Combine install + build + test into one verification command
      const commandParts = [installCommand, buildCommand, testCommand].filter(Boolean);
      const verifyCommand = commandParts.length > 0 ? commandParts.join(' && ') : null;

      if (verifyCommand) {
        let debugCycleCount = 0;
        while (true) {
          this.transitionPhase(council.id, 'testing');
          const testResult = await this.runTests(council, verifyCommand);

          if (testResult.passed) {
            console.log('[CodingOrchestrator] Tests passed!');
            break;
          }

          debugCycleCount++;
          councilStore.updateDeliberationState(council.id, { debugCycleCount });

          if (debugCycleCount >= maxDebugCycles) {
            console.log(`[CodingOrchestrator] Max debug cycles (${maxDebugCycles}) reached`);
            break;
          }

          console.log(`[CodingOrchestrator] Debug cycle ${debugCycleCount}/${maxDebugCycles}`);
          this.transitionPhase(council.id, 'debugging');
          try {
            await this.debugFix(council, testResult.output, spec);
          } catch (debugError) {
            const errMsg = (debugError as Error).message || String(debugError);
            console.error('[CodingOrchestrator] Debug fix failed, proceeding with current code:', errMsg);
            warnings.push(`Debug fix failed (${errMsg}) — proceeding with existing code`);

            const workers = getPersonaByRole(council, 'worker');
            const authorId = workers[0]?.id || this.getManager(council).id;
            this.createEntry(
              council.id, 'worker', authorId, 'error', 'debugging',
              `Debug fix failed: ${errMsg}. Proceeding with current code.`,
              0, 0
            );

            break;
          }
          council = councilStore.get(council.id)!;
        }
      } else {
        console.log('[CodingOrchestrator] No build or test command found — skipping verification phase');
      }

      // Phase 5: Merge outputs and complete
      council = councilStore.get(council.id)!;
      await this.mergeAndComplete(council, spec, warnings);

    } catch (error) {
      const errMsg = (error as Error).message || String(error);
      const isRateLimit = /\b(429|rate.limit|too many requests)\b/i.test(errMsg);

      council = councilStore.get(council.id)!;
      const currentPhase = council.deliberationState?.currentPhase;

      // Rate limit: wait and retry from the current phase instead of failing
      if (isRateLimit && this.phaseRetryCount < 3) {
        this.phaseRetryCount++;
        const delayMs = 120_000 * Math.pow(1.5, this.phaseRetryCount - 1);
        console.warn(
          `[CodingOrchestrator] Rate limit during ${currentPhase}, retrying in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${this.phaseRetryCount}/3)`
        );
        this.createEntry(
          council.id, 'manager', this.getManager(council).id, 'error',
          currentPhase || 'created',
          `Rate limited during ${currentPhase} — waiting ${Math.round(delayMs / 1000)}s before retrying...`,
          0, 0
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        // Re-run from current phase — the workflow reads state from the store
        // so it will resume from where it left off
        return this.runCodingWorkflow(councilStore.get(council.id)!, spec);
      }

      console.error('[CodingOrchestrator] Workflow error:', errMsg);

      // Attribute error to the phase's active role
      try {
        const isWorkerPhase = currentPhase === 'implementing' || currentPhase === 'debugging';
        const isReviewerPhase = currentPhase === 'code_reviewing';
        const role: DeliberationRole = isWorkerPhase ? 'worker' : isReviewerPhase ? 'reviewer' : 'manager';

        let persona: Persona;
        if (isWorkerPhase) {
          const workers = getPersonaByRole(council, 'worker');
          persona = workers[0] || this.getManager(council);
        } else if (isReviewerPhase) {
          const reviewers = getPersonaByRole(council, 'reviewer');
          persona = reviewers[0] || this.getManager(council);
        } else {
          persona = this.getManager(council);
        }

        this.createEntry(
          council.id, role, persona.id, 'error',
          currentPhase || 'created',
          `Coding workflow error during ${currentPhase}: ${errMsg}`,
          0, 0
        );
      } catch { /* best effort */ }

      if (snapshotSha) {
        console.log(`[CodingOrchestrator] Pre-pipeline snapshot: ${snapshotSha}. Rollback: git reset --hard ${snapshotSha}`);
      }

      this.transitionPhase(council.id, 'failed');
      throw error;
    }
  }

  // ==========================================================================
  // Phase 1: Decompose Spec
  // ==========================================================================

  private async decomposeSpec(council: Council, spec: string): Promise<void> {
    const manager = this.getManager(council);
    const workers = getPersonaByRole(council, 'worker');
    const workerCount = Math.max(workers.length, 1);

    console.log(`[CodingOrchestrator] Decomposing spec for ${workerCount} worker(s)`);

    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildDecompositionPrompt(spec, workerCount);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'decomposition'
    );

    // Parse decomposition JSON
    const decomposition = this.parseDecompositionJson(response.content);

    // Store in deliberation state
    councilStore.updateDeliberationState(council.id, {
      moduleDecomposition: decomposition,
      moduleOutputs: {},
    });

    // Create ledger entry
    this.createEntry(
      council.id, 'manager', manager.id, 'decomposition', 'decomposing',
      response.content, response.tokensUsed, response.latencyMs
    );

    console.log(`[CodingOrchestrator] Decomposed into ${decomposition.modules.length} module(s):`,
      decomposition.modules.map(m => m.name));
  }

  // ==========================================================================
  // Phase 2: Implement Modules (parallel)
  // ==========================================================================

  private async implementModules(council: Council, spec: string, isRevision: boolean): Promise<void> {
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No workers assigned to council');
    }

    const state = council.deliberationState;
    const decomposition = state?.moduleDecomposition;
    if (!decomposition) {
      throw new Error('No module decomposition found — decompose first');
    }

    const modules = decomposition.modules;

    // Get latest review feedback if this is a revision cycle
    let reviewFeedback: string | undefined;
    if (isRevision) {
      // Find the most recent code_review entry
      const allEntries = ledgerStore.getAll(council.id);
      const lastReview = [...allEntries].reverse().find(e => e.entryType === 'code_review');
      reviewFeedback = lastReview?.content;
    }

    // Assign modules to workers round-robin
    const assignments: Array<{ module: typeof modules[0]; worker: Persona }> = [];
    for (let i = 0; i < modules.length; i++) {
      const worker = workers[i % workers.length];
      modules[i].assignedWorkerId = worker.id;
      assignments.push({ module: modules[i], worker });
    }

    console.log(`[CodingOrchestrator] Implementing ${modules.length} module(s) with ${workers.length} worker(s) sequentially`,
      isRevision ? '(revision)' : '');

    // Run workers sequentially to avoid filesystem conflicts when multiple
    // workers have write permissions to the same working directory.
    const moduleOutputs: Record<string, string> = { ...(state?.moduleOutputs || {}) };
    let failureCount = 0;

    for (const { module, worker } of assignments) {
      try {
        const assignment = getRoleAssignment(council, worker.id);
        const suppressPersona = assignment?.suppressPersona !== false;

        const workerPermissions: WorkerPermissions = {
          writePermissions: assignment?.writePermissions,
          workingDirectory: council.deliberation?.workingDirectory,
          directoryConstrained: council.deliberation?.directoryConstrained,
        };

        const systemPrompt = suppressPersona
          ? getMinimalWorkerSystemPrompt(workerPermissions)
          : worker.predisposition.systemPrompt;

        let userMessage: string;

        if (isRevision && reviewFeedback) {
          // Revision: include review feedback + previous output
          const previousOutput = state?.moduleOutputs?.[module.name] || '';
          userMessage = buildRevisionFromReviewPrompt(
            reviewFeedback, previousOutput, module.directive, workerPermissions
          );
        } else {
          // First pass: build module directive
          const otherInterfaces = modules
            .filter(m => m.name !== module.name)
            .map(m => ({ name: m.name, interfaces: m.interfaces }));

          userMessage = buildModuleDirectivePrompt(
            module, otherInterfaces, decomposition.integrationNotes, workerPermissions
          );
        }

        this.config.onAgentThinkingStart?.(worker, Date.now());

        const response = await this.invokeAgentSafe(
          { personaId: worker.id, systemPrompt, userMessage },
          worker,
          'module_implementation'
        );

        // Create ledger entry
        this.createEntry(
          council.id, 'worker', worker.id,
          'module_output',
          'implementing',
          `[Module: ${module.name}]\n\n${response.content}`,
          response.tokensUsed, response.latencyMs
        );

        // Evolve context with module implementation
        this.appendToContext(council.id, `Module Implementation (${module.name})`, worker.name, response.content, 'worker', worker.id);

        moduleOutputs[module.name] = response.content;
      } catch (error) {
        failureCount++;
        console.error(`[CodingOrchestrator] Worker failed on module ${module.name}:`, error);
      }
    }

    if (failureCount === assignments.length) {
      throw new Error('All workers failed during implementation');
    }

    councilStore.updateDeliberationState(council.id, { moduleOutputs });
  }

  // ==========================================================================
  // Phase 3: Code Review
  // ==========================================================================

  private async reviewCode(council: Council, spec: string): Promise<ReviewVerdict> {
    const reviewers = getPersonaByRole(council, 'reviewer');
    if (reviewers.length === 0) {
      return { verdict: 'pass', issues: [], summary: 'No reviewer configured — auto-pass' };
    }

    const reviewer = reviewers[0];
    const state = council.deliberationState;
    const moduleOutputs = state?.moduleOutputs || {};

    const workerOutputs = Object.entries(moduleOutputs).map(
      ([moduleName, output]) => ({ moduleName, output })
    );

    if (workerOutputs.length === 0) {
      return { verdict: 'pass', issues: [], summary: 'No module outputs to review' };
    }

    const expectedOutput = council.deliberation?.expectedOutput;

    const assignment = getRoleAssignment(council, reviewer.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    const systemPrompt = suppressPersona
      ? buildReviewerSystemPrompt()
      : reviewer.predisposition.systemPrompt;

    const userMessage = buildCodeReviewPrompt(spec, workerOutputs, expectedOutput);

    console.log(`[CodingOrchestrator] Reviewer ${reviewer.name} reviewing ${workerOutputs.length} module(s)`);

    const response = await this.invokeAgentSafe(
      { personaId: reviewer.id, systemPrompt, userMessage },
      reviewer,
      'code_review'
    );

    // Parse review verdict
    const verdict = this.parseReviewVerdict(response.content);

    // Create ledger entry
    this.createEntry(
      council.id, 'reviewer', reviewer.id, 'code_review', 'code_reviewing',
      response.content, response.tokensUsed, response.latencyMs
    );

    // Evolve context with review findings
    this.appendToContext(council.id, 'Code Review', reviewer.name, response.content, 'consultant', reviewer.id);

    return verdict;
  }

  // ==========================================================================
  // Phase 4: Test Execution
  // ==========================================================================

  private async runTests(
    council: Council,
    testCommand: string
  ): Promise<{ passed: boolean; output: string }> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) {
      console.warn('[CodingOrchestrator] No working directory set — cannot run tests');
      return { passed: true, output: 'No working directory configured' };
    }

    console.log(`[CodingOrchestrator] Running tests: ${testCommand} in ${workingDir}`);

    try {
      if (!this.config.runCommand) {
        console.warn('[CodingOrchestrator] No runCommand callback — cannot run tests');
        return { passed: true, output: 'No runCommand configured' };
      }
      const result = await this.config.runCommand(testCommand, workingDir);

      const output = (result.stdout + '\n' + result.stderr).trim();

      // Create ledger entry
      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'test_result', 'testing',
        `Test command: ${testCommand}\nExit code: ${result.exit_code}\n\n${output}`,
        0, 0
      );

      return {
        passed: result.exit_code === 0,
        output,
      };
    } catch (error) {
      const errMsg = (error as Error).message || String(error);
      console.error('[CodingOrchestrator] Test execution error:', errMsg);

      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'test_result', 'testing',
        `Test command failed: ${testCommand}\nError: ${errMsg}`,
        0, 0
      );

      return { passed: false, output: errMsg };
    }
  }

  // ==========================================================================
  // Phase 5: Debug Fix
  // ==========================================================================

  private async debugFix(council: Council, testOutput: string, spec: string): Promise<void> {
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No workers available for debugging');
    }

    const state = council.deliberationState;
    const decomposition = state?.moduleDecomposition;
    const moduleOutputs = { ...(state?.moduleOutputs || {}) };

    if (decomposition && decomposition.modules.length > 0) {
      // Route errors to each module's assigned worker sequentially
      for (const module of decomposition.modules) {
        const worker = workers.find(w => w.id === module.assignedWorkerId) || workers[0];
        const assignment = getRoleAssignment(council, worker.id);
        const suppressPersona = assignment?.suppressPersona !== false;

        const workerPermissions: WorkerPermissions = {
          writePermissions: assignment?.writePermissions,
          workingDirectory: council.deliberation?.workingDirectory,
          directoryConstrained: council.deliberation?.directoryConstrained,
        };

        const systemPrompt = suppressPersona
          ? getMinimalWorkerSystemPrompt(workerPermissions)
          : worker.predisposition.systemPrompt;

        const userMessage = buildDebugFixPrompt(
          testOutput, moduleOutputs[module.name] || '', spec,
          workerPermissions, module.name, module.files
        );

        console.log(`[CodingOrchestrator] Worker ${worker.name} fixing module ${module.name}`);

        const response = await this.invokeAgentSafe(
          { personaId: worker.id, systemPrompt, userMessage },
          worker,
          'debug_fix'
        );

        moduleOutputs[module.name] = response.content;

        this.createEntry(
          council.id, 'worker', worker.id, 'debug_fix', 'debugging',
          `[Module: ${module.name}]\n\n${response.content}`,
          response.tokensUsed, response.latencyMs
        );
      }

      councilStore.updateDeliberationState(council.id, { moduleOutputs });
    } else {
      // Fallback: single debugger (no decomposition available)
      const debugger_ = workers[0];
      const allCode = Object.entries(moduleOutputs)
        .map(([name, output]) => `=== Module: ${name} ===\n${output}`)
        .join('\n\n');

      const assignment = getRoleAssignment(council, debugger_.id);
      const suppressPersona = assignment?.suppressPersona !== false;

      const workerPermissions: WorkerPermissions = {
        writePermissions: assignment?.writePermissions,
        workingDirectory: council.deliberation?.workingDirectory,
        directoryConstrained: council.deliberation?.directoryConstrained,
      };

      const systemPrompt = suppressPersona
        ? getMinimalWorkerSystemPrompt(workerPermissions)
        : debugger_.predisposition.systemPrompt;

      const userMessage = buildDebugFixPrompt(testOutput, allCode, spec, workerPermissions);

      console.log(`[CodingOrchestrator] Debugger ${debugger_.name} fixing test failures`);

      const response = await this.invokeAgentSafe(
        { personaId: debugger_.id, systemPrompt, userMessage },
        debugger_,
        'debug_fix'
      );

      this.createEntry(
        council.id, 'worker', debugger_.id, 'debug_fix', 'debugging',
        response.content, response.tokensUsed, response.latencyMs
      );
    }
  }

  // ==========================================================================
  // Completion
  // ==========================================================================

  private async mergeAndComplete(council: Council, spec: string, warnings: string[] = []): Promise<void> {
    const state = council.deliberationState;
    const moduleOutputs = state?.moduleOutputs || {};

    // Merge all module outputs into a single output artifact
    const mergedContent = Object.entries(moduleOutputs)
      .map(([name, output]) => `## Module: ${name}\n\n${output}`)
      .join('\n\n---\n\n');

    // Create output artifact (uses a dummy directive ID since coding flow
    // doesn't have the traditional directive artifact)
    const output = createOutput(council.id, mergedContent, 'coding-workflow');

    councilStore.setCurrentOutput(council.id, output.id);

    // Generate completion summary, appending any warnings from recovered phases
    let summary = `Coding workflow completed. ${Object.keys(moduleOutputs).length} module(s) implemented: ${Object.keys(moduleOutputs).join(', ')}`;
    if (warnings.length > 0) {
      summary += `\n\nWarnings:\n${warnings.map(w => `- ${w}`).join('\n')}`;
    }
    councilStore.updateDeliberationState(council.id, { completionSummary: summary });

    this.transitionPhase(council.id, 'completed');
    councilStore.setStatus(council.id, 'resolved');

    console.log('[CodingOrchestrator] Workflow completed successfully');
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getManager(council: Council): Persona {
    const managers = getPersonaByRole(council, 'manager');
    if (managers.length === 0) {
      throw new Error('No manager assigned to council');
    }
    return managers[0];
  }

  private async autoDetectTestCommand(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) return null;

    try {
      const detected = await detectTestCommand(workingDir, this.config.readFile);
      if (detected) {
        console.log(`[CodingOrchestrator] Auto-detected test command: ${detected.command} (${detected.framework})`);
        return detected.command;
      }
    } catch (error) {
      console.warn('[CodingOrchestrator] Test detection failed:', error);
    }
    return null;
  }

  private async autoDetectBuildCommand(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) return null;

    try {
      const detected = await detectBuildCommand(workingDir, this.config.readFile);
      if (detected) {
        console.log(`[CodingOrchestrator] Auto-detected build command: ${detected.command} (${detected.framework})`);
        return detected.command;
      }
    } catch (error) {
      console.warn('[CodingOrchestrator] Build detection failed:', error);
    }
    return null;
  }

  private async autoDetectInstallCommand(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) return null;

    try {
      const detected = await detectInstallCommand(workingDir, this.config.readFile);
      if (detected) {
        console.log(`[CodingOrchestrator] Auto-detected install command: ${detected.command} (${detected.framework})`);
        return detected.command;
      }
    } catch (error) {
      console.warn('[CodingOrchestrator] Install detection failed:', error);
    }
    return null;
  }

  /**
   * Create a git snapshot before implementation begins so the user can
   * roll back if workers destroy the codebase.
   * Returns the commit SHA, or null if not in a git repo / no runCommand.
   */
  private async createGitSnapshot(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir || !this.config.runCommand) return null;

    try {
      // Check if inside a git repo
      const check = await this.config.runCommand('git rev-parse --is-inside-work-tree', workingDir);
      if (check.exit_code !== 0) return null;

      // Stage everything and commit (allow-empty in case there are no changes)
      await this.config.runCommand('git add -A', workingDir);
      await this.config.runCommand(
        'git commit -m "kondi: pre-pipeline snapshot" --allow-empty',
        workingDir
      );

      // Capture SHA
      const shaResult = await this.config.runCommand('git rev-parse HEAD', workingDir);
      const sha = shaResult.stdout.trim();

      console.log(`[CodingOrchestrator] Git snapshot created: ${sha}`);

      // Create ledger entry
      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'decomposition', 'decomposing',
        `Pre-pipeline git snapshot: ${sha}\nRollback: git reset --hard ${sha}`,
        0, 0
      );

      return sha;
    } catch (error) {
      console.warn('[CodingOrchestrator] Git snapshot failed:', error);
      return null;
    }
  }

  private transitionPhase(councilId: string, to: DeliberationPhase): void {
    const council = councilStore.get(councilId);
    const from = council?.deliberationState?.currentPhase || 'created';

    // Validate transition
    const rule = CODING_PHASE_TRANSITIONS[from];
    if (rule && !rule.validNext.includes(to) && to !== 'failed') {
      console.warn(`[CodingOrchestrator] Unexpected phase transition: ${from} -> ${to}`);
    }

    councilStore.setDeliberationPhase(councilId, to, from);
    this.config.onPhaseChange?.(from, to);

    console.log(`[CodingOrchestrator] Phase: ${from} -> ${to}`);
  }

  private async invokeAgentSafe(
    invocation: AgentInvocation,
    persona: Persona,
    context: string
  ): Promise<AgentResponse> {
    // Scope tool access by phase:
    //   Workers (module_implementation, debug_fix): full tools
    //   Reviewers (code_review) & decomposition: read-only tools
    //   Other phases: no tools
    const BUILTIN_TOOLS = ['WebSearch', 'WebFetch'];
    const READ_ONLY_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Grep', 'Glob'];

    const toolPhases = ['module_implementation', 'debug_fix'];
    const readOnlyToolPhases = ['code_review', 'decomposition'];

    if (toolPhases.includes(context)) {
      // Workers keep default full tool access (no change needed)
    } else if (readOnlyToolPhases.includes(context)) {
      invocation = { ...invocation, allowedTools: READ_ONLY_TOOLS, skipTools: undefined };
    } else if (!invocation.skipTools) {
      invocation = { ...invocation, skipTools: true };
    }
    console.log(`[CodingOrchestrator] invokeAgentSafe context=${context} skipTools=${invocation.skipTools} persona=${persona.name} provider=${persona.provider}`);

    // Compute effective allowed servers (intersection of step + persona)
    const council = this.activeCouncilId ? councilStore.get(this.activeCouncilId) : null;
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

    // Inject brevity instruction if configured
    const wordLimit = (() => {
      try {
        const councils = councilStore.getAll();
        for (const c of councils) {
          if (c.personas.some(p => p.id === persona.id)) {
            return c.deliberation?.maxWordsPerResponse;
          }
        }
      } catch { /* ignore */ }
      return undefined;
    })();

    if (wordLimit && wordLimit > 0) {
      invocation = {
        ...invocation,
        userMessage: invocation.userMessage +
          `\n\nIMPORTANT: Keep your response concise — aim for approximately ${wordLimit} words or fewer.`,
      };
    }

    // Thread working directory from council so each invocation uses its own dir
    const councilDir = council?.deliberation?.workingDirectory;
    if (councilDir) {
      invocation = { ...invocation, workingDirectory: councilDir };
    }

    // Retry transient errors (rate limits, overload) with exponential backoff.
    // This covers ALL roles (manager, worker, reviewer) uniformly.
    const MAX_TRANSIENT_RETRIES = 5;
    const BASE_DELAY_MS = 15_000; // 15 seconds

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        this.config.onAgentThinkingStart?.(persona, Date.now());
        const response = await this.config.invokeAgent(invocation, persona);
        this.config.onAgentThinkingEnd?.(persona);
        return response;
      } catch (error) {
        this.config.onAgentThinkingEnd?.(persona);

        const errMsg = error instanceof Error ? error.message : String(error);
        const isTransient = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);

        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[CodingOrchestrator] Transient error for ${persona.name} (${context}), ` +
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
  ): LedgerEntry {
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      authorRole: role,
      authorPersonaId: authorId,
      entryType,
      phase,
      content,
      tokensUsed,
      latencyMs,
      artifactRefs,
      roundNumber,
    };

    ledgerStore.append(councilId, entry);
    this.config.onEntryAdded?.(entry);

    return entry;
  }

  /**
   * Append a summary to the shared context document when evolveContext is enabled.
   */
  private appendToContext(
    councilId: string,
    label: string,
    personaName: string,
    content: string,
    role: 'consultant' | 'worker' | 'manager',
    personaId?: string,
  ): void {
    const council = councilStore.get(councilId);
    if (!council?.deliberation?.evolveContext) return;

    const currentContext = getCurrentContext(councilId);
    if (!currentContext) return;

    const summaryMatch = content.match(/## COMPLETION SUMMARY[\s\S]*/i);
    const summary = summaryMatch
      ? summaryMatch[0].slice(0, 1500)
      : content.slice(0, 2000);

    const appendText = `\n\n---\n[${label} by ${personaName}]:\n${summary}`;

    const updated = createContextVersion(
      councilId,
      currentContext.content + appendText,
      `${label} by ${personaName}`,
      role,
      personaId,
    );

    councilStore.setActiveContext(councilId, updated.id, updated.version);
    console.log(`[CodingOrchestrator] Context evolved to v${updated.version}: ${label} by ${personaName}`);
  }

  private parseDecompositionJson(content: string): {
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
  } {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.modules && Array.isArray(parsed.modules)) {
          return {
            modules: parsed.modules.map((m: any) => ({
              name: m.name || 'unnamed',
              files: Array.isArray(m.files) ? m.files : [],
              interfaces: m.interfaces || '',
              dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
              directive: m.directive || '',
            })),
            integrationNotes: parsed.integrationNotes || '',
            testStrategy: parsed.testStrategy || '',
            buildCommand: parsed.buildCommand || '',
            installCommand: parsed.installCommand || '',
          };
        }
      }
    } catch (e) {
      console.warn('[CodingOrchestrator] Failed to parse decomposition JSON:', e);
    }

    // Fallback: single monolithic module
    return {
      modules: [{
        name: 'main',
        files: [],
        interfaces: '',
        dependencies: [],
        directive: content,
      }],
      integrationNotes: '',
      testStrategy: '',
      buildCommand: '',
      installCommand: '',
    };
  }

  /**
   * Write a clean, formatted ledger entry from the parsed review verdict
   * so revision workers see actionable feedback instead of raw LLM output.
   */
  private storeFormattedReviewFeedback(council: Council, verdict: ReviewVerdict): void {
    if (verdict.issues.length === 0 && !verdict.summary) return;

    const lines: string[] = [];
    lines.push(`## Code Review: ${verdict.verdict.toUpperCase()}`);
    lines.push('');
    if (verdict.summary) {
      lines.push(verdict.summary);
      lines.push('');
    }
    if (verdict.issues.length > 0) {
      lines.push('## Issues to Fix');
      for (const issue of verdict.issues) {
        lines.push(`- **[${issue.severity.toUpperCase()}] ${issue.module}**: ${issue.description}`);
        if (issue.suggestion) {
          lines.push(`  → Fix: ${issue.suggestion}`);
        }
      }
    }

    const reviewer = getPersonaByRole(council, 'reviewer')[0];
    const authorId = reviewer?.id || 'system';

    // This entry replaces the raw code_review entry as the revision worker's
    // feedback source (implementModules looks for the last code_review entry)
    this.createEntry(
      council.id, 'reviewer', authorId, 'code_review', 'code_reviewing',
      lines.join('\n'), 0, 0
    );
  }

  private parseReviewVerdict(content: string): ReviewVerdict {
    // Try multiple JSON extraction strategies (tool-use output may wrap the JSON
    // in markdown fences or place it after tool-call text)
    const candidates: string[] = [];

    // Strategy 1: markdown code block ```json ... ```
    const fencedMatch = content.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
    if (fencedMatch) candidates.push(fencedMatch[1]);

    // Strategy 2: last JSON object in the content (skip tool-use JSON earlier in the text)
    const allJsonMatches = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allJsonMatches.length > 0) {
      // Work backwards — the review JSON is typically at the end
      for (let i = allJsonMatches.length - 1; i >= 0; i--) {
        candidates.push(allJsonMatches[i][0]);
      }
    }

    // Strategy 3: greedy match (original fallback)
    const greedyMatch = content.match(/\{[\s\S]*\}/);
    if (greedyMatch) candidates.push(greedyMatch[0]);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        // Must look like a review verdict (has verdict field)
        if (parsed.verdict) {
          return {
            verdict: parsed.verdict === 'needs_revision' ? 'needs_revision' : 'pass',
            issues: Array.isArray(parsed.issues) ? parsed.issues.map((i: any) => ({
              module: i.module || 'unknown',
              severity: ['critical', 'major', 'minor'].includes(i.severity) ? i.severity : 'minor',
              description: i.description || '',
              suggestion: i.suggestion || '',
            })) : [],
            summary: parsed.summary || content,
          };
        }
      } catch {
        // Not valid JSON or wrong shape, try next candidate
      }
    }

    // Text fallback: if content mentions "needs_revision", use the full content as summary
    // so the worker at least sees the reviewer's prose
    const lower = content.toLowerCase();
    if (lower.includes('needs_revision') || lower.includes('needs revision')) {
      return { verdict: 'needs_revision', issues: [], summary: content };
    }

    return { verdict: 'pass', issues: [], summary: content };
  }
}
