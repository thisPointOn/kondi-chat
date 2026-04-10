# Simplification Pass — 2026-04-10

Pass over all 17 non-08 specs (Spec 08 was the reference example). Goal: shrink implementation, keep features. Cross-spec ripple changes also applied to `CONVENTIONS.md`.

## Per-spec summary

| Spec | Effort before → after | Biggest single deletion |
|------|----------------------|-------------------------|
| 01 permission-system | 3-4 d → 1.5 d | Collapsed `src/permissions/` dir into `src/engine/permissions.ts`; deleted `formatToolSummary`, `PermissionRule`, MCP server-wide match |
| 02 git-integration | 4-5 d → 2 d | Deleted periodic `git_status_update` event + 5s poll; refresh only after mutating tools |
| 03 diff-display | 3 d → 1.5 d | Deleted `parseDiff` / `DiffHunk` / `DiffLine` — TUI colors by line prefix |
| 04 memory-system | 3 d → 1 d | Deleted `fs.watch` file watching, YAML frontmatter, `edit` operation |
| 05 undo-checkpoints | 4 d → 2 d | Deleted `/restore` command (redundant with `/undo <id>`) and the dual mutating/non-mutating pattern config |
| 06 session-resume | 3 d → 1.5 d | Deleted `session_resumed` event (folded into `ready`) and the `initBackend/runBackend` refactor |
| 07 sub-agents | 5 d → 2.5 d | Three sub-agent events (`started`/`progress`/`completed`) collapsed into one `sub_agent_event` |
| 08 persistent-loop | (reference) | (already simplified) |
| 09 image-input | 4 d → 1.5 d | Deleted PDF rasterization, downscaling, bare-filename auto-detect, imageRefs hash cache |
| 10 non-interactive | 4 d → 2 d | Collapsed `AgentLoopProgress` 5-variant union into a plain `onEvent` callback matching JSON-RPC events |
| 11 web-tools | 4 d → 2 d | v1 ships only Brave (SerpAPI / Ollama / DuckDuckGo deferred); disk cache deleted |
| 12 hooks-system | 4 d → 1.5 d | Deleted `before_any` / `after_any` / `on_error_<tool>` and the `hook_executed` event |
| 13 error-recovery | 5 d → 2 d | Deleted `src/recovery/` dir and `src/providers/retry.ts` — retry inlined into `callLLM`; partial save folded into `SessionStore` |
| 14 rate-limiting | 3-4 d → 2 d | Two new events (`rate_limit_status`, `rate_limit_throttled`) collapsed to `activity` reuse |
| 15 telemetry | 3 d → 1 d | v1 is local-only; deferred remote upload + `installationId` + batching + `consent_required` modal |
| 16 packaging | 6 d → 2.5 d | Deferred Node SEA standalone binary and self-update binary replace — npm + Homebrew + Docker only |
| 17 documentation | 5 d → 2.5 d | Deleted auto-doc-generation pipeline + drift CI; deleted `HelpSystem` class |
| 18 testing | 6 d → 3 d | Seven-row coverage matrix collapsed to one global threshold; deleted protocol-conformance test pipeline |

**Totals:** 71-75 days → 32 days (~57% reduction).

## Cross-spec ripple changes (CONVENTIONS.md)

- `src/permissions/` and `src/hooks/` directories removed; both became `src/engine/permissions.ts` and `src/engine/hooks.ts`.
- `src/recovery/` and `src/providers/retry.ts` removed; merged into existing `llm-caller.ts` and `session/store.ts`.
- `src/telemetry/` directory removed; became `src/audit/telemetry.ts` (sibling of existing `analytics.ts`).
- `src/cli/updater.ts` removed; inlined ~25 lines into `main.tsx`.
- `src/web/rate-limiter.ts` removed; reuses Spec 14's `TokenBucket`.
- `src/test-utils/mock-provider.ts` removed; covered by `mock-llm.ts`.
- Protocol event removals: `git_status_update`, `session_resumed`, `sub_agent_started`, `sub_agent_progress`, `sub_agent_completed`, `persist_status` (already gone), `hook_executed`, `consent_required`, `recovery`, `rate_limit_status`, `rate_limit_throttled`. Replaced where needed by reuse of existing `activity` / `status` / `ready` / `error` events, or by a single new event (`sub_agent_event`).
- `ready` event grew the `resumed`, `resumed_session_id`, `resumed_message_count` fields (Spec 06) on top of `git_info` (Spec 02).

## Specs that resisted further shrinking

None refused outright. Two earned a smaller-than-typical reduction:

- **Spec 18 (Testing)** — already valued pragmatism. Reductions were mostly the coverage matrix and dropped protocol-schema generation; the core test layers stayed.
- **Spec 16 (Packaging)** — three distribution channels (npm, Homebrew, Docker) plus a wizard is irreducible if you want to ship. Reduction came from deferring Node SEA + self-update.

## Features intentionally preserved

No user stories were dropped. Several features were scoped to v1 with explicit "deferred to v2" notes:

- Spec 09: PDF rasterization, image downscaling.
- Spec 11: SerpAPI / Ollama / DuckDuckGo backends, disk cache.
- Spec 15: Remote telemetry upload + installation IDs.
- Spec 16: Node SEA single-binary, self-update binary replace.
- Spec 17: Auto-generated docs.
