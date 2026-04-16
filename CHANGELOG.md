# Changelog

All notable changes to kondi-chat will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
