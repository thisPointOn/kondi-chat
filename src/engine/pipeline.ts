/**
 * Pipeline — the Discuss → Commit → Dispatch → Execute → Verify → Reflect loop.
 *
 * Orchestrates the flow between conversation model, worker model,
 * and local verification tools. All calls are recorded in the audit ledger.
 */

import { join } from 'node:path';
import type {
  Session, SessionState, TaskCard, RepoMap,
  LLMResponse, VerificationResult, ProviderId,
} from '../types.ts';
import { callLLM } from '../providers/llm-caller.ts';
import { createTaskCard, executeTaskCard, readRelevantFiles } from './task-card.ts';
import { parseFileReplacements, applyChanges, formatApplyResult, type ApplyResult } from './apply.ts';
import { verify } from './verify.ts';
import { Ledger } from '../audit/ledger.ts';
import type { Router as UnifiedRouter } from '../router/index.ts';
import type { RoutingCollector } from '../router/collector.ts';
import { PipelineError } from './errors.ts';

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  /** Fallback provider (used when no router is available) */
  provider: ProviderId;
  model?: string;
  /** Unified router for model selection */
  router?: UnifiedRouter;
  /** Training data collector */
  collector?: RoutingCollector;
  /** Max failures before retrying with enhanced prompt */
  promotionThreshold: number;
  /** Working directory */
  workingDir: string;
  /** Run verification after execution? */
  autoVerify: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface PipelineResult {
  /** The task card that was created and executed */
  task: TaskCard;
  /** Worker model output */
  executionOutput: string;
  /** Files written to disk */
  applied?: ApplyResult;
  /** Verification results (if autoVerify) */
  verification?: VerificationResult;
  /** Frontier model reflection on results */
  reflection: string;
  /** Was the task promoted to frontier after cheap failures? */
  promoted: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline for a user request that requires code execution.
 *
 * 1. Dispatch — create task card from user intent + session state
 * 2. Execute — send task card to worker model
 * 3. Verify — run local tests/lint/typecheck
 * 4. Reflect — frontier summarizes what happened
 *
 * Returns the result for display in the conversation.
 */
export async function runPipeline(
  userIntent: string,
  session: Session,
  ledger: Ledger,
  config: PipelineConfig,
): Promise<PipelineResult> {

  /** Resolve provider/model from router or fallback */
  const route = async (
    phase: import('../types.ts').LedgerPhase,
    promptText: string,
    taskKind?: string,
    failures = 0,
  ) => {
    if (config.router) {
      const decision = await config.router.select(
        phase,
        promptText,
        taskKind,
        failures,
        config.promotionThreshold,
      );
      return { provider: decision.model.provider, model: decision.model.id, decision };
    }
    return { provider: config.provider, model: config.model, decision: undefined as any };
  };

  // -----------------------------------------------------------------------
  // Step 1: Dispatch — create task card
  // -----------------------------------------------------------------------
  const dispatchRoute = await route('dispatch', userIntent);
  let card, dispatchResponse;
  try {
    ({ card, response: dispatchResponse } = await createTaskCard(
      userIntent,
      session.state,
      session.repoMap,
      dispatchRoute.provider,
      dispatchRoute.model,
      ledger,
    ));
  } catch (e) {
    throw new PipelineError(
      `dispatch failed: ${e instanceof Error ? e.message : String(e)}`,
      { severity: 'fatal', stage: 'dispatch', cause: e },
    );
  }
  // process.stderr.write(`  │  │  model: ${dispatchResponse.model}  ${dispatchResponse.inputTokens}in/${dispatchResponse.outputTokens}out\n`);
  // process.stderr.write(`  │  ╰─ task ${card.id} (${card.kind}): ${card.goal.slice(0, 60)}\n`);

  // Record routing outcome
  config.collector?.record({
    timestamp: new Date().toISOString(),
    phase: 'dispatch', taskKind: card.kind, promptLength: userIntent.length,
    contextTokens: dispatchResponse.inputTokens, failures: 0, promoted: false,
    modelId: dispatchResponse.model, provider: dispatchRoute.provider,
    succeeded: true, inputTokens: dispatchResponse.inputTokens,
    outputTokens: dispatchResponse.outputTokens,
    costUsd: 0, latencyMs: dispatchResponse.latencyMs,
    routeReason: dispatchRoute.decision?.reason || 'fallback',
    routingTier: dispatchRoute.decision?.tier,
  });

  card.status = 'executing';
  session.tasks.push(card);
  session.state.activeTaskId = card.id;

  // -----------------------------------------------------------------------
  // Step 2: Execute — router picks the worker model
  // -----------------------------------------------------------------------
  const fileContents = config.workingDir
    ? readRelevantFiles(config.workingDir, card.relevantFiles)
    : '';

  const execRoute = await route('execute', card.goal, card.kind, card.failures);
  let executionResponse;
  try {
    executionResponse = await executeTaskCard(
      card,
      session.repoMap,
      fileContents,
      execRoute.provider,
      execRoute.model,
      ledger,
    );
  } catch (e) {
    throw new PipelineError(
      `execute failed: ${e instanceof Error ? e.message : String(e)}`,
      { severity: 'recoverable', stage: 'execute', cause: e },
    );
  }
  // process.stderr.write(`  │  │  model: ${executionResponse.model}  ${executionResponse.inputTokens}in/${executionResponse.outputTokens}out\n`);
  // process.stderr.write(`  │  ╰─ done\n`);

  // -----------------------------------------------------------------------
  // Step 2.5: Apply — write model output to disk
  // -----------------------------------------------------------------------
  let applyResult: ApplyResult | undefined;
  if (config.workingDir && card.outputMode !== 'text') {
    const changes = parseFileReplacements(executionResponse.content);
    if (changes.length > 0) {
      const backupDir = join(config.workingDir, '.kondi-chat', 'backups', card.id);
      applyResult = applyChanges(config.workingDir, changes, backupDir);
      // process.stderr.write(`  │  ╭─ apply\n`);
      for (const f of applyResult.applied) {
        // process.stderr.write(`  │  │  ${f.isNew ? '+' : '~'} ${f.path}\n`);
      }
      for (const s of applyResult.skipped) {
        // process.stderr.write(`  │  │  ✗ ${s}\n`);
      }
      // process.stderr.write(`  │  ╰─ ${applyResult.applied.length} file(s) written\n`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Verify — run local tools
  // -----------------------------------------------------------------------
  let verification: VerificationResult | undefined;

  if (config.autoVerify && config.workingDir) {
    card.status = 'verifying';

    // process.stderr.write(`  │  ╭─ verify (local)\n`);
    verification = verify(config.workingDir, session.repoMap);

    const verifyOutput = [
      verification.testOutput ? `Tests: ${verification.passed ? 'PASS' : 'FAIL'}\n${verification.testOutput}` : '',
      verification.typecheckOutput ? `Typecheck: ${verification.typecheckOutput}` : '',
      verification.lintOutput ? `Lint: ${verification.lintOutput}` : '',
    ].filter(Boolean).join('\n\n');

    // process.stderr.write(`  │  ╰─ ${verification.passed ? 'PASSED' : 'FAILED'}\n`);
    ledger.recordVerification(card.id, verification.passed, verifyOutput);

    // Retry on failure — enrich prompt with error context so router can escalate
    if (!verification.passed && card.failures < config.promotionThreshold) {
      card.failures++;
      session.state.recentFailures.push(
        `Task ${card.id} failed (attempt ${card.failures}): ${verifyOutput.slice(0, 200)}`
      );

      // pipeline: retry (attempt N/M) — suppressed for TUI

      // Retry — router may promote to a better model based on failure count
      const retryRoute = await route('execute', card.goal, card.kind, card.failures);
      const retryCard = { ...card, constraints: [...card.constraints, `Previous attempt failed with: ${verifyOutput.slice(0, 500)}`] };
      // process.stderr.write(`  │  │  ${retryRoute.decision?.promoted ? 'PROMOTED' : 'retrying'}${retryRoute.decision ? ` [${retryRoute.decision.reason}]` : ''}\n`);
      executionResponse = await executeTaskCard(
        retryCard,
        session.repoMap,
        fileContents,
        retryRoute.provider,
        retryRoute.model,
        ledger,
      );
      // process.stderr.write(`  │  │  model: ${executionResponse.model}  ${executionResponse.inputTokens}in/${executionResponse.outputTokens}out\n`);
      // process.stderr.write(`  │  ╰─ retry done\n`);

      // Re-verify
      // process.stderr.write(`  │  ╭─ verify (local)\n`);
      verification = verify(config.workingDir, session.repoMap);
      const retryVerifyOutput = [
        verification.testOutput ? `Tests: ${verification.passed ? 'PASS' : 'FAIL'}\n${verification.testOutput}` : '',
        verification.typecheckOutput ? `Typecheck: ${verification.typecheckOutput}` : '',
      ].filter(Boolean).join('\n\n');
      // process.stderr.write(`  │  ╰─ ${verification.passed ? 'PASSED' : 'FAILED'}\n`);
      ledger.recordVerification(card.id, verification.passed, retryVerifyOutput);
    }
  }

  const promoted = card.failures >= config.promotionThreshold;
  card.status = verification?.passed ? 'passed' : (promoted ? 'promoted' : 'failed');
  card.completedAt = new Date().toISOString();

  // Record execution outcome for router training
  config.collector?.record({
    timestamp: new Date().toISOString(),
    phase: 'execute', taskKind: card.kind, promptLength: card.goal.length,
    contextTokens: executionResponse.inputTokens, failures: card.failures, promoted,
    modelId: executionResponse.model, provider: executionResponse.provider,
    succeeded: verification?.passed ?? true,
    verificationPassed: verification?.passed,
    inputTokens: executionResponse.inputTokens,
    outputTokens: executionResponse.outputTokens,
    costUsd: 0, latencyMs: executionResponse.latencyMs,
    routeReason: execRoute.decision?.reason || 'fallback',
    routingTier: execRoute.decision?.tier,
  });

  // -----------------------------------------------------------------------
  // Step 4: Reflect — frontier summarizes what happened
  // -----------------------------------------------------------------------
  const reflectRoute = await route('reflect', card.goal);
  let reflectionResponse: LLMResponse;
  try {
    reflectionResponse = await callLLM({
    provider: reflectRoute.provider,
    model: reflectRoute.model,
    systemPrompt: 'You are summarizing the results of a coding task for the user. Be concise. Report what was done, whether it passed verification, and what to do next.',
    userMessage: `Task: ${card.goal}
Kind: ${card.kind}
Status: ${card.status}

Worker output (summary):
${executionResponse.content.slice(0, 3000)}

${verification ? `Verification: ${verification.passed ? 'PASSED' : 'FAILED'}
${verification.testOutput ? `Test output: ${verification.testOutput.slice(0, 500)}` : ''}
${verification.typecheckOutput ? `Typecheck: ${verification.typecheckOutput.slice(0, 500)}` : ''}` : 'Verification: skipped'}

Summarize the results for the user. If failed, suggest what to try next.`,
    maxOutputTokens: 1500,
  });
  } catch (e) {
    // Reflection is non-essential — we already executed and verified. If
    // the reflection call fails, degrade gracefully with a synthetic
    // summary instead of nuking the whole pipeline result.
    reflectionResponse = {
      content: `(reflection failed: ${e instanceof Error ? e.message : String(e)})`,
      model: reflectRoute.model || 'unknown',
      provider: reflectRoute.provider,
      inputTokens: 0, outputTokens: 0, latencyMs: 0,
    };
  }

  ledger.record('reflect', reflectionResponse, `Reflect on task ${card.id}`, { taskId: card.id });

  // Clean up state
  session.state.activeTaskId = undefined;
  if (card.status === 'passed') {
    session.state.recentFailures = session.state.recentFailures.filter(f => !f.includes(card.id));
  }

  return {
    task: card,
    executionOutput: executionResponse.content,
    applied: applyResult,
    verification,
    reflection: reflectionResponse.content,
    promoted,
  };
}
