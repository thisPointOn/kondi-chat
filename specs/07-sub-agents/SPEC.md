# 07 — Sub-agent Spawning

## Product Description

Sub-agent spawning gives the main agent a `spawn_agent` tool that launches child agents with isolated context. Child agents run in parallel, return their results, and let the parent compose work across multiple specialized contexts. Sub-agent types (research, worker, planner) have different tool access, and the router picks appropriate models per type.

**Why it matters:** Complex tasks benefit from divide-and-conquer. A main agent trying to research a library, write code, and plan architecture in one context burns through tokens and loses focus. Sub-agents let the parent delegate bounded tasks to specialized children, keeping its own context clean.

**Revised 2026-04-10 (simplification pass):** Collapsed the three sub-agent events (`started` / `progress` / `completed`) into one `sub_agent_event` carrying a `status: 'started' | 'progress' | 'completed'` field. Dropped `researchModelPreference` / `workerModelPreference` / `plannerModelPreference` — the per-type tool filter plus the existing router phase mapping already picks the right model. Dropped `SubAgentManagerConfig` in favor of three constants. Effort dropped from 5 days to 2.5 days (assuming Spec 10's `runAgentLoop` extraction lands first).

## User Stories

1. **Parallel research:** The user asks "compare React Query and SWR for my use case." The agent spawns two research sub-agents in parallel, each reading docs and examples for one library. When both return, the agent synthesizes a comparison.

2. **Worker delegation:** The main agent is planning a large refactor. It spawns a worker sub-agent with the instruction "implement the User model migration in `src/models/user.ts`." The worker has write access and completes the task while the parent continues planning the next step.

3. **Planner without tools:** The agent needs a plan for a feature but doesn't want the planning model wasting context on file reads. It spawns a planner sub-agent (no tools, just LLM reasoning) with the task description and gets back a structured plan.

4. **Cost tracking:** After spawning 5 sub-agents, the user runs `/cost` and sees a breakdown: parent session + each sub-agent's cost. Sub-agent costs roll up to the parent session total.

5. **Concurrency limits:** The agent tries to spawn 10 sub-agents in one turn. The system allows 3 (default max) to start immediately; the rest queue. As sub-agents complete, queued ones start.

## Clarifications (2026-04-10)

- **Isolation & merge:** Sub-agents run in the same filesystem and session by default. To avoid conflicts, only one worker sub-agent may hold a writable lock on a given file set; the manager must reject or serialize conflicting writes. Parent must explicitly merge child results; no automatic apply.
- **Shared vs copied state:** Shared: model registry, permission config, memory is read-only by children unless `allowMemoryWrite` flag is set per spawn. Permissions: approvals are inherited but still rechecked; a denied prompt in a child does not auto-approve in parent.
- **Cancellation:** On parent abort (`^C` or turn cancellation), queued children are dropped; running children receive cancel and their ledger entries are marked canceled; pending permission prompts are rejected.
- **Routing preference:** `spawn_agent` may request a provider/model; otherwise parent router picks per child type. If a user mentions `@model`, that is authoritative unless the model lacks required tools; in that case fail with a clear error, not silent swap.
- **Result size control:** Child results returned to parent must be capped (e.g., 4k chars) and summarized if longer; include `truncated: true` flag when summarized to protect parent context window.
- **Events schema:** Standardize payload keys to `{ id, type, status, model, costUsd, error? }` for start/progress/complete; version these events to avoid breakage in TUI/backends.
## Technical Design

### Architecture

```
Parent Agent
    │
    │ spawn_agent(type, instruction, context_hint)
    v
┌────────────────────────────────────┐
│ SubAgentManager                    │
│   - Concurrency pool (default 3)   │
│   - Tracks active sub-agents       │
│   - Per-sub-agent cost accumulator │
└────────────┬───────────────────────┘
             │
             v
      Child Agent (isolated)
             │
             ├─ Own LLMMessage[] history
             ├─ Subset of parent's tools (based on type)
             ├─ Shared: router, ledger, context
             ├─ Own cost accumulator
             │
             v
       Result returned to parent
```

### Sub-agent types

| Type | Tools available | Use case | Default routing phase |
|------|-----------------|----------|----------------------|
| `research` | `read_file`, `list_files`, `search_code`, `web_search`, `web_fetch` | Information gathering, docs review | `discuss` |
| `worker` | All tools including `write_file`, `edit_file`, `run_command` | Bounded implementation tasks | `execute` |
| `planner` | None (pure LLM reasoning) | Planning, architecture, analysis | `dispatch` |

### Isolation model

Each sub-agent has:
- **Own `LLMMessage[]` history** — starts fresh with just the system prompt + instruction
- **Own cost counter** — reported separately and rolled up to parent
- **Shared:** ledger (all calls logged globally), router, registry, permissions, memory manager
- **Read-only access to parent session state** (goal, plan, constraints) so children understand context
- **Cannot** spawn nested sub-agents (for v1; avoids runaway recursion)

### Parallel execution

Sub-agents run concurrently using `Promise.all` with a semaphore bounded by `maxConcurrentSubAgents` (default 3). If the agent spawns more than the limit, excess are queued.

Each sub-agent runs its own mini agent loop identical to `handleSubmit()` — iterate calling the LLM, execute tools, until no more tool calls or max iterations reached.

**Revised:** do not copy the `handleSubmit()` loop body into `sub-agents.ts`. Spec 10 extracts the loop into `src/engine/agent-loop.ts` via `runAgentLoop(input, config)`. `SubAgentManager.runSubAgent` must call `runAgentLoop` with: a synthetic `Session` (or the parent session + scoped context), a filtered `ToolManager.getTools()` result, and a bounded `maxIterations` / `maxCostUsd`. This forces the sub-agent and main agent to share retry, rate-limit, loop-guard, and telemetry plumbing. Rationale: two copies of the agent loop will drift within weeks.

**Ordering constraint:** Spec 07 cannot be implemented before Spec 10 extracts the loop. The CONVENTIONS.md implementation order already places Spec 10 before Spec 07 — preserve that order.

## Implementation Details

### New files

**`src/engine/sub-agents.ts`**

```typescript
import type { ToolDefinition, ToolCall, LLMMessage, Session } from '../types.ts';
import type { Router } from '../router/index.ts';
import type { Ledger } from '../audit/ledger.ts';
import type { ToolContext } from './tools.ts';
import type { ToolManager } from '../mcp/tool-manager.ts';

export type SubAgentType = 'research' | 'worker' | 'planner';

export interface SubAgentRequest {
  type: SubAgentType;
  instruction: string;
  contextHint?: string;  // Optional additional context from parent
  maxIterations?: number;  // Override default (10)
  maxCostUsd?: number;  // Override default (0.50)
}

export interface SubAgentResult {
  id: string;
  type: SubAgentType;
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  iterations: number;
  modelsUsed: string[];
  toolCalls: Array<{ name: string; args: string; isError: boolean }>;
  stoppedReason: 'done' | 'max-iterations' | 'cost-cap' | 'error';
  error?: string;
}

export interface SubAgentManagerConfig {
  maxConcurrent?: number;  // default 3
  defaultMaxIterations?: number;  // default 10
  defaultMaxCostUsd?: number;  // default 0.50
}

export class SubAgentManager {
  private config: Required<SubAgentManagerConfig>;
  private active: Map<string, SubAgentState>;
  private queue: Array<{ request: SubAgentRequest; resolve: (r: SubAgentResult) => void }>;

  constructor(config?: SubAgentManagerConfig);

  /** Spawn a sub-agent and wait for its result */
  async spawn(
    request: SubAgentRequest,
    parentCtx: {
      session: Session;
      router: Router;
      ledger: Ledger;
      toolManager: ToolManager;
      toolCtx: ToolContext;
      emit: (event: any) => void;
    },
  ): Promise<SubAgentResult>;

  /** Get status of all active sub-agents */
  getActive(): Array<{ id: string; type: SubAgentType; instruction: string; iteration: number; costUsd: number }>;

  private async runSubAgent(
    id: string,
    request: SubAgentRequest,
    parentCtx: ParentContext,
  ): Promise<SubAgentResult>;

  private getAllowedTools(type: SubAgentType, allTools: ToolDefinition[]): ToolDefinition[];

  private buildSystemPrompt(type: SubAgentType, parentSession: Session, instruction: string): string;
}

interface SubAgentState {
  id: string;
  type: SubAgentType;
  instruction: string;
  iteration: number;
  costUsd: number;
  startedAt: string;
}
```

### Spawn tool definition

Add to `src/engine/tools.ts`:

```typescript
{
  name: 'spawn_agent',
  description: 'Spawn a child agent with isolated context. Use for parallel research, delegated implementation, or isolated planning. Returns the child\'s final result.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['research', 'worker', 'planner'],
        description: 'research: read-only info gathering. worker: full tool access for implementation. planner: pure reasoning, no tools.',
      },
      instruction: {
        type: 'string',
        description: 'Clear, bounded instruction for the child agent',
      },
      context_hint: {
        type: 'string',
        description: 'Additional context from the parent (files, constraints, relevant state)',
      },
    },
    required: ['type', 'instruction'],
  },
}
```

### Tool execution

Add to `src/engine/tools.ts` `executeTool()`:

```typescript
case 'spawn_agent':
  return await toolSpawnAgent(args, ctx);

async function toolSpawnAgent(args, ctx) {
  if (!ctx.subAgentManager) {
    return { content: 'Sub-agents not available in this context', isError: true };
  }
  const result = await ctx.subAgentManager.spawn(
    {
      type: args.type as SubAgentType,
      instruction: args.instruction as string,
      contextHint: args.context_hint as string,
    },
    {
      session: ctx.session,
      router: ctx.pipelineConfig.router!,  // guaranteed present in backend.ts; fail fast if undefined
      ledger: ctx.ledger,
      toolManager: ctx.toolManager!,
      toolCtx: ctx,
      emit: ctx.emit!,
    },
  );

  return {
    content: [
      `Sub-agent ${result.id} (${result.type}) ${result.stoppedReason}`,
      `Cost: $${result.costUsd.toFixed(4)} | ${result.iterations} iterations | tools: ${result.toolCalls.length}`,
      '',
      result.content,
    ].join('\n'),
  };
}
```

### Modified files

**`src/engine/tools.ts`** — Extend `ToolContext`:

```typescript
export interface ToolContext {
  workingDir: string;
  session: Session;
  ledger: Ledger;
  pipelineConfig: PipelineConfig;
  memoryManager?: MemoryManager;
  mutatedFiles?: Set<string>;
  checkpointManager?: CheckpointManager;
  subAgentManager?: SubAgentManager;  // NEW
  toolManager?: ToolManager;  // NEW (needed by sub-agents)
  emit?: (event: any) => void;  // NEW (needed for sub-agent progress events)
}
```

**`src/cli/backend.ts`** — Initialize and wire up:

```typescript
import { SubAgentManager } from '../engine/sub-agents.ts';

const subAgentManager = new SubAgentManager({
  maxConcurrent: 3,
  defaultMaxIterations: 10,
  defaultMaxCostUsd: 0.50,
});

const toolCtx: ToolContext = {
  // ... existing
  subAgentManager,
  toolManager,
  emit,
};
```

### Ledger integration

Every LLM call inside a sub-agent is recorded in the parent's ledger with a `subAgentId` field:

```typescript
interface LedgerEntry {
  // ... existing fields
  subAgentId?: string;  // NEW
  subAgentType?: SubAgentType;  // NEW
}
```

This enables `/cost` to break down costs by sub-agent:

```
Total: $1.2345 (15 calls)
  parent: $0.8234 (9 calls)
  sub-agent (research) abc12345: $0.2100 (3 calls)
  sub-agent (worker)   def67890: $0.2011 (3 calls)
```

### Rate limiting interaction

Sub-agents share the parent's `globalRateLimiter` (set via `setRateLimiter()` from Spec 14). All LLM calls from children go through the same token buckets as the parent. This means:

- Spawning 3 parallel sub-agents does not triple effective throughput — they share the same per-provider RPM/TPM budget
- A parent hitting its rate limit causes all its children to queue
- Queue fairness is FIFO within each provider; child requests interleave with parent requests based on submission order

If you want sub-agents to use a different provider than the parent (e.g., to sidestep rate limits), use the `researchModelPreference` / `workerModelPreference` / `plannerModelPreference` config to route them to different capabilities that map to different providers.

### Permission handling

Sub-agents inherit the parent's permission state. Any `confirm`-tier tool call still triggers a TUI permission request. The permission request event includes the sub-agent id so users can see which child is making the request:

```json
{
  "type": "permission_request",
  "id": "perm-...",
  "tool": "write_file",
  "sub_agent_id": "sub-abc123",
  "sub_agent_type": "worker",
  ...
}
```

## Protocol Changes

### New event: `sub_agent_event`

One event with a `status` discriminator:

```json
{
  "type": "sub_agent_event",
  "id": "sub-abc123",
  "status": "started" | "progress" | "completed",
  "agent_type": "research",
  "iteration": 2,
  "cost_usd": 0.0123,
  "last_tool": "read_file",
  "stopped_reason": "done",
  "summary": "First 200 chars of result..."
}
```

Fields are populated per status: `started` carries `agent_type` + `instruction`; `progress` carries `iteration` + `cost_usd` + `last_tool`; `completed` carries `cost_usd` + `iterations` + `stopped_reason` + `summary`. The TUI renders a single sub-agent panel keyed by `id`. **Revised:** three events collapsed to one.

## Configuration

No config. Constants in `sub-agents.ts`: `MAX_CONCURRENT=3`, `DEFAULT_MAX_ITERATIONS=10`, `DEFAULT_MAX_COST_USD=0.50`. Nesting is hard-disabled in v1. Model selection per type falls out of the router phase — `research`/`planner` call `router.select('discuss', ...)` and `worker` calls `router.select('execute', ...)`, reusing existing routing without new preference config. **Revised:** deleted all three `*ModelPreference` knobs.

## Error Handling

| Scenario | Handling |
|----------|----------|
| Sub-agent exceeds cost cap | Stop immediately, return partial result with `stoppedReason: 'cost-cap'` |
| Sub-agent hits max iterations | Return partial result with `stoppedReason: 'max-iterations'` |
| Sub-agent tool call fails | Continue the loop (tool errors are normal) |
| LLM error (network, rate limit) | Retry once, then fail with `stoppedReason: 'error'` |
| Concurrent limit exceeded | Queue the request; agent waits for a slot |
| Parent cancels (user ^C) | All active sub-agents are aborted, partial results discarded |
| Sub-agent attempts to spawn nested sub-agent (v1) | Return error: "nested sub-agents not supported" |
| Permission denied for a sub-agent tool call | Tool returns error; sub-agent can continue or stop |

## Testing Plan

1. **Unit tests** (`src/engine/sub-agents.test.ts`):
   - Tool filtering per agent type
   - System prompt generation
   - Cost accumulation
   - Concurrency limits: 4th spawn queues behind first 3
   - Stopping reasons (done, max-iterations, cost-cap)

2. **Integration tests**:
   - Full parent -> spawn -> child -> return flow
   - Parallel sub-agents complete in expected time
   - Ledger correctly tags sub-agent entries
   - `/cost` breakdown includes sub-agents

3. **E2E tests**:
   - TUI shows sub-agent progress events
   - Permission requests from sub-agents work
   - Cancellation aborts children cleanly

## Dependencies

- **Depends on:** `src/cli/backend.ts` (agent loop logic to duplicate for children), `src/mcp/tool-manager.ts` (tool filtering), `src/router/index.ts` (routing for children), Spec 01 (Permission System)
- **Depended on by:** Spec 11 (Web Tools — research sub-agents benefit from web tools), Spec 14 (Rate Limiting — sub-agents share rate limit quota)

## Estimated Effort

**2.5 days** (revised from 5 days, assuming Spec 10's `runAgentLoop` extraction has landed)
- Day 1: `SubAgentManager` with concurrency semaphore; `runSubAgent` delegating to `runAgentLoop`; tool filtering per type; spawn_agent tool.
- Day 2: Ledger tagging, `sub_agent_event` protocol wiring, TUI sub-agent panel, permission pass-through with `sub_agent_id` field.
- Day 2.5: Cancellation, smoke tests.
