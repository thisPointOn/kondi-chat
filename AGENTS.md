# AGENTS.md — kondi-chat

Universal agent guidance for any AI coding tool working on this repo.

## Project

Terminal coding agent that picks a different model per phase. The wedge is
**multi-provider per-phase routing under explicit cost caps** — not IDE
integration (don't have it), not a fine-tuned model (don't have one), not
Cursor parity (not chasing it). See `ROADMAP.md` for what's in/out of scope.

TypeScript backend (~14k LOC, src/) + Rust TUI (~5.9k LOC, tui/), talking
JSON-RPC over stdio. 107 tests (vitest).

## Build & test

```bash
npm install                              # install deps + download TUI binary
npm run typecheck                        # tsc --noEmit
npm test                                 # vitest run (104 tests)
cd tui && cargo build --release && cd .. # build Rust TUI from source
npm run chat:tui                         # run the TUI
```

All three checks (typecheck, test, cargo build) must pass before committing.

## Code layout

```
src/cli/
  backend.ts          — startup wiring, stdin loop, signal handlers
  submit.ts           — agent submit handler (the main agent loop)
  submit-helpers.ts   — pure functions: compaction, phase classification
  commands.ts         — slash command dispatcher (/mode, /use, /cost, etc.)
  wizard.ts           — first-run setup, profile persistence
  help.ts             — /help topic database

src/engine/
  tools.ts            — agent tool definitions + executor dispatch
  pipeline.ts         — dispatch → execute → verify → reflect pipeline
  consultants.ts      — domain-expert persona system
  errors.ts           — KondiError / PipelineError / ToolError / LlmCallError
  permissions.ts      — tool permission gate (auto-approve / confirm / always-confirm)
  checkpoints.ts      — pre-mutation file snapshots for /undo
  loop-guard.ts       — iteration / cost / stuck-detection bounds

src/providers/
  llm-caller.ts       — HTTP calls to Anthropic, OpenAI-compat, Gemini (no SDKs)
  rate-limiter.ts     — per-provider RPM/TPM budgets

src/router/
  index.ts            — unified router: NN → intent → pin fallback → rules
  intent-router.ts    — LLM-based classifier with phase context
  nn-router.ts        — learned classifier trained on accumulated samples
  rules.ts            — deterministic phase/task-kind heuristics
  profiles.ts         — budget profile management (rolePinning, allowedProviders)
  registry.ts         — model catalog (capabilities, cost, context window)
  collector.ts        — routing sample collector + /routing dashboard

src/context/
  manager.ts          — conversation context assembly + auto-compaction
  memory.ts           — KONDI.md + AGENTS.md loading
  budget.ts           — token estimation

src/audit/
  ledger.ts           — append-only per-call cost/token log
  analytics.ts        — usage analytics
  telemetry.ts        — opt-in local telemetry

src/mcp/              — MCP client + tool manager
src/council/          — multi-model deliberation profiles + executor

tui/src/
  main.rs             — Rust TUI entry point, event loop, keybindings
  app.rs              — App state, message handling, renderers
  ui.rs               — draw functions, suggestions, detail views
  protocol.rs         — BackendEvent / TuiCommand JSON-RPC types
```

## Conventions

- TypeScript: ESM (`"type": "module"`), `.ts` extensions in imports
- No default exports. Named exports only.
- Types in `src/types.ts` for cross-module types; local types co-located
- Async I/O preferred (`fs/promises`); sync OK in startup paths
- Errors: use `KondiError` subclasses at module boundaries; `{ isError: true }` for tool results the model should see
- Tool executors return `Promise<ToolExecutionResult>` — content string + optional isError + optional diff
- No `console.log` in the backend — use `emit()` for TUI events, `process.stderr.write` for debug
- Rust: stable toolchain, ratatui 0.29, crossterm 0.28

## Testing

- Framework: vitest
- Run: `npm test` or `npx vitest run`
- Test files: `src/**/*.test.ts`
- 107 tests covering router, context, tools, providers, verify, diff, permissions
- No mocking of LLM calls — tests exercise local logic only
- `PermissionManager` accepts an optional `userConfigPath` so tests don't pick up the developer's `~/.kondi-chat/permissions.json`

## Profile system

Budget profiles in `.kondi-chat/profiles/*.json` control routing, cost
caps, and model selection. Key fields:
- `rolePinning`: soft phase→model preferences (router picks first, pin is fallback)
- `allowedProviders`: restricts routing to listed providers end-to-end
- `contextBudget`: token ceiling for adaptive in-loop compaction

## Do not

- Do not add `console.log` to backend paths (breaks JSON-RPC protocol)
- Do not use `execSync` for tool calls that could be async
- Do not hardcode model IDs outside of registry.ts defaults
- Do not bypass the permission system for tool calls
- Do not weaken `hasShellChainOperator` or the `--auto-approve run_command` chain re-check in `cli/backend.ts` — that pair closes the shell-injection gap that was the launch blocker
- Do not write to AGENTS.md programmatically (hand-authored convention)
- Do not add IDE-integration features, LSP servers, or VSCode extensions — explicit non-goal (see ROADMAP.md)
