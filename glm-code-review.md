# Comprehensive Code Review: kondi-chat

## Overview

**~11,300 lines of TypeScript** across 58 source files, 13 test files with 92 tests. The project is a multi-model AI coding CLI with intelligent routing, budget profiles, council deliberation, and a Rust TUI frontend. Clean typecheck, all tests passing.

---

## Architecture Assessment: ★★★★☆

The layered architecture is well-designed:

```
CLI (backend.ts) → Engine (pipeline, tools) → Providers (llm-caller)
                                        ↘ Router (NN → Intent → Rules)
                                        ↘ Context (manager, memory, budget)
                                        ↘ MCP (client, tool-manager)
                                        ↘ Audit (ledger, analytics, telemetry)
```

**Strengths:**
- Clean separation: provider layer knows nothing about routing, router knows nothing about tools
- The 3-tier router (NN → Intent → Rules) is architecturally sound — graceful degradation
- Task card abstraction (dispatch → execute → verify → reflect) is well-modeled
- MCP integration follows the standard protocol properly

**Concerns:**
- `backend.ts` is a **God object** (~900+ lines) — it wires everything together but contains too much logic itself
- Pipeline and backend overlap in responsibilities (both orchestrate LLM calls + tools)

---

## Critical Issues

### 1. 🔴 Security: Command Injection in `run_command` tool

**File:** `src/engine/tools.ts`

The `run_command` tool passes user-controlled strings directly to `execSync`:

```ts
const result = execSync(args.command, { cwd: workingDir, ... });
```

While the permission system gates execution, a malicious LLM output could construct destructive commands. The non-mutating command prefix list is a good start but uses simple prefix matching — commands like `npm test && rm -rf /` would pass the `npm test` prefix check.

**Fix:** Parse the command into a logical chain and validate each segment independently, or use a proper shell AST parser. At minimum, block `&&`, `||`, `;`, `|`, and `$()` in auto-approved commands.

---

### 2. 🔴 Error Handling: Swallowed Errors in Pipeline

**File:** `src/engine/pipeline.ts`

Multiple catch blocks log errors but don't propagate them meaningfully:

```ts
catch (err) {
  logger.error('Pipeline step failed', err);
  // continues execution silently
}
```

This means a tool call failure in the middle of a multi-step task can be silently ignored, leading to partial/broken results presented to the user as if they succeeded.

**Fix:** Distinguish recoverable vs. fatal errors. Introduce a `PipelineError` type with severity levels. Fatal errors should abort the pipeline and surface to the user.

---

### 3. 🟡 Resource Leak: Unclosed MCP Connections

**Files:** `src/mcp/client.ts`, `src/mcp/tool-manager.ts`

MCP client connections are opened but the cleanup path is fragile — relying on `process.on('exit')` which doesn't fire on SIGKILL or crashes. If the process crashes, stdio transports leave zombie processes.

**Fix:** Use `finally` blocks and implement proper `Symbol.dispose`/`using` pattern. Track child processes and force-kill on cleanup.

---

## Architecture Issues

### 4. 🟡 God Object: `backend.ts`

**File:** `src/cli/backend.ts`

At ~900+ lines, `backend.ts` handles:
- CLI argument parsing
- Session management
- TUI communication
- Tool execution routing
- Council orchestration
- Profile switching
- Analytics setup

This should be decomposed into focused modules: `session-manager.ts`, `tool-dispatcher.ts`, `council-runner.ts`, etc.

### 5. 🟡 Overlapping Responsibilities: Pipeline vs Backend

The pipeline (`src/engine/pipeline.ts`) and backend both orchestrate LLM calls with tools. The pipeline was meant to be the sole orchestrator, but backend bypasses it for several features (council, task cards, non-interactive mode).

**Fix:** Make the pipeline the single orchestration path. Backend should delegate to pipeline, not duplicate its logic.

### 6. 🟡 Circular-ish Dependencies

Several modules import from each other in ways that create tight coupling:
- `router` → `context/manager` → `router` (via config)
- `pipeline` → `tools` → `backend` (via workingDir callback)

The `workingDir` callback pattern in tools is a workaround for the fact that tools don't have a clean dependency injection path.

---

## Code Quality Issues

### 7. 🟡 Inconsistent Error Types

The codebase uses a mix of:
- Raw `Error` with string messages
- Custom error classes (`RouterError`, `ProviderError`)
- `{ error: string }` return objects
- `null` returns to indicate failure

Pick one pattern and stick with it. Recommend: custom error hierarchy with `Result<T, E>` types.

### 8. 🟡 Type Safety Gaps

Several places use `as any` or `Record<string, unknown>` where proper types exist:
- Tool result handling frequently casts to `any`
- Provider response parsing uses loose types
- Config loading doesn't validate at the boundary

### 9. 🟢 Good: Test Coverage for Core Logic

92 tests covering:
- Router (NN classifier, intent, rule engine)
- Context management
- Tool execution
- Provider API handling
- Session persistence

Missing coverage:
- `backend.ts` (the god object — too tightly coupled to test)
- MCP integration (would need mocking stdio transport)
- Council deliberation flow

---

## Performance Concerns

### 10. 🟡 Synchronous File I/O in Hot Path

**File:** `src/engine/tools.ts`

`read_file`, `write_file`, and `edit_file` all use `readFileSync`/`writeFileSync`. In an agent loop processing many tool calls, this blocks the Node event loop.

**Fix:** Switch to `fs/promises` equivalents. The tool execution layer already supports async.

### 11. 🟢 Good: Router Performance

The 3-tier router design (NN → Intent → Rules) with graceful fallback is well-implemented. The NN classifier is lightweight and the fallback chain ensures it always produces a result.

---

## Testing Assessment: ★★★☆☆

| Area | Coverage | Notes |
|------|----------|-------|
| Router | ★★★★★ | NN, intent, rules all well-tested |
| Context | ★★★★☆ | Good coverage of session/memory |
| Tools | ★★★☆☆ | Basic execution tested, edge cases missing |
| Providers | ★★★★☆ | API parsing well-tested |
| Pipeline | ★★☆☆☆ | Integration path undertested |
| Backend | ★☆☆☆☆ | Untestable in current form |
| MCP | ★☆☆☆☆ | No tests |

---

## Summary of Recommendations

| Priority | Issue | Effort |
|----------|-------|--------|
| P0 | Command injection in `run_command` | Small |
| P0 | Swallowed pipeline errors | Medium |
| P1 | Decompose `backend.ts` | Large |
| P1 | MCP connection cleanup | Small |
| P1 | Unify pipeline/backend orchestration | Large |
| P2 | Consistent error handling pattern | Medium |
| P2 | Remove `as any` type casts | Medium |
| P2 | Async file I/O | Small |
| P3 | Add pipeline integration tests | Medium |
| P3 | Add MCP transport tests | Medium |

---

## Overall Assessment: ★★★★☆

This is a well-architected project with clean separation of concerns at the module level. The multi-model routing system is thoughtfully designed with proper fallback chains. The main issues are at the integration layer — the backend God object, overlapping orchestration, and some security hardening around tool execution. None of these are fundamental design flaws; they're refactoring tasks that would bring the code quality in line with the architectural vision.

The project is in good shape for a v0.1.0. The critical items (command injection, error handling) should be addressed before wider distribution. The architecture items can be tackled incrementally.
