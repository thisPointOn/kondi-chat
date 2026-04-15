# Context Efficiency & Router Integration Plan

> **Scope note:** this plan covers the **council subprocess**
> (`kondi-council`), not kondi-chat's main agent loop. The main agent
> loop's context efficiency work — adaptive in-loop tool-result
> stubbing, profile-driven cross-turn compaction via
> `ContextManager.compact()`, profile-scoped compression models,
> prompt-cache tracking, and intent-router scoping — is implemented
> and documented under `/help compression`, `/help intent-router`,
> `/help caching`, and the "Budget profiles" / "Providers" sections of
> the README. The plan below remains the design for the council
> subproject and a source of longer-term ideas about cross-subsystem
> context sharing, but it does not describe the current agent loop.

## Problem Statement

Council deliberations are prohibitively expensive. A single planning council with 5 personas (1 manager, 3 consultants, 1 worker) over 3 rounds with revisions costs $15+ due to unbounded context growth, redundant LLM calls, and no cross-model context management.

The goal is to:
1. Reduce council costs by 5-10x through smarter context assembly and call elimination
2. Enable integration with NVIDIA LLM Router (or similar model routers) where model selection is automatic
3. Make context management the core abstraction — model-agnostic, budget-aware, self-contained per call

## Current Cost Anatomy

Data from a real session: 45 LLM calls, 623K tokens, 29 minutes, ~$15.

| Phase | Calls | Tokens | % of Total |
|-------|-------|--------|------------|
| Reviewing (consultant reviews + manager) | 16 | 268K | 43% |
| Deciding (consultant final positions + manager) | 8 | 105K | 17% |
| Interactive rounds | 9 | 103K | 16% |
| Revisions (worker rewrites) | 2 | 67K | 11% |
| Execution (worker) | 2 | 40K | 6% |
| Manager evaluations | 2 | 19K | 3% |
| Directive, framing, independent | 7 | 21K | 3% |

### Root Causes

1. **Redundant call phases**: `collectConsultantFinalPositions` (3 calls before each decision) and `collectConsultantReviews` (3 calls before each manager review) multiply the call count by 4x at each decision/review boundary.

2. **Unbounded context growth**: `appendToContext` (line 2569 in deliberation-orchestrator.ts) appends up to 2000 chars of every consultant/worker response to the context artifact. After 3 rounds + 2 revisions, the shared context alone can exceed 20K chars.

3. **Full worker output in review prompts**: Worker output is 60K chars. Each of 3 consultants receives the full output to produce a ~1K char review. Then the manager gets the output + all 3 reviews.

4. **No token budget enforcement**: Context assembly methods (`buildRoundNContext`, `buildManagerEvalContext`, `buildDecisionContext`) concatenate strings without size awareness. `shouldSummarize` is a round-number heuristic, not a size check.

5. **Re-deliberation doubles everything**: A "re-deliberate" verdict restarts the entire pipeline — rounds, decision, execution, review — with no context compression of the prior attempt.

---

## Phase 1: Call Reduction (Estimated: 40-50% cost savings)

Eliminate redundant LLM calls without changing the context management layer.

### 1.1 Remove `collectConsultantFinalPositions`

**File**: `src/council/deliberation-orchestrator.ts` lines 1097-1126

**Current behavior**: Before each `makeDecision`, all consultants are called again to state their "final position" — each receiving the full ledger context. This produces 3 extra calls per decision.

**Why it's redundant**: Consultants already stated their positions in the interactive rounds. The ledger already contains their analyses. The manager has access to all of this.

**Change**: Remove the `collectConsultantFinalPositions` call from `makeDecision` (line 1140). The manager's decision prompt already includes `buildDecisionContext()` which has the full round history.

**Savings**: 3 calls per decision phase. In the $15 session: ~6 calls, ~40K tokens saved.

### 1.2 Remove or simplify `collectConsultantReviews`

**File**: `src/council/deliberation-orchestrator.ts` lines 1387-1431

**Current behavior**: Before each manager review, all consultants are called to review the worker output. Each consultant receives the full worker output (60K+ chars) and produces a ~1K char review. The manager then receives the output + all reviews.

**Options**:
- **Option A (aggressive)**: Remove entirely for non-coding step types. The manager has the directive and acceptance criteria — they can review directly. Saves 3 calls per review cycle.
- **Option B (moderate)**: Keep consultant reviews but send a manager-generated summary of the worker output (5K chars) instead of the full output (60K chars). Still 3 calls but much cheaper.
- **Option C (minimal)**: Keep as-is but run only on the first review, not on revision reviews. The consultants already reviewed once — subsequent reviews should only check whether their feedback was addressed.

**Recommended**: Option A for non-coding councils, Option C for coding councils.

**Savings**: 9-12 calls per session with revisions. In the $15 session: ~200K tokens saved.

### 1.3 Collapse `planning` + `directing` into `deciding`

**File**: `src/council/deliberation-orchestrator.ts`

**Current flow**: `deciding` (manager decision) -> `planning` (manager creates plan) -> `directing` (manager issues directive) = 3 sequential LLM calls.

**Change**: Extend the decision prompt to also produce the plan and work directive in a single response. The decision already contains the approach, rationale, and acceptance criteria. Adding "also produce a step-by-step plan and work directive" is a prompt change, not an architecture change.

**Savings**: 2 calls per execution cycle. ~13K tokens in the $15 session.

### 1.4 Cap re-deliberation scope

**File**: `src/council/deliberation-orchestrator.ts` lines 464-477

**Current behavior**: `re_deliberate` verdict loops back to `round_interactive`, which re-runs the full deliberation cycle including decision, execution, and review.

**Change**: When re-deliberating:
- Compress all prior work into a summary (1 cheap call)
- Start the new deliberation with that summary as context rather than the raw history
- Limit re-deliberation to 1 round + decision + execution (no further re-deliberation allowed)

**Savings**: Prevents cost doubling on re-deliberation. In the $15 session this would have saved ~175K tokens.

---

## Phase 2: Context Budget System (Estimated: additional 20-30% savings)

Replace ad-hoc context assembly with a budget-aware assembler.

### 2.1 `ContextBudget` Class

New file: `src/council/context-budget.ts`

```typescript
interface ContextSection {
  key: string;
  content: string;
  priority: number;        // 1 = highest priority, included first
  compressible: boolean;   // Can this section be summarized?
  tokenEstimate: number;   // Approximate token count (chars / 4)
}

class ContextBudget {
  private sections: ContextSection[] = [];
  private budget: number;

  constructor(tokenBudget: number) {
    this.budget = tokenBudget;
  }

  add(key: string, content: string, priority: number, compressible = true): void;

  /**
   * Assemble context within budget.
   * 1. Sort by priority (ascending = highest priority first)
   * 2. Include sections until budget is reached
   * 3. For compressible sections that don't fit, generate summary placeholder
   * 4. Drop non-compressible sections that don't fit
   */
  assemble(): string;

  /** Returns sections that were dropped or compressed, for logging/debugging */
  getDroppedSections(): string[];
}
```

### 2.2 Priority Matrix

Define per-role, per-phase priority for each context section:

| Section | Manager (eval) | Manager (decision) | Manager (review) | Consultant (analysis) | Consultant (review) | Worker (execution) |
|---------|---------------|-------------------|-------------------|----------------------|--------------------|--------------------|
| System prompt | 1 | 1 | 1 | 1 | 1 | 1 |
| Task/directive | 2 | 2 | 2 | 2 | 2 | 2 |
| Working state | 3 | 3 | 3 | 3 | 4 | 4 |
| Current round (full) | 3 | 4 | - | 3 | - | - |
| Worker output | - | - | 3 | - | 3 | - |
| Bootstrap (codebase) | 6 | 6 | 5 | 5 | 5 | 3 |
| Prior rounds (summary) | 4 | 4 | - | 4 | - | - |
| Prior rounds (full) | 5 | 5 | - | 5 | - | - |
| Full ledger | 7 | 7 | - | 7 | - | - |

### 2.3 Replace Context Assembly Methods

Replace these methods with `ContextBudget`-based assembly:
- `buildRoundNContext` (line 1881)
- `buildManagerEvalContext` (line 1944)
- `buildDecisionContext` (line 1999)

Single replacement function:

```typescript
function assembleContext(
  councilId: string,
  role: 'manager' | 'consultant' | 'worker',
  phase: string,
  tokenBudget: number,
  options?: { includeCurrentRound?: boolean; includeBootstrap?: boolean }
): string
```

### 2.4 Replace `appendToContext` with Working State

**Current**: `appendToContext` (line 2569) appends raw content to the context artifact, growing it unboundedly.

**New**: Maintain a separate `workingState` document:

```typescript
interface WorkingState {
  currentPlan: string;           // What we're building and how
  decisionsLog: string[];        // Key decisions and rationale (1-2 sentences each)
  activeConstraints: string[];   // Non-negotiable requirements
  openQuestions: string[];       // Unresolved issues
  priorAttempts: string[];       // What was tried and why it was rejected/revised
}
```

Updated after each phase via a cheap summarization call (or mechanical extraction from the response). Fixed-size — old entries roll off when new ones are added. Target: <2K tokens total.

### 2.5 Default Token Budgets

| Role/Phase | Default Budget | Rationale |
|-----------|---------------|-----------|
| Manager evaluation | 15K tokens | Summaries + current round |
| Manager decision | 20K tokens | Need full context for final call |
| Manager review | 15K tokens | Directive + output summary |
| Consultant analysis | 20K tokens | Need codebase context |
| Consultant review | 10K tokens | Output summary + directive only |
| Worker execution | 30K tokens | Needs codebase + full directive |
| Worker revision | 25K tokens | Codebase + feedback + prior output summary |

Configurable via `council.deliberation.tokenBudgets`.

---

## Phase 3: NVIDIA LLM Router Integration

### 3.1 Router as Provider

The NVIDIA LLM Router exposes an OpenAI-compatible `/chat/completions` endpoint. Integration is a single addition to `callLLM`:

**File**: `src/cli/llm-caller.ts`

```typescript
if (provider === 'nvidia-router') {
  const routerUrl = process.env.NVIDIA_ROUTER_URL || 'http://localhost:8001/v1';
  return callOpenAICompatible(routerUrl, apiKey, model, systemPrompt, userMessage);
}
```

The router selects the actual model based on query complexity, cost, and latency configuration.

### 3.2 Why Context Budget Matters for Router

When the router picks the model, the orchestrator doesn't know the context window in advance. A simple eval might route to a 32K model; a complex analysis might route to 128K. The context must be:

- **Self-contained**: Any model receiving it can act without prior turns or cached state
- **Budget-aware**: Assembled to a conservative ceiling (configurable), not an assumed model capacity
- **No reliance on provider-side caching**: Different calls may hit different models on different infrastructure — prompt caching is worthless across calls

This is exactly what the `ContextBudget` system (Phase 2) provides. Without it, router integration will produce context-window-exceeded errors on smaller models.

### 3.3 Router Configuration Mapping

The NVIDIA router is configured via `config.yml` with model thresholds, costs, and objective function. Map council roles to router hints:

| Council Role | Router Objective | Rationale |
|-------------|-----------------|-----------|
| Manager (eval, review) | minimize cost | Structured JSON output, moderate reasoning |
| Consultant (analysis) | maximize quality | Core reasoning work |
| Worker (execution) | maximize quality | Code generation needs capability |
| Summarization | minimize cost | Compression, not reasoning |

This can be passed as metadata to the router if it supports routing hints, or achieved by setting different `model` values that map to router profiles.

### 3.4 Removing Per-Persona Provider Binding

When using a router, the per-persona `provider` and `model` fields become irrelevant — the router decides. Add a council-level flag:

```typescript
interface DeliberationConfig {
  // ...existing fields...
  useRouter?: boolean;
  routerUrl?: string;
  routerObjective?: 'cost' | 'quality' | 'latency' | 'balanced';
}
```

When `useRouter` is true, ignore persona-level `provider`/`model` and route all calls through the router endpoint.

---

## Phase 4: Output Token Limits (Estimated: 10-15% savings)

### 4.1 Role-Based `max_tokens`

**File**: `src/cli/llm-caller.ts`

Currently all calls use `max_tokens: 16384`. Set per-role defaults:

| Role/Phase | max_tokens | Rationale |
|-----------|-----------|-----------|
| Manager evaluation | 1500 | JSON response, ~200 words |
| Manager decision | 4000 | Structured decision document |
| Manager review | 2000 | Verdict + feedback |
| Consultant analysis | 3000 | Focused analysis |
| Consultant review | 1500 | Brief review |
| Consultant final position | 500 | 1-2 sentences per spec |
| Worker execution | 16384 | Needs full output capacity |
| Worker revision | 16384 | Needs full output capacity |
| Directive | 2000 | Structured instructions |
| Round summary | 1000 | Brief summary |

**Implementation**: Add `maxOutputTokens` to `AgentInvocation`, set defaults in `invokeAgentSafe` based on the `context` parameter, pass through to the provider call.

### 4.2 Enforce `maxWordsPerResponse` Structurally

Currently `maxWordsPerResponse` is appended as a soft instruction (line 2292). Models routinely ignore it. The actual `max_tokens` parameter is the hard enforcement. Align them:

```typescript
if (wordLimit) {
  // ~1.3 tokens per word average
  invocation.maxOutputTokens = Math.min(
    invocation.maxOutputTokens || 16384,
    Math.ceil(wordLimit * 1.3)
  );
}
```

---

## Phase 5: Bootstrap Context Tiering (Estimated: variable, large for code-heavy projects)

### 5.1 Two-Tier Bootstrap

**File**: `src/council/context-bootstrap.ts`, `src/council/deliberation-orchestrator.ts`

Currently `bootstrapDirectoryContext` is called once with `deep: true` (120K chars / ~30K tokens) and injected into every call via `invokeAgentSafe` (line 2274).

**Change**: Bootstrap at two levels, inject based on role:

```typescript
// During frameProblem:
this.bootstrapLight = await bootstrapDirectoryContext(dir, { deep: false }); // ~10K chars
this.bootstrapDeep = await bootstrapDirectoryContext(dir, { deep: true });   // ~120K chars
```

| Role/Phase | Bootstrap Level | Rationale |
|-----------|----------------|-----------|
| Manager (all phases) | Light | Needs structure, not source code |
| Consultant (analysis) | Light | Reasoning about approach, not reading code |
| Consultant (review of code output) | Deep | Needs to verify code against codebase |
| Worker (execution) | Deep | Needs full source to write code |
| Worker (revision) | Deep | Needs full source |

This is orthogonal to `ContextBudget` — the budget system handles it by assigning bootstrap context a priority and compressing/dropping it when the budget is tight.

### 5.2 Selective File Bootstrap

For coding councils, instead of scanning everything up to 120K chars, allow the directive to specify which files the worker needs:

```typescript
interface WorkDirective {
  // ...existing fields...
  relevantFiles?: string[];  // Paths the worker should focus on
}
```

The bootstrap for worker execution would then only include those files at full fidelity, with the rest at tree-level only. This could cut worker input from 30K tokens to 5-10K tokens.

---

## Implementation Priority

| Phase | Effort | Savings | Priority |
|-------|--------|---------|----------|
| 1.1 Remove consultant final positions | Small | ~40K tokens/session | P0 |
| 1.2 Remove/simplify consultant reviews | Small | ~200K tokens/session | P0 |
| 1.3 Collapse plan+directive into decision | Medium | ~13K tokens/session | P1 |
| 1.4 Cap re-deliberation scope | Medium | ~175K tokens (when triggered) | P1 |
| 4.1 Role-based max_tokens | Small | 10-15% output savings | P0 |
| 2.1-2.3 ContextBudget assembler | Large | 20-30% input savings | P1 |
| 2.4 Working state (replace appendToContext) | Medium | Prevents context artifact bloat | P1 |
| 3.1 Router provider | Small | Enables router integration | P2 |
| 3.2-3.4 Router-aware context + config | Medium | Required for router to work | P2 |
| 5.1-5.2 Bootstrap tiering | Medium | Variable, large for code projects | P2 |

**P0 changes alone should reduce the $15 session to ~$4-5.**
**P0 + P1 should bring it to ~$2-3.**
**Full implementation with router should target <$1 per planning council.**

---

## Metrics to Track

After implementation, log per-session:
- Total LLM calls
- Total input tokens / output tokens (separate)
- Tokens per phase
- Context budget utilization (% of budget used per call)
- Sections dropped/compressed by ContextBudget
- Cost estimate by provider pricing

Add a `--cost-report` flag to CLI that prints a breakdown after each council run.
