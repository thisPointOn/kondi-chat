/**
 * Agent submit handler — runs a user message through the loop.
 *
 * Extracted from backend.ts to shrink the god-object. The function has
 * one closure-captured dependency (`emit` for pushing TUI events) which
 * is now a named field on `SubmitDeps`. Everything else is passed in
 * explicitly so this module can be tested without starting the full
 * backend.
 *
 * Two entry paths:
 *   1. @mention prefix ("@gpt write X") → single-shot call to a pinned
 *      model, no agent loop.
 *   2. Everything else → full agent loop with tool calls, compaction,
 *      checkpoints, loop-guard-enforced caps, and optional autonomous
 *      continuation when `opts.loop` is true (the /loop command).
 */

import type { Session, LLMMessage, ProviderId, ToolCall } from '../types.ts';
import type { ContextManager } from '../context/manager.ts';
import type { Ledger } from '../audit/ledger.ts';
import { estimateCost } from '../audit/ledger.ts';
import type { Router as UnifiedRouter } from '../router/index.ts';
import type { RoutingCollector } from '../router/collector.ts';
import type { ToolContext } from '../engine/tools.ts';
import type { ToolManager } from '../mcp/tool-manager.ts';
import type { ProfileManager } from '../router/profiles.ts';
import type { CheckpointManager } from '../engine/checkpoints.ts';
import { callLLM } from '../providers/llm-caller.ts';
import { LoopGuard } from '../engine/loop-guard.ts';
import { isMutatingToolCall, predictedMutations } from '../engine/checkpoints.ts';
import { compactInLoop, classifyPhase } from './submit-helpers.ts';
import { classifyTask, frameProblem, formatFrame, type TaskClassification } from '../engine/task-router.ts';

export interface SubmitDeps {
  session: Session;
  contextManager: ContextManager;
  ledger: Ledger;
  router: UnifiedRouter;
  collector: RoutingCollector;
  toolCtx: ToolContext;
  toolManager: ToolManager;
  profiles: ProfileManager;
  checkpointManager: CheckpointManager;
  /** Push a live event back to the TUI. */
  emit: (event: Record<string, unknown>) => void;
}

export interface SubmitOptions {
  /** Autonomous-loop mode: keep iterating after "no tool calls" responses until DONE/STUCK or caps hit. */
  loop?: boolean;
  /** Goal text shown to the model during /loop continuation prompts. */
  loopGoal?: string;
}

/** Short, human-readable tool-arg summary shown in TUI tool-call previews. */
function formatToolArgs(tc: ToolCall): string {
  const args = tc.arguments as Record<string, unknown>;
  switch (tc.name) {
    case 'read_file': return String(args.path || '');
    case 'list_files': return String(args.path || '.');
    case 'search_code': return `"${args.pattern}"`;
    case 'run_command': return String(args.command || '').slice(0, 60);
    case 'create_task': return String(args.description || '').slice(0, 60);
    case 'update_plan': return args.goal ? `goal="${String(args.goal).slice(0, 40)}"` : '...';
    default: return JSON.stringify(args).slice(0, 60);
  }
}

export async function handleSubmit(
  input: string,
  deps: SubmitDeps,
  opts?: SubmitOptions,
): Promise<void> {
  const {
    session, contextManager, ledger, router, toolCtx, toolManager,
    profiles, checkpointManager, emit,
  } = deps;

  const turnNumber = session.messages.filter(m => m.role === 'user').length + 1;
  let checkpointCreated = false;
  // Spec 08 — profile-driven bounds replace the old MAX_TOOL_ITERATIONS=20.
  const loopGuard = new LoopGuard(profiles.getActive());
  toolCtx.loopGuard = loopGuard;

  // ── @mention path ───────────────────────────────────────────────────
  const mentionMatch = input.match(/^@(\S+)\s+([\s\S]+)/);
  if (mentionMatch) {
    const alias = mentionMatch[1];
    const message = mentionMatch[2];
    const targetModel = router.registry.getByAlias(alias);
    if (!targetModel) {
      const candidates = router.registry.findAliasCandidates(alias);
      const hint = candidates.length > 1
        ? ` — ambiguous, could be: ${candidates.map(a => `@${a}`).join(', ')}`
        : candidates.length === 0
          ? ` — available: ${router.registry.getAliases().map(a => `@${a}`).join(', ')}`
          : '';
      emit({ type: 'error', message: `Unknown model: @${alias}${hint}` });
      return;
    }

    contextManager.addUserMessage(input);
    const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();
    const msgId = `msg-${Date.now()}`;
    emit({ type: 'message', id: msgId, role: 'assistant', content: '', model_label: targetModel.alias || targetModel.name });
    emit({ type: 'status', text: `@${alias} ...` });

    let streamedContent = '';
    const response = await callLLM({
      provider: targetModel.provider,
      model: targetModel.id,
      systemPrompt, userMessage,
      maxOutputTokens: 8192, cacheablePrefix,
      stream: true,
      onToken: (token: string) => {
        streamedContent += token;
        emit({ type: 'message_update', id: msgId, content: streamedContent });
      },
    });

    const cost = estimateCost(response.model, response.inputTokens, response.outputTokens);
    contextManager.addAssistantMessage(response);
    ledger.record('discuss', response, message.slice(0, 200));

    emit({
      type: 'message', id: msgId, role: 'assistant',
      content: response.content,
      model_label: targetModel.alias || targetModel.name,
      reasoning_content: response.reasoningContent,
    });
    emit({
      type: 'message_update', id: msgId, stats: {
        input_tokens: response.inputTokens, output_tokens: response.outputTokens,
        cost_usd: cost, models: [response.model], provider: targetModel.provider,
        route_reason: `@${targetModel.alias}`, iterations: 1,
      },
    });
    return;
  }

  // ── Task classification — decide what kind of thinking this needs ──
  //
  // Before starting the agent loop, a cheap classifier call decides:
  //   execute_now          → run the agent loop directly
  //   frame_then_execute   → frame the problem first, then execute the framed goal
  //   ask_clarifying_question → ask the user one focused question, don't start working
  //   council_deliberation → suggest /council (not auto-invoked)
  //
  // The classifier uses the cheapest model in the profile (same as the
  // intent router's classifier). If classification fails, default to execute_now.

  // Use the profile-scoped classifier (same cheap model the intent router uses).
  const classifier = router.getClassifier();
  const cheapProvider: ProviderId = classifier?.provider || 'anthropic';
  const cheapModel = classifier?.model;

  // Pass recent session context so the classifier can see prior conversation.
  const recentMessages = session.messages.slice(-4).map(m => `${m.role}: ${(m.content || '').slice(0, 200)}`).join('\n');
  const taskClass = await classifyTask(
    input,
    recentMessages,
    cheapProvider,
    cheapModel,
  );

  // Handle ask_clarifying_question — emit the question and stop. The user
  // will respond, and the next submit will be more concrete.
  if (taskClass.mode === 'ask_clarifying_question' && taskClass.suggestedQuestions.length > 0) {
    const question = taskClass.suggestedQuestions[0];
    const msgId = `msg-${Date.now()}`;
    contextManager.addUserMessage(input);
    emit({ type: 'message', id: msgId, role: 'assistant', content: `Before I start — ${question}`, model_label: 'kondi' });
    emit({ type: 'message_update', id: msgId, stats: {
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      models: ['classifier'], provider: cheapProvider,
      route_reason: `task-router: ${taskClass.reason}`, iterations: 0,
    }});
    return;
  }

  // Handle council_deliberation — suggest the user run /council explicitly.
  if (taskClass.mode === 'council_deliberation') {
    const msgId = `msg-${Date.now()}`;
    contextManager.addUserMessage(input);
    emit({ type: 'message', id: msgId, role: 'assistant',
      content: `This looks like a design decision that would benefit from multiple perspectives.\n\nConsider: \`/council run architecture "${input.slice(0, 100)}"\`\n\nOr if you want me to proceed with my own judgment, just rephrase more concretely.`,
      model_label: 'kondi',
    });
    emit({ type: 'message_update', id: msgId, stats: {
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      models: ['classifier'], provider: cheapProvider,
      route_reason: `task-router: ${taskClass.reason}`, iterations: 0,
    }});
    return;
  }

  // Handle frame_then_execute — frame the problem, show the frame, then
  // run the agent loop against the framed goal instead of the raw input.
  let effectiveInput = input;
  if (taskClass.mode === 'frame_then_execute') {
    emit({ type: 'activity', text: `task-router: framing problem (${taskClass.reason})`, activity_type: 'step' });
    try {
      const frame = await frameProblem(input, '', cheapProvider, cheapModel);
      const frameText = formatFrame(frame);
      emit({ type: 'activity', text: `frame: ${frame.interpretedGoal}`, activity_type: 'step' });
      if (frame.successCriteria.length > 0) {
        emit({ type: 'activity', text: `success: ${frame.successCriteria.join('; ')}`, activity_type: 'step' });
      }
      if (frame.proposedPlan.length > 0) {
        emit({ type: 'activity', text: `plan: ${frame.proposedPlan.join(' → ')}`, activity_type: 'step' });
      }
      // Use the framed goal as the effective input for the agent loop.
      effectiveInput = `${frame.interpretedGoal}\n\nSuccess criteria: ${frame.successCriteria.join('; ')}\n\nPlan: ${frame.proposedPlan.join('; ')}\n\nOriginal request: ${input}`;
    } catch {
      // If framing fails, proceed with the original input.
      emit({ type: 'activity', text: 'task-router: framing failed, proceeding with original request', activity_type: 'step' });
    }
  } else {
    emit({ type: 'activity', text: `task-router: ${taskClass.mode} (${taskClass.reason})`, activity_type: 'step' });
  }

  // ── Regular agent loop ──────────────────────────────────────────────
  contextManager.addUserMessage(effectiveInput);
  const { systemPrompt, userMessage, cacheablePrefix } = contextManager.assemblePrompt();
  const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

  let totalInputTokens = 0, totalOutputTokens = 0, totalCost = 0;
  let finalContent = '';
  let respondingModel = '';
  let respondingProvider = '';
  let respondingReason = '';
  const allToolCalls: Array<{ name: string; args: string; result: string; is_error: boolean; diff?: string }> = [];
  const modelsUsed = new Set<string>();
  const reasoningChunks: string[] = [];

  const msgId = `msg-${Date.now()}`;
  emit({ type: 'message', id: msgId, role: 'assistant', content: '', model_label: '...' });

  // Classify the user's request once. The phase drives the budget profile's
  // preference list inside the router (executionPreference vs planningPreference).
  const phase = classifyPhase(effectiveInput);
  emit({
    type: 'activity',
    text: `router: phase=${phase} (${phase === 'execute' ? 'coding intent detected' : 'discussion / reasoning'})`,
    activity_type: 'step',
  });

  while (true) {
    const iteration = loopGuard.check().iteration;
    const decision = await router.select(phase, userMessage, undefined, iteration);
    respondingModel = decision.model.alias || decision.model.name;
    respondingProvider = decision.model.provider;
    respondingReason = decision.reason;
    emit({ type: 'status', text: `${respondingModel} thinking${iteration > 0 ? ` (step ${iteration + 1})` : ''}...` });
    emit({
      type: 'activity',
      text: `→ ${respondingModel} (${decision.tier}: ${decision.reason})`,
      activity_type: 'step',
    });
    emit({ type: 'message_update', id: msgId, model_label: respondingModel });

    // Before each model call, enforce the profile's contextBudget by
    // stubbing old tool results in place. No LLM calls — zero cost.
    const budget = profiles.getActive().contextBudget;
    const compaction = compactInLoop(messages, budget);
    if (compaction.savedBytes > 0) {
      emit({
        type: 'activity',
        text: `context: ${compaction.before.toLocaleString()} → ${compaction.after.toLocaleString()} tokens (${compaction.savedBytes.toLocaleString()} chars pruned)`,
        activity_type: 'step',
      });
    }

    let streamedContent = '';
    const response = await callLLM({
      provider: decision.model.provider,
      model: decision.model.id,
      systemPrompt, messages,
      tools: toolManager.getTools('discuss'),
      maxOutputTokens: 8192, cacheablePrefix,
      stream: true,
      onToken: (token: string) => {
        streamedContent += token;
        emit({ type: 'message_update', id: msgId, content: streamedContent });
      },
    });

    const iterCost = estimateCost(response.model, response.inputTokens, response.outputTokens);
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    totalCost += iterCost;
    modelsUsed.add(response.model);

    if (response.reasoningContent) {
      const header = reasoningChunks.length === 0
        ? `── ${response.model} ──`
        : `\n── ${response.model} (step ${reasoningChunks.length + 1}) ──`;
      reasoningChunks.push(`${header}\n${response.reasoningContent}`);
    }

    ledger.record('discuss', response, messages[messages.length - 1]?.content?.slice(0, 200) || '');

    if (!response.toolCalls || response.toolCalls.length === 0) {
      // Autonomous-loop mode: when the model stops calling tools but the
      // goal isn't explicitly marked done, synthesize a "continue" prompt
      // and keep iterating. LoopGuard still enforces hard caps.
      if (opts?.loop) {
        const body = (response.content || '').trim();
        const terminated = /^DONE\b/mi.test(body) || /^STUCK\b/mi.test(body);
        if (!terminated && !loopGuard.check().shouldStop) {
          messages.push({ role: 'assistant', content: response.content || '(progress)' });
          messages.push({
            role: 'user',
            content:
              `Continue working on the goal: "${opts.loopGoal || input}".\n` +
              `If the goal is fully accomplished, respond with DONE on its own line followed by a brief summary.\n` +
              `If you are blocked and cannot proceed, respond with STUCK: <reason>.\n` +
              `Otherwise keep going — call the tools you need.`,
          });
          emit({ type: 'activity', text: 'loop: continuing — no terminal marker', activity_type: 'step' });
          continue;
        }
      }
      finalContent = response.content;
      break;
    }

    messages.push({ role: 'assistant', content: response.content || undefined, toolCalls: response.toolCalls });

    const toolResults = [];
    for (const tc of response.toolCalls) {
      const toolArgs = formatToolArgs(tc);
      emit({ type: 'tool_call', name: tc.name, args: toolArgs, is_error: false });
      emit({ type: 'activity', text: `${tc.name}(${toolArgs})`, activity_type: 'tool' });

      // Spec 05 — create a checkpoint before the first mutating tool in this turn.
      if (!checkpointCreated && isMutatingToolCall(tc.name, tc.arguments)) {
        try {
          const predicted = new Set([
            ...(toolCtx.mutatedFiles ?? []),
            ...predictedMutations(tc.name, tc.arguments),
          ]);
          checkpointManager.create(
            `Turn ${turnNumber}: ${input.slice(0, 60)}`,
            input,
            turnNumber,
            totalCost,
            predicted,
          );
          checkpointCreated = true;
        } catch (e) {
          emit({ type: 'error', message: `Checkpoint failed: ${(e as Error).message}` });
        }
      }

      const result = await toolManager.execute(tc.name, tc.arguments, toolCtx);
      const capped = result.content.length > 3000 ? result.content.slice(0, 3000) + '...' : result.content;

      allToolCalls.push({
        name: tc.name,
        args: toolArgs,
        result: capped.slice(0, 300),
        is_error: result.isError || false,
        diff: result.diff,
      });
      emit({ type: 'message_update', id: msgId, content: response.content || '', tool_calls: [...allToolCalls] });

      toolResults.push({ toolCallId: tc.id, content: capped, isError: result.isError, diff: result.diff });
    }

    messages.push({ role: 'tool', toolResults });

    // Spec 08 — drive the loop with LoopGuard. Feed the first tool error so
    // stuck detection works on ordinary turns.
    const firstError = toolResults.find(r => r.isError)?.content;
    loopGuard.recordIteration(iterCost, firstError);
    const guard = loopGuard.check();
    if (guard.shouldStop) {
      // Give the model one final no-tools iteration to summarize what it
      // found. This is the difference between "Loop stopped: iteration
      // limit" with zero useful output and a real summary of progress.
      try {
        emit({ type: 'status', text: `${respondingModel} summarizing (cap reached)...` });
        const finalResponse = await callLLM({
          provider: decision.model.provider,
          model: decision.model.id,
          systemPrompt,
          messages: [
            ...messages,
            { role: 'user', content: `You have reached the iteration limit (${guard.stopReason || 'bounds reached'}). Do not call any more tools. Summarize what you found, what you produced, and what remains to be done, in 10 lines or fewer.` },
          ],
          maxOutputTokens: 2048,
          cacheablePrefix,
        });
        totalInputTokens += finalResponse.inputTokens;
        totalOutputTokens += finalResponse.outputTokens;
        totalCost += estimateCost(finalResponse.model, finalResponse.inputTokens, finalResponse.outputTokens);
        finalContent = (finalResponse.content || response.content || '').trim()
          + `\n\n_(loop stopped: ${guard.stopReason || 'bounds reached'})_`;
      } catch {
        finalContent = (response.content || `(no final output)`) + `\n\n_(loop stopped: ${guard.stopReason || 'bounds reached'})_`;
      }
      break;
    }
  }

  // Append file modification summary
  const filesModified = allToolCalls
    .filter(tc => ['write_file', 'edit_file', 'create_task'].includes(tc.name) && !tc.is_error)
    .map(tc => {
      if (tc.name === 'create_task') return `  ✦ task: ${tc.args}`;
      return `  ${tc.name === 'write_file' ? '+' : '~'} ${tc.args}`;
    });
  if (filesModified.length > 0) {
    finalContent += '\n\nFiles:\n' + filesModified.join('\n');
  }

  contextManager.addAssistantMessage({
    content: finalContent, model: respondingModel,
    provider: 'openai' as ProviderId,
    inputTokens: totalInputTokens, outputTokens: totalOutputTokens, latencyMs: 0,
  });

  emit({
    type: 'message_update', id: msgId,
    content: finalContent,
    model_label: respondingModel,
    tool_calls: allToolCalls.length > 0 ? allToolCalls : null,
    reasoning_content: reasoningChunks.length > 0 ? reasoningChunks.join('\n') : undefined,
    stats: {
      input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      cost_usd: totalCost, models: [...modelsUsed],
      provider: respondingProvider,
      route_reason: respondingReason,
      iterations: messages.filter(m => m.role === 'assistant').length || 1,
    },
  });

  emit({ type: 'status', text: '' });
  toolCtx.permissionManager?.endTurn();
  await contextManager.maybeCompact();
  await contextManager.updateSessionState();
}
