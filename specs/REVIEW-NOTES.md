# Spec Review Notes (2026-04-09)

Paper review of CONVENTIONS.md + specs 01–18 against the real codebase in `src/` and `tui/src/`. Edits were made in place; this file summarizes what was changed and why.

## Cross-cutting themes

1. **Drift between spec prose and existing module signatures.** Several specs reference functions, constructor args, or field names that don't match the code as-committed. The most common offenders:
   - `ToolManager` is constructed with only `McpClientManager`. It has no `permissionManager`, `hookRunner`, or `visionCapability` field — state must flow through `ToolContext`, which CONVENTIONS.md already declares. Specs 01 and 12 were written as if `ToolManager` had these as fields.
   - `Router.select(phase, promptText, taskKind, failures, promotionThreshold)` has no `hasImages` parameter today (Spec 09 assumed it did).
   - `LoopGuard.normalizeError` is private (Spec 08 listed it as public).
   - `LoopGuard.recordIteration` uses a positional signature (Spec 08 clarification asked for object-shape; spec now acknowledges the mismatch).
   - `callLLM` is the only public entry point to the provider layer. Specs 13 and 14 proposed wrapping or replacing call sites one at a time, which is both risky and inconsistent; the simpler fix (now documented) is to keep `callLLM` as the sole entry and internalize retry/rate-limit/timeout.

2. **Storage path confusion.** The `.kondi-chat/` directory currently holds flat `<session-id>-ledger.json` and `<session-id>-session.json` files; ledgers load from disk on construct (`Ledger(sessionId, storageDir)`). Specs 05 and 06 drew layout diagrams that contradicted this, and Spec 06 implied ledgers lived under `sessions/`. All three (05, 06, and CONVENTIONS.md) now point at the same canonical layout.

3. **The agent loop in `handleSubmit()` is a bottleneck.** Spec 07 (sub-agents) proposes duplicating it; Spec 10 (non-interactive) proposes extracting it to `src/engine/agent-loop.ts`. These must happen in order (10 → 07) or the code forks. CONVENTIONS.md already places Spec 10 before Spec 07; Spec 07 now calls this out explicitly as a hard prerequisite.

4. **TUI backend supervision is not in place today.** `tui/src/main.rs` spawns the backend once and drains stdout in a loop; there's no restart logic, process monitor, or state persistence across spawns. Spec 13's supervision design is feasible but non-trivial and was previously presented as a light touch. The revised spec flags the restructure required.

5. **Non-TTY auto-switching.** Spec 10 had contradictory text: the clarifications required an explicit flag, but the code snippet still included `|| !process.stdout.isTTY`. Fixed.

## Per-spec issues

### CONVENTIONS.md
- **Fix:** added an explicit note about existing flat `<session-id>-ledger.json` and `<session-id>-session.json` files at storage root; any spec that relocates them must migrate.

### 01 — Permission System
- **Issue:** The sample `ToolManager.execute()` integration used `this.permissionManager` and `toolCtx.emit`, but `ToolManager` has no such field and `ToolContext` has no `emit` in the current codebase (CONVENTIONS.md does extend it). Also, the permission wedge was only shown around the built-in branch, missing `extraExecutors` (council) and the MCP `__` split.
- **Fix:** rewrote the integration snippet to read `toolCtx.permissionManager` and `toolCtx.emit`, and added a note that the wedge must sit above all three dispatch branches (`extraExecutors` / MCP / built-in).

### 02 — Git Integration
- **Issue 1:** Spec said "Register git tools with ToolManager" without specifying how, and the only registration mechanism that exists today is `toolManager.registerTool(tool, executor)` with module-scoped `extraExecutors`. **Fix:** provided an explicit loop using the correct signature and showed `gitCtx` refresh inside the executor closure.
- **Issue 2:** Worktree-detection claim via `git rev-parse --show-toplevel` was wrong — that command returns the same value in the main and linked worktrees. **Fix:** added `--git-common-dir` as the actual distinguishing check.
- **Issue 3:** `computeUnifiedDiff` was declared in both Spec 02 and Spec 03. **Fix:** Spec 03 owns it; Spec 02 imports.

### 03 — Diff Display
- **Issue:** Current `handleSubmit()` pushes `{ name, args, result: capped.slice(0, 300), is_error }` into `allToolCalls` — the `result` field is truncated to 300 chars for UI preview, and there's no `diff` slot at all. Spec showed an idealized `ToolCallInfo` without addressing the plumbing.
- **Fix:** added a "Tool-result plumbing in backend.ts" subsection enumerating the four concrete changes (type, executor, handleSubmit push, round-trip).
- **Fix:** flagged the duplicate `computeUnifiedDiff` declaration with Spec 02.

### 04 — Memory System
- **Issue:** Clarification requires `memory.load(activePath)` but `ContextManager.assemblePrompt()` has no signal for "active file" — nothing in the session state tracks current focus. The spec glossed this over.
- **Fix:** added explicit options (`setActiveFile` method, working-dir fallback) and explained the trade-off.

### 05 — Undo / Checkpoints
- **Issue 1:** `/undo` parsing used `parseInt(parts[1]) || 1`, which silently coerces any non-numeric checkpoint id (e.g. `cp-abc`) to `1`, then `isNaN` never fires because `1` is a number. Directly contradicts the 2026-04-09 "Reject non-numeric/unknown ids" clarification. **Fix:** rewrote the command handler with a strict integer regex.
- **Issue 2:** Storage layout diagram showed both `.kondi-chat/checkpoints/index.json` at top and `<session-id>/index.json` nested — collision. **Fix:** there is only the per-session index; removed the top-level one.

### 06 — Session Resume
- **Issue 1:** Storage diagram placed `<session-id>-ledger.json` under `sessions/`, but `Ledger` writes it flat at `storageDir` root. **Fix:** corrected the diagram and added a Revised block explaining the existing flat layout for both ledger and session files.
- **Issue 2:** "Hot swap" of session state was described and then deferred — the defer is correct, just rephrased for clarity.
- **Issue 3:** The note about `Ledger` loading from disk on construct is now explicit and cites `src/audit/ledger.ts` to anchor the claim.

### 07 — Sub-agents
- **Issue 1:** Spec described a "mini agent loop identical to handleSubmit" in `sub-agents.ts`, which would fork the agent loop. **Fix:** mandated calling `runAgentLoop` from Spec 10 instead, and made the Spec 10 → Spec 07 ordering an explicit prerequisite.
- **Issue 2:** Small note on `ctx.pipelineConfig.router!` — verified it is always present in `backend.ts`-constructed toolCtx, so the non-null assertion is defensible; added a comment.

### 08 — Persistent Loop
- **Issue 1:** `toolPersist` called `ctx.loopGuard.recordIteration(0, ...)`, but `handleSubmit` already calls `loopGuard.recordIteration(iterCost)` once per LLM iteration. This would double-count every iteration. Also directly contradicts the 2026-04-10 "A persist call itself does not count as an iteration" clarification. **Fix:** removed the extra `recordIteration` call and added a comment.
- **Issue 2:** `normalizeError` listed as a public method of `LoopGuard`; it is private. **Fix:** corrected.
- **Issue 3:** Clarification asked for object-shape `recordIteration({ costUsd, errorHash? })` but the code uses positional args. **Fix:** acknowledged the mismatch and recommended keeping positional for now.

### 09 — Image Input
- **Issue:** `select(phase, taskKind, ..., hasImages?)` signature was shown on `RuleRouter.select`, but the actual router has a different shape and lives at `Router.select` in `src/router/index.ts`. Throwing from `rules.select()` also breaks the "rules always succeeds" contract the outer Router relies on.
- **Fix:** rewrote the integration to add `hasImages` to the outer `Router.select` wrapper, short-circuit NN/Intent when images are present, add the @mention fail-closed path per the 2026-04-10 clarification, and explicitly forbid throwing from `RuleRouter`.

### 10 — Non-interactive
- **Issue:** Detection snippet included `|| !process.stdout.isTTY`, contradicting the clarification that requires an explicit flag. **Fix:** removed the TTY check.

### 11 — Web Tools
- **Issue:** Registration snippet passed `async (args) => ...` to `registerTool`, but the expected signature is `(args, toolCtx) => ...`. **Fix:** corrected the signature. Also noted that cancellation-on-turn-end requires threading an `AbortSignal` through `ToolContext`, which doesn't exist today — punted with a note.

### 12 — Hooks System
- **Issue:** `executeWithoutHooks` was marked `private` but `HookRunner` needs to call it via `setToolExecutor`. **Fix:** changed to package-private and added a comment that permission checks still run on hook-invoked tool calls.

### 13 — Error Recovery
- **Issue 1:** Spec proposed replacing `callLLM` with `callLLMWithRetry` at every call site. The codebase has many call sites (backend.ts, context/manager.ts, pipeline.ts, intent-router.ts, council/tool.ts). **Fix:** recommended internalizing retry/rate-limit/timeout inside `callLLM` itself (rename the current raw impl to `callProviderRaw` and wrap). No call sites change.
- **Issue 2:** The TUI backend supervision description downplayed the restructure required. The current `main.rs` has no supervision hook at all — the spawn and event loop are interleaved in `main()`. **Fix:** added a Revised block explaining the restructure, including terminal state and `App` persistence across restarts.

### 14 — Rate Limiting
- **Fix:** aligned with Spec 13's "single `callLLM` wrapper" approach; documented the acquire→retry→record order inside the wrapper, and flagged that the module-level `globalRateLimiter` needs test reset hooks.

### 15 — Telemetry
- **Issue:** `setConsent(enabled, remoteEnabled)` doesn't cleanly encode the 3-state clarification (`disabled` / `local-only` / `remote-enabled`). **Fix:** changed signature to take a single state enum and documented that `setConsent('disabled')` must call `deleteAll()`.

### 16 — Packaging
- **Issue:** Node SEA claim was presented as a done deal. SEA (Node 22) is still experimental, native-addon-hostile, and `postject` is platform-fragile. **Fix:** added caveats and a concrete fallback (esbuild bundle + spawn `node dist/backend.js`), noting the fallback is close to the npm-install experience anyway.

### 17 — Documentation
- **No changes.** The spec is mostly fine. Auto-generation drift is a real risk but the CI "fail on drift" approach is sound.

### 18 — Testing
- **No changes.** Spec is reasonable as-is. One minor concern: the `src/test-utils/` directory doesn't exist yet and the tests in `src/**/*.test.ts` (existing: `ledger.test.ts`, `manager.test.ts`, `budget.test.ts`, `task-card.test.ts`, `verify.test.ts`, `registry.test.ts`, `rules.test.ts`, `collector.test.ts`) use vitest conventions — so creating `src/test-utils/` is a straightforward addition.

## Issues flagged but not fixed

- **Non-interactive progress to stderr (Spec 10):** the non-interactive mode's `onProgress` callback writes to stderr, but the Node `process.stderr.write` path is currently used by debug logging in `src/engine/tools.ts` and `src/context/manager.ts`. Mixing those streams means JSON-mode progress will interleave with debug output. The clean fix is an explicit logger abstraction, which is out of scope for this review.
- **`ToolContext.mutatedFiles` scope (Spec 05 vs Spec 04):** Spec 05 uses `mutatedFiles` as a per-turn set for checkpoint creation; Spec 04's "active file for memory" wants the same field for focus tracking. These are different semantic needs. I noted it inline in Spec 04 but did not resolve — may need a separate `activeFile` field on `ToolContext`.
- **Spec 07 cost rollup:** sub-agent ledger entries get tagged with `subAgentId`, but `Ledger.getTotals()` doesn't yet bucket by that tag. The `/cost` breakdown described in Spec 07 requires a new `getTotals({ groupBySubAgent: true })` overload. Not blocking, just noting.
- **Spec 09 image message persistence:** storing base64 blobs in `session.messages` will balloon session files. The spec mentions an `imageCache: Map<string, ImageAttachment>` keyed by hash but doesn't resolve where the cache itself is persisted. On resume, images would vanish unless the cache is on disk. Flagged but not fixed — design choice.
- **Spec 13 partial-stream recovery vs Spec 06 periodic save:** both write to `.kondi-chat/recovery/<session-id>-partial.json` vs `.kondi-chat/sessions/<id>.json`; the merge logic on resume is described as "integrate partial file as the last message" but the actual de-dup algorithm (clarification: "de-dup by message ID and append only missing tokens") isn't specified. Not a spec error, but the two specs should be read together during implementation.

## Design questions raised

- **The whole persist-loop story (Spec 08)** is muddied by already having `MAX_TOOL_ITERATIONS=20` in `backend.ts` plus a separate `LoopGuard` + `BudgetProfile.loopIterationCap`. The spec now says "hard cap of 50 applies only to persistent-loop iterations", but the backend loop has one counter. Consolidating these into a single iteration counter governed by `LoopGuard` (and dropping `MAX_TOOL_ITERATIONS`) would be cleaner; kept the dual-counter design for now because removing the hard constant is a behavior change.
- **The `subAgentManager` on `ToolContext` (Spec 07)** creates a dependency cycle: `ToolContext` → `SubAgentManager` → `ToolManager` → `ToolContext`. TypeScript handles this via interface-only imports, but it's worth noting. The simpler shape is to pass `SubAgentManager` into `executeTool` directly as a parameter rather than stashing it on the shared context object.
- **Hooks + permissions + checkpoints ordering (CONVENTIONS.md):** the documented order is hook-before → permission → tool → hook-after. This means a hook can block a write *before* the checkpoint is created. But the checkpoint is created "just before the first mutating tool call" (Spec 05), which is after the permission check but before the actual tool. So: hook-before → permission → **checkpoint** → tool → hook-after. Spec 05 doesn't explicitly place checkpoint creation relative to permission checks; worth a line in CONVENTIONS.md if this ordering matters (it does for "checkpoint captures exactly the pre-mutation state" guarantees).
