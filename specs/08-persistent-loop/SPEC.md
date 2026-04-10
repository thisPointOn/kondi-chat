# 08 — Persistent Loop

## Product Description

The agent already loops: `handleSubmit` keeps calling the LLM as long as the model emits tool calls, stopping when the model answers without tools. Today that loop is governed by a hard-coded `MAX_TOOL_ITERATIONS = 20` constant with no cost awareness.

This spec replaces that constant with the existing `LoopGuard`, giving every agent turn cost caps, iteration caps, and stuck detection driven by the active budget profile. There is no new tool, no new agent signal, and no new counter. The persistent loop is just "the normal agent loop, bounded by `LoopGuard` instead of a hard-coded 20."

**Why it matters:** Many coding tasks require many tool cycles (write → run tests → read errors → edit → re-run). Twenty iterations is often too few for real work and the cap fires silently. Removing the arbitrary constant and using the profile-driven guard makes bounds configurable per mode (`cheap` vs `quality`) and makes stuck detection available everywhere instead of only in `/loop`.

**Revised 2026-04-10:** Previously proposed a new `persist` tool plus a new hard cap of 50 iterations on top of `MAX_TOOL_ITERATIONS` and `LoopGuard`. That created three counters for one concept and duplicated the existing tool loop. Simplified to: delete the constant, route the existing loop through `LoopGuard`, no new tool.

## User Stories

1. **Long debug session:** Agent edits code, runs tests, reads failures, edits again. On the `balanced` profile this can run up to `loopIterationCap` iterations (default 12) with a `loopCostCap` of $2.00 — whichever comes first. The user sees iteration and cost in the existing stats line.

2. **Stuck detection:** Agent tries the same fix three times, each producing the same compiler error. `LoopGuard` detects the repeated error and stops the turn with "stuck on repeated error: ..." as the final message. No new tool or signal needed — the loop just stops between iterations.

3. **Cost-capped exploration:** User runs `/mode cheap` (which sets `loopCostCap: 0.50`). Agent burns through $0.52 mid-task; the loop stops before the next iteration and reports the cap. User can `/mode balanced` and re-prompt to continue.

4. **User interrupt:** User presses `^C` mid-turn. The current in-flight LLM call finishes, the loop exits cleanly, partial state is reported. (This is existing TUI behavior; no spec change.)

## Technical Design

### The whole change

```typescript
// src/cli/backend.ts — handleSubmit

- const MAX_TOOL_ITERATIONS = 20;          // DELETE
+ const loopGuard = new LoopGuard(profiles.getActive());
+ toolCtx.loopGuard = loopGuard;  // so tools can inspect status if they want

- for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
+ while (true) {
    const response = await callLLM({ ... });

    const iterCost = estimateCost(response.model, response.inputTokens, response.outputTokens);
+   // Pass tool-error text so stuck detection works
+   const errorText = lastToolError(response);   // see below
+   loopGuard.recordIteration(iterCost, errorText);
+
+   const guard = loopGuard.check();
+   if (guard.shouldStop) {
+     finalContent = response.content || `Loop stopped: ${guard.stopReason}`;
+     break;
+   }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content;
      break;
    }

    // ... existing tool execution ...
  }
```

That is the entire control-flow change. One counter (`LoopGuard.iteration`), one cost accumulator (`LoopGuard.costUsd`), one stop decision (`LoopGuard.check()`).

### Where "stuck" comes from

`LoopGuard.recordIteration(cost, error?)` feeds error text into normalization and dedup. The backend currently collects tool results but never passes error text to the guard. Add a one-liner helper in `handleSubmit`:

```typescript
function lastToolError(response: LLMResponse): string | undefined {
  // Look at tool results we just executed this iteration, pick the first
  // isError=true content. Empty if no errors.
  // (Implemented inline using the toolResults array built in the existing loop.)
}
```

This makes the existing stuck-detection logic (same error 3×, or same error back-to-back) apply to ordinary agent turns — which is a bug fix, not a new feature. Currently stuck detection only runs under `/loop`.

### What gets deleted

- `const MAX_TOOL_ITERATIONS = 20` in `src/cli/backend.ts`
- The branch `if (iteration === MAX_TOOL_ITERATIONS - 1) { finalContent = ... }`
- Any reference to iteration count as a raw `for`-loop index; use `guard.iteration` for display

### What does NOT change

- The agent still exits the turn the same way: the model stops calling tools, or it answers.
- No new tool. No new tool-use signal. The model does not need to know `LoopGuard` exists.
- Profile fields already used: `loopIterationCap`, `loopCostCap`. No new config.
- `/loop` command still exists and still constructs its own `LoopGuard` independently.

### Safety ceiling

`LoopGuard` is profile-driven. The existing default profiles set:
- `cheap`: `loopIterationCap: 6`, `loopCostCap: 0.50`
- `balanced`: `loopIterationCap: 12`, `loopCostCap: 2.00`
- `quality`: `loopIterationCap: 20`, `loopCostCap: 10.00`

If a user writes a custom profile with `loopIterationCap: 9999`, they get 9999 iterations — that is the point of custom profiles. The hard ceiling is the cost cap, which is always set. If neither is set (malformed profile), `ProfileManager.getActive()` falls back to `balanced`, so there is no path to an unbounded loop.

No separate "absolute hard cap of 50" constant. One layer of bounds, not two.

## Implementation Details

### Files modified

**`src/cli/backend.ts`** — the only substantive change. Roughly:

```typescript
import { LoopGuard } from '../engine/loop-guard.ts';

async function handleSubmit(input, session, contextManager, ledger, router, collector, toolCtx, toolManager, profiles) {
  // ... existing mention handling, prompt assembly ...

  const loopGuard = new LoopGuard(profiles.getActive());
  toolCtx.loopGuard = loopGuard;

  while (true) {
    const decision = await router.select('discuss', userMessage, undefined, loopGuard['iteration']);
    // (expose a public `iteration` getter on LoopGuard so we don't bracket-access)
    // ... existing LLM call, cost accounting ...

    const iterErrorText = collectToolErrorText(lastToolResults);
    loopGuard.recordIteration(iterCost, iterErrorText);

    const guard = loopGuard.check();
    if (guard.shouldStop) {
      finalContent = response.content || `Loop stopped: ${guard.stopReason}`;
      // Emit a single activity line so the user sees *why* it stopped
      emit({ type: 'activity', text: `loop stopped: ${guard.stopReason}`, activity_type: 'step' });
      break;
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content;
      break;
    }

    // ... existing tool execution, messages.push(tool results) ...
    // After execution, stash error text for the NEXT iteration's recordIteration call:
    lastToolResults = toolResults;
  }

  // ... existing finalization, context manager updates, emit message_update ...
}
```

Notes:
- `lastToolResults` is a local variable, not state. It holds the tool results from the iteration that just ran so the next `recordIteration` call can pass their error text.
- The iteration number shown in the UI (`stats.iterations`) now comes from `loopGuard.iteration` rather than counting messages. This is one line of change in the final `emit({ type: 'message_update', ..., stats: { iterations: loopGuard.iteration } })`.

**`src/engine/loop-guard.ts`** — one additive change: expose `iteration` as a public readonly getter so callers don't have to bracket-access. Nothing else.

```typescript
get currentIteration(): number { return this.iteration; }
```

**`src/engine/tools.ts`** — no new tool. The only change is extending `ToolContext`:

```typescript
export interface ToolContext {
  // ... existing fields
  loopGuard?: LoopGuard;  // optional; present during handleSubmit turns
}
```

Tools that want to reflect on loop state (e.g. a future tool that reports remaining budget) can read from `ctx.loopGuard?.check()`. Nothing in this spec requires that.

### What the LLM sees

Nothing new. The system prompt is unchanged. No tool list change. No new tool-use grammar. The loop is entirely invisible to the model except that it may run for more or fewer iterations than the old hard-coded 20.

## Protocol Changes

**None.**

The existing `activity` event already covers "loop stopped: reason". The existing `message_update.stats.iterations` already exists in `MessageStats`. There is no `persist_status` event, because there is no persist tool.

**Revised:** previously proposed `persist_status` event and a `persist_iterations` field on `MessageStats`. Deleted. The existing `iterations` field on `MessageStats` (already rendered by the TUI) is sufficient.

## Configuration

Reuses existing `BudgetProfile` fields. No new config:

- `loopIterationCap: number`
- `loopCostCap: number`

**Revised:** previously added `persistEnabled`, `persistStuckDetection`, `persistRequireCriterion`. All deleted. Stuck detection is always on; it's a bug that it wasn't active in normal turns.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Profile missing `loopIterationCap` / `loopCostCap` | `ProfileManager.getActive()` falls back to `balanced`; LoopGuard always has bounds |
| Tool returns `isError: true` with empty content | Normalized to empty string, fed to `recordIteration`; stuck detection no-ops on empty errors |
| Agent loops forever without errors (same content) | Iteration cap fires first |
| Cost cap hit mid-iteration | Current iteration finishes (LLM call already in flight), next iteration is blocked at the top of the while loop |
| `^C` during in-flight LLM call | Existing TUI behavior: cancel token fires, promise rejects, loop exits with partial state |
| `loopGuard.check()` returns `shouldStop` on iteration 0 | Impossible — iteration 0 hasn't recorded anything yet. Safe. |

## Testing Plan

1. **Unit tests** (`test/loop-guard.test.ts`, extend existing):
   - Existing tests cover `LoopGuard` in isolation; no change needed.

2. **Integration tests** (`test/agent-loop.test.ts`, new):
   - Mock LLM that returns tool calls for N iterations then a final answer. Verify loop terminates at N.
   - Mock LLM that returns the same error 3 times. Verify loop stops with "stuck" message.
   - Mock LLM with a `cheap` profile and expensive tool calls. Verify loop stops at cost cap before iteration cap.
   - Verify `stats.iterations` in final `message_update` matches `LoopGuard.currentIteration`.

3. **Regression**:
   - Existing tests that relied on `MAX_TOOL_ITERATIONS = 20` need updating. Grep for the constant; there should be no live references after this change.

No E2E changes needed — the TUI sees the same protocol events as before.

## Dependencies

- **Depends on:** Nothing. This is a pure simplification of `handleSubmit`.
- **Depended on by:**
  - **Spec 07 (Sub-agents)** — each sub-agent creates its own `LoopGuard` with its own profile. The shared agent-loop helper from Spec 10 should take `loopGuard` as a parameter.
  - **Spec 10 (Non-interactive mode)** — when the agent loop is extracted into `runAgentLoop(...)`, `loopGuard` goes in the parameter list alongside `toolCtx`, `router`, etc.
  - **Spec 13 (Error Recovery)** — retry/backoff on transient LLM failures composes with the guard: a retry does not count as a new iteration, only a successful LLM call does.

## Estimated Effort

**1 day.**

- Morning: delete `MAX_TOOL_ITERATIONS`, wire `LoopGuard` into `handleSubmit`, add `currentIteration` getter, add `collectToolErrorText` helper.
- Afternoon: update integration tests, grep for stale references, verify `/loop` still works (it constructs its own guard, should be untouched).

**Revised from 3 days.** The previous estimate assumed a new tool, protocol events, and TUI rendering. None of that is needed.
