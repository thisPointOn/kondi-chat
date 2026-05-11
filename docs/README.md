# kondi-chat docs

Start here if you're new. Each page is self-contained and roughly 5 minutes to read.

## Get going

- [**Getting started**](getting-started.md) — install, set keys, run your first session.
- [**Configuration**](configuration.md) — every config file under `.kondi-chat/`, every environment variable, every permission tier.

## The core idea

- [**Routing**](routing.md) — how kondi-chat picks a model per phase. The three tiers (NN → intent classifier → rule fallback), what `/routing` shows you, and how to debug a wrong pick.
- [**Profiles**](profiles.md) — built-in profiles (`balanced` / `cheap` / `quality` / `zai` / `best-value` / `orchestra`), how `rolePinning` and `allowedProviders` interact, and how to write your own.

## Reference

- [**JSON-RPC API**](api.md) — protocol between the Rust TUI and the Node backend. Use this to build a custom frontend.

## Quick lookup

| If you want to… | See |
|---|---|
| Install on macOS/Linux/Windows | [getting-started.md](getting-started.md#install) |
| Run without paying for API calls | [getting-started.md](getting-started.md#free-tier-path) |
| Understand `/routing` output | [routing.md](routing.md#reading-the-routing-output) |
| Pin a phase to a specific model | [profiles.md](profiles.md#rolepinning) |
| Restrict a profile to one provider | [profiles.md](profiles.md#allowedproviders) |
| Tune permission prompts | [configuration.md](configuration.md#permissionsjson) |
| Add a pre/post tool hook | [configuration.md](configuration.md#hooksjson) |
| Cap per-turn cost | [profiles.md](profiles.md#cost-and-iteration-caps) |
| Use a non-interactive script | [getting-started.md](getting-started.md#non-interactive) |
| Resume a prior session | [getting-started.md](getting-started.md#resume) |

## In-TUI help

Most pages have an in-TUI counterpart via `/help <topic>`. Useful topics:

```
/help intent-router    routing.md
/help compression      configuration.md (contextBudget)
/help permissions      configuration.md (permissions.json)
/help /mode            profiles.md
/help consultants      configuration.md (consultants.json)
/help shortcuts        getting-started.md (keys)
/help mentions         routing.md (@model overrides)
/help type-ahead       (TUI behavior)
/help caching          (provider prompt-cache notes)
/help reasoning-models (R1, o-series, GLM-5.x, extended thinking)
```

## Design specs (internal)

The `specs/` directory at the repo root holds 18 numbered design specs (permission system, memory, sub-agents, …) plus `CONVENTIONS.md`, `IMPLEMENTATION-LOG.md`, and the `CONTEXT_EFFICIENCY_PLAN`. These describe how features were designed and implemented — useful if you're hacking on kondi-chat itself, not necessary for using it.
