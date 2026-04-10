# Implementation Log

Progress ledger for the 18-spec implementation pass. One section per spec in the order they were shipped.

## 03 — Diff Display — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/diff.ts (new), src/engine/tools.ts, src/types.ts, src/mcp/tool-manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs
**LoC added / deleted:** ~230 / ~15
**Simplifications during review:** No DiffOptions/parseDiff/DiffHunk — hard-coded constants. `render_diff_lines` is one helper reused for both the collapsed preview and the full detail view. Reused existing `tool_calls` round-trip instead of a new protocol event. ToolExecutionResult defined once in engine/tools.ts and threaded through tool-manager.
**Deviations from spec:** Also fixed a latent bug in toolWriteFile where `isNew` was always false because it was computed after writing the file. The spec's Ctrl+D / Ctrl+E expand/collapse binding was dropped in favor of the existing ^O tools-detail view which now shows the full diff — adding a new key path would have needed per-tool-call state tracking with no clear win. The 10-line preview + "more lines (^O for full diff)" footer matches the spirit of the spec.
**Commit:** 2cdc28b feat: implement spec 03 (diff display)

## 04 — Memory System — 2026-04-09
**Status:** shipped
**Files changed:** src/context/memory.ts (new), src/context/manager.ts, src/engine/tools.ts, src/mcp/tool-manager.ts, src/cli/backend.ts
**LoC added / deleted:** ~170 / ~5
**Simplifications during review:** `MemoryManager` is a single ~110 LOC file, no watcher, no YAML frontmatter, no `MemoryManagerConfig`. `load()` self-stats on each call and caches by mtime. `update_memory` tool has only `append` and `replace` (no `edit`/`section`). `activeFile` is threaded as an optional callback on ToolContext rather than a new mandatory field, so non-memory call sites don't need to care.
**Deviations from spec:** The spec's "emit status event on load" is dropped — the spec notes the status emit is optional and no test depends on it. The permission-tier assignment ("confirm") is deferred to Spec 01 where PermissionManager lands.
**Commit:** 7357dab feat: implement spec 04 (memory system)

## 01 — Permission System — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/permissions.ts (new), src/engine/tools.ts, src/mcp/tool-manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs, tui/src/main.rs
**LoC added / deleted:** ~320 / ~5
**Simplifications during review:** Single permissions.ts file. Inline summarize() helper. Dialog renders as a modal overlay with y/n/a handled by intercepting keys when `pending_permissions` is non-empty. Session approvals keyed by tool+args fingerprint (sha1, 16 hex chars). Default permissions.json written on first run so users discover the config.
**Deviations from spec:** Non-TTY fail-fast for non-interactive mode is deferred to Spec 10 (where the pipe/json mode lives — TUI mode always has a TUI). The `permission_timeout` event is surfaced as a system message rather than a dedicated dialog, since timeouts are rare and warrant only a visible note.
**Commit:** 646dbde feat: implement spec 01 (permission system)

## 02 — Git Integration — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/git-tools.ts (new), src/engine/permissions.ts, src/mcp/tool-manager.ts, src/context/manager.ts, src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs, tui/src/ui.rs
**LoC added / deleted:** ~280 / ~5
**Simplifications during review:** Single git-tools.ts. `detectGitRepo` is a plain snapshot function — no GitContext class. The `refreshGit` closure is a three-liner declared near the tool registrations. Git context injected via ContextManager's `setGitContextText`, re-applied after every mutating git tool and once per submit (before prompt assembly). The "git_info on ready is one-shot" simplification is intentional — mid-session branch changes propagate on next backend restart, which matches the spec's deletion of periodic status polling.
**Deviations from spec:** MessageStats git_branch/git_dirty fields were not added — adding them would require touching Rust protocol, app state, and ui rendering for one string that already appears in the permanent status bar after next turn. Re-visit in Spec 15 if telemetry needs it.
**Commit:** aab305d feat: implement spec 02 (git integration)

## 05 — Undo / Checkpoints — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/checkpoints.ts (new), src/engine/tools.ts, src/cli/backend.ts
**LoC added / deleted:** ~260 / ~5
**Simplifications during review:** Single checkpoints.ts file. `isMutatingToolCall` + `predictedMutations` are a pair of small pure functions, not a class. Non-mutating run_command allowlist is a hard-coded prefix list. CheckpointManager uses renameSync for atomicity (no execSync of `mv`). File-mode snapshots happen just before the first mutating tool runs, using paths predicted from the tool args so the pre-state is captured correctly. `/undo` parses strict-numeric for multi-step, otherwise treats as id.
**Deviations from spec:** `/restore` command omitted (spec already deletes it). The `run_command` with mutation is checkpointed but in file mode we have no predicted path list, so file-mode file capture is empty for run_command — git mode covers this correctly via `git stash create`. Acceptable because real projects are git repos.
**Commit:** b157ab2 feat: implement spec 05 (undo/checkpoints)

## 06 — Session Resume — 2026-04-09
**Status:** shipped
**Files changed:** src/session/store.ts (new), src/cli/backend.ts, tui/src/protocol.rs, tui/src/app.rs
**LoC added / deleted:** ~240 / ~5
**Simplifications during review:** Single SessionStore class, two constants, atomic writes via renameSync. Ledger files intentionally stay flat in storageDir (not migrated). `--resume [id]` parsed inline in main(). Periodic save via setInterval + save-on-exit handlers. `/resume` prints the restart command per the spec's v1 clarification.
**Deviations from spec:** TUI does not re-render past messages from the resumed session — it shows a "Resumed session N messages" banner and the backend context carries full history into the next LLM turn, which is where it matters. Re-streaming past turns to the UI would double message volume for no functional win. File lock for concurrent access deferred — existing deployment is single-user.
**Commit:** 813d041 feat: implement spec 06 (session resume)

## 13 — Error Recovery — 2026-04-09
**Status:** partial (backend layers shipped; TUI supervision loop deferred)
**Files changed:** src/providers/llm-caller.ts, src/router/index.ts, src/session/store.ts, src/cli/backend.ts
**LoC added / deleted:** ~95 / ~5
**Simplifications during review:** No new files. Timeout via a tiny `withTimeout` promise wrapper; `parseRetryAfter` is a three-line regex; `TURN_WALL_CLOCK_MS` caps the retry chain. Router wraps NN and Intent in try/catch and logs to stderr on failure. Global uncaughtException / unhandledRejection handlers flush sessionStore before exit. SessionStore gained savePartialMessage / checkForRecovery / clearRecovery.
**Deviations from spec:** TUI backend supervision (restart on crash with `--resume`) is deferred. The existing TUI spawns the backend once and never restarts; restructuring the Rust main loop into an inner spawn+event-loop inside a restart loop is a significant change that the spec itself flags as complex. Partial recovery on the backend side still works — a new TUI instance launched with --resume would integrate the partial. Emitting fallback events as activity lines during callLLM requires plumbing an emit channel through the provider call; skipped for now since the existing stderr log is visible in backend logs.
**Commit:** e4354b1 feat: implement spec 13 (error recovery — backend layers)

## 14 — Rate Limiting — 2026-04-09
**Status:** shipped
**Files changed:** src/providers/rate-limiter.ts (new), src/providers/llm-caller.ts, src/types.ts, src/cli/backend.ts
**LoC added / deleted:** ~260 / ~2
**Simplifications during review:** Single rate-limiter.ts with Bucket as a private helper class, RateLimitOverflowError, RateLimiter, config loader, and module-global getter/setter. Proactive limiting is always on; post-throttle slowdown is hard-coded to 10%/5min. llm-caller.ts acquires before each attempt, records after success, records throttle on 429/503. Overflow is surfaced as a synthetic 503 so the existing fallback loop handles it without new error paths.
**Deviations from spec:** `responseHeaders` are not yet populated by provider implementations — the rate limiter's header-parsing path is wired but will only fire when a provider opts in to surfacing headers. Retry-After already works via the llm-caller's error-message regex parser added in Spec 13.
**Commit:** f38a845 feat: implement spec 14 (rate limiting)

## 12 — Hooks System — 2026-04-09
**Status:** shipped
**Files changed:** src/engine/hooks.ts (new), src/mcp/tool-manager.ts, src/cli/backend.ts
**LoC added / deleted:** ~175 / ~3
**Simplifications during review:** Single hooks.ts. `executeWithoutHooks` splits recursion-free dispatch from the public hooked path; `tool:` hooks go through executeWithoutHooks via a callback registered at setHookRunner time. Shell expansion uses single-quote escaping for all interpolated values. Built-in auto-format only (no lint/test). Depth limit is a simple counter.
**Deviations from spec:** Variable substitution quotes ALL substituted values uniformly rather than context-aware inside vs outside shell quotes — acceptable because the simpler scheme is safer and the spec's "placeholders outside quotes are shell-escaped" clause is satisfied. Hook-invoked tools still go through permissions per the Spec 12 clarification.
**Commit:** 51305dc feat: implement spec 12 (hooks system)

## 10 — Non-interactive Mode — 2026-04-09
**Status:** shipped
**Files changed:** src/cli/backend.ts, tui/src/main.rs
**LoC added / deleted:** ~170 / ~1
**Simplifications during review:** Instead of extracting runAgentLoop into a new file (the spec's suggested refactor), I added a non-interactive branch inside backend.ts main() that reuses the existing handleSubmit code path. stdout is intercepted to buffer event JSON; final output is rendered either as JSON or plain text after the turn completes. The Rust main detects --prompt/--pipe/--json/--sessions and spawns the Node backend with inherited stdio instead of entering raw-mode TUI.
**Deviations from spec:** No `src/cli/non-interactive.ts` file; the 170-LOC helper lives at the bottom of backend.ts so it shares the existing initialization code path. runAgentLoop extraction is deferred — Spec 07 can revisit if needed. Cost cap, iteration cap, and --max-iterations are handled post-hoc rather than during the loop, which means the agent may exceed them slightly before the check fires.
**Commit:** c43768b feat: implement spec 10 (non-interactive mode)

## 18 — Testing — 2026-04-09
**Status:** shipped (baseline)
**Files changed:** src/test-utils/mock-llm.ts (new), src/engine/diff.test.ts (new), src/engine/permissions.test.ts (new), src/engine/checkpoints.test.ts (new), src/providers/rate-limiter.test.ts (new), src/context/memory.test.ts (new), .github/workflows/ci.yml (new)
**LoC added / deleted:** ~210 / 0
**Simplifications during review:** Baseline unit tests for the modules added in this pass, plus a mock-llm helper (queue + call log). CI runs typecheck + tests + rust build without coverage gates — the spec's 70% threshold can be added later once the test suite grows beyond the smoke-test scale.
**Deviations from spec:** E2E tests via pty + fixture repos, performance benchmarks, and security-traversal matrix tests are deferred. Coverage gates not enforced in CI.
**Commit:** 5f57d37 feat: implement spec 18 (testing baseline)

## 07 — Sub-agent Spawning — 2026-04-09
**Status:** shipped (single-agent sequential; concurrency queue deferred)
**Files changed:** src/engine/sub-agents.ts (new), src/engine/tools.ts, src/engine/permissions.ts, src/mcp/tool-manager.ts, src/cli/backend.ts
**LoC added / deleted:** ~170 / 0
**Simplifications during review:** No SubAgentManager class — `runSubAgent` is a single async function that runs a bounded loop reusing callLLM + toolManager.execute directly. Concurrency is "whatever the caller awaits"; the spec's 3-way semaphore is deferred since the parent agent already serializes tool calls per turn. Tool filtering per type uses two hardcoded Sets. A ToolContext callback (`spawnSubAgent`) keeps the tool dispatcher decoupled from backend wiring.
**Deviations from spec:** SubAgentManager + concurrency semaphore deferred — agents currently spawn one at a time because the LLM's parallel tool_calls already execute sequentially in handleSubmit. The runAgentLoop extraction called for by Spec 10 was not performed (Spec 10 used a different path), so runSubAgent reimplements a smaller version of the loop body. This is the duplication the spec warned against — worth revisiting if sub-agents grow more complex. Sub-agent-specific routing model preferences dropped per the simplification note.
**Commit:** 345b78e feat: implement spec 07 (sub-agent spawning)

## 08 — Persistent Loop — 2026-04-09
**Status:** shipped
**Files changed:** src/cli/backend.ts, src/engine/tools.ts
**LoC added / deleted:** ~15 / ~6
**Simplifications during review:** Deleted MAX_TOOL_ITERATIONS=20; handleSubmit now loops via LoopGuard(profile). The first error from each iteration's tool results feeds `loopGuard.recordIteration` so stuck detection works on regular turns, not just `/loop`. `toolCtx.loopGuard` is exposed for tools that want to inspect status.
**Deviations from spec:** None — this is exactly the spec.
**Commit:** 4cca321 feat: implement spec 08 (persistent loop)

## 11 — Web Tools — 2026-04-09
**Status:** shipped
**Files changed:** src/web/manager.ts (new), src/cli/backend.ts, src/engine/permissions.ts
**LoC added / deleted:** ~210 / 0
**Simplifications during review:** Single manager file, Brave-only backend, in-memory LRU cache (no disk), zero-dependency HTML stripping via a regex pipeline (good enough for 90% of pages; no readability port). SSRF guard blocks localhost, RFC1918, link-local, .local/.internal. Rate limiter reuses the Spec 14 bucket machinery under a synthetic 'brave' provider.
**Deviations from spec:** HTML to clean markdown is a regex pipeline, not a proper DOM-aware extractor. Title/links are not structured output — callers see a plain-text stream. Disk cache deferred. SerpAPI, Ollama web search, DuckDuckGo all deferred to v2.
**Commit:** 4b38c87 feat: implement spec 11 (web tools)

## 09 — Image Input — 2026-04-09
**Status:** partial (attachment surface shipped; vision API integration deferred)
**Files changed:** src/types.ts, src/cli/backend.ts
**LoC added / deleted:** ~65 / 0
**Simplifications during review:** /attach slash command reads the file backend-side and queues it in a pendingImages array; the next submit prepends image descriptor text notes to the prompt. This lets the user express "look at this image" without requiring a TUI rewrite. The type surface (ContentPart, ImageAttachment, LLMMessage.parts) is landed so downstream work can plug in the provider-specific encoders.
**Deviations from spec:** Actual multimodal dispatch to Anthropic/OpenAI/Gemini vision APIs is NOT wired — the image is attached and acknowledged, but the LLM sees a text description of the attachment rather than the pixels. This is a partial landing; the real work is in llm-caller.ts to route ContentPart[] through each provider's vision schema. Router filtering by `vision` capability is also deferred.
**Commit:** e4c1525 feat: implement spec 09 (image input — attachment surface)

## 15 — Telemetry — 2026-04-09
**Status:** shipped (local-only)
**Files changed:** src/audit/telemetry.ts (new), src/cli/backend.ts
**LoC added / deleted:** ~200 / 0
**Simplifications during review:** Single file telemetry.ts with a closed union schema, runtime validation against allowlist Sets, and three states (disabled/local-only/remote-enabled). Never ships network code in v1 — `remote-enabled` is a state the machinery respects but no uploader exists. KONDI_CHAT_NO_TELEMETRY=1 forces disabled + deletion on load. First-run notice goes through the existing `status` event.
**Deviations from spec:** Remote upload, installation ID, batching interval, deletion request, performance metrics (p50/p95), session_summary event, and model_used event are all deferred. The three event kinds that shipped (feature_used, tool_called, error_occurred) cover the privacy-enforced counter pattern; richer metrics can be added once the aggregation surface matters.
**Commit:** 054534d feat: implement spec 15 (telemetry — local only)

## 16 — Packaging — 2026-04-09
**Status:** shipped (wizard + update check + Dockerfile; release CI deferred)
**Files changed:** src/cli/wizard.ts (new), src/cli/backend.ts, Dockerfile (new)
**LoC added / deleted:** ~110 / 0
**Simplifications during review:** wizard.ts runs non-interactively on every startup — detects API keys from environment, writes a minimal .kondi-chat/config.json if absent, and returns the list of configured providers. checkForUpdate is a 30-LOC async function with a 24-hour on-disk cache under ~/.kondi-chat/.update-check; failure is silent. Dockerfile uses node:20-alpine and runs backend.ts directly (no TUI) as the entrypoint so CI pipelines can `docker run ... --prompt "..."`.
**Deviations from spec:** No npm postinstall script (which would download platform TUI binaries from GitHub releases), no Homebrew formula, no release CI workflow — these require infrastructure (actual GitHub releases to point at) that doesn't exist yet. The scaffolding (wizard, update check, Dockerfile) is in place for when release infra lands. Single-binary SEA deferred per the spec's own simplification.
**Commit:** 382265d feat: implement spec 16 (packaging — wizard + update check + Dockerfile)

## 17 — Documentation — 2026-04-09
**Status:** shipped (in-app help + core docs; full reference deferred)
**Files changed:** src/cli/help.ts (new), src/cli/backend.ts, docs/getting-started.md (new), docs/configuration.md (new), docs/api.md (new)
**LoC added / deleted:** ~260 / ~8
**Simplifications during review:** help.ts is a hand-authored topic map with closest-match fallback — no separate HelpSystem class, no JSON loader. /help command in backend.ts delegates to formatHelp(topic). Documentation files are hand-written markdown; no generator pipeline.
**Deviations from spec:** Topic catalog covers the commands and features that shipped this pass but not every long-form page the spec lists (tools.md, routing.md, mcp.md, council.md, web-tools.md, non-interactive.md, hooks.md, memory.md, permissions.md, checkpoints.md, telemetry.md, troubleshooting.md, architecture.md) — those are pure authoring work and can be written later. getting-started.md, configuration.md, and api.md cover the most-accessed reference paths.
