# Profiles

A **profile** is a JSON document that controls:

- Which models the router can pick from (via `allowedProviders` and capability preferences)
- Which models specific phases prefer (via `rolePinning`)
- How much context, how many iterations, and how much money a single turn can spend (via `contextBudget`, `loopIterationCap`, `loopCostCap`)
- Whether to run reflection and verification passes
- How big each LLM response can be (`maxOutputTokens`)

Switch profiles with `/mode <name>` at any time. The active profile persists across restarts in `.kondi-chat/config.json`.

## Built-in profiles

| Profile | Use case | Iters | Cost cap | Models |
|---|---|---|---|---|
| `balanced` | Everyday coding and chat (default) | 20 | $3.00 | Whichever providers you have keys for |
| `quality` | Architecture, hard problems, deep reasoning | 30 | $10.00 | Frontier preferred (Opus, GPT-5.4) |
| `cheap` | High-volume exploration, quick answers | 8 | $0.75 | Cheapest available; `preferLocal: true` |
| `zai` | Z.AI Coding Plan only (free GLM-4.5-flash compression) | 20 | $3.00 | `allowedProviders: ['zai']` |
| `best-value` | Multi-provider, router chooses per phase | 24 | $5.00 | Sonnet + GPT-5.4 + Gemini 2.5 Pro + GLM-4.5-flash |
| `orchestra` | Deterministic multi-provider pipeline | 24 | $5.00 | GPT-5.4 plans, Gemini codes, GLM-5.1 reviews |

`balanced`, `quality`, `cheap`, and `zai` live in `src/router/profiles.ts` and are re-written to `.kondi-chat/profiles/*.json` on every startup. `best-value` and `orchestra` are shipped as JSON in `.kondi-chat/profiles/` and treated as user-editable.

You can drop any other `.json` file in `.kondi-chat/profiles/` (or `~/.kondi-chat/profiles/` for project-wide availability) and it's loaded as a custom profile.

## Anatomy of a profile

```json
{
  "name": "my-profile",
  "description": "Tight cap, all coding work on DeepSeek, planning on Claude.",
  "planningPreference": ["planning", "reasoning"],
  "executionPreference": ["coding", "fast-coding"],
  "reviewPreference":    ["code-review", "analysis"],
  "contextBudget": 30000,
  "maxIterations": 20,
  "loopCostCap": 3.00,
  "loopIterationCap": 20,
  "promotionThreshold": 2,
  "includeReflection": true,
  "includeVerification": true,
  "preferLocal": false,
  "maxOutputTokens": 8192,
  "allowedProviders": ["anthropic", "deepseek"],
  "rolePinning": {
    "discuss":      "claude-sonnet-4-5-20250929",
    "execute":      "deepseek-chat",
    "compress":     "claude-haiku-4-5-20251001"
  }
}
```

### `rolePinning`

A soft preference map from `LedgerPhase` → model ID. Keys: `discuss`, `dispatch`, `execute`, `verify`, `reflect`, `compress`, `state_update`, `consult`.

Pins are **fallbacks after the intent router**, not hard overrides. The intent classifier sees the pinned model in its candidate list and may pick a different one when warranted — for example, the profile pins `dispatch: gpt-5.4` but Opus is also enabled, and for a complex plan the classifier upgrades to Opus. The pin fires unconditionally only if the intent tier returns nothing (classifier error, no candidates after filtering, or a hallucinated model ID).

When `rolePinning` is set, the intent classifier sees exactly the unique models in the pin values plus anything enabled by capability preferences — not the entire registry. This keeps the classifier prompt focused and cheap.

If a pinned model ID isn't enabled or doesn't exist in the registry, routing skips the pin and falls through to the rule tier.

See [routing.md](routing.md) for the full tier chain.

### `allowedProviders`

A hard provider allow-list. When set, every tier of routing is filtered to models from these providers:

- The rule tier's scoped registry only considers them
- The intent classifier's candidate list is filtered to them
- The classifier LLM itself is picked from within them (so `zai` mode's classifier runs on Z.AI, not Anthropic)
- The cross-turn compactor picks a compression model from within them

Use this to guarantee that a session never crosses a provider boundary — for cost, sovereignty, or privacy reasons.

### Cost and iteration caps

| Field | What it caps | When it fires |
|---|---|---|
| `loopIterationCap` | Number of agent-loop iterations per user turn | LoopGuard aborts at the cap |
| `loopCostCap` | USD per user turn | LoopGuard aborts at the cap |
| `contextBudget` | Token estimate of the message list | In-loop compactor stubs old tool results to fit under |
| (compaction) | Cross-turn full message rewrite | Fires automatically at `contextBudget × 1.2` |
| `maxOutputTokens` | Max response size per LLM call | Sent as the API limit |

Cost is tracked by the audit ledger (`src/audit/ledger.ts`) using per-model `$/M input` and `$/M output` from the registry, with separate accounting for cached-token discounts on Anthropic / OpenAI / Z.AI. Run `/cost` to see the breakdown for the current session.

### Capability preferences (the fallback tier)

`planningPreference`, `executionPreference`, and `reviewPreference` are ordered lists of capability tags. They're only consulted by the rule tier (tier 3) when both the NN and intent tiers fall through.

Tag matching is first-wins: the rule tier walks the list and picks the first capability that resolves to at least one enabled model. With `preferLocal: false` it picks `getBest(cap)`; with `preferLocal: true` it picks `getCheapest(cap)`.

Capability tags are defined per model in `src/router/registry.ts`. Common ones: `coding`, `fast-coding`, `planning`, `reasoning`, `architecture`, `code-review`, `analysis`, `general`, `refactoring`.

### `promotionThreshold`

After N consecutive failures on a phase, the rule tier "promotes" the model selection from `getCheapest` to `getBest` for that capability. Useful in `cheap` mode where the first pick may not be strong enough for the task.

### `includeReflection` and `includeVerification`

Toggle whether the agent loop runs a reflection pass (post-execute model review) and a verification pass (local tests/lint). The `cheap` profile turns reflection off to save iterations.

### `preferLocal`

When true, the rule tier picks `getCheapest` instead of `getBest` for every capability, and prefers Ollama models when available. Set on `cheap`.

## Examples

### A truly minimal profile

Only specifies the bits that differ from the defaults; everything else falls back to `balanced`-style values via `getProfile()`.

```json
{
  "name": "ultra-cheap",
  "description": "Hard cap, fast iteration.",
  "executionPreference": ["fast-coding"],
  "loopCostCap": 0.30,
  "loopIterationCap": 5,
  "maxOutputTokens": 2048
}
```

### Single-provider lock-in

```json
{
  "name": "deepseek-only",
  "description": "Everything on DeepSeek V3.",
  "executionPreference": ["coding"],
  "planningPreference": ["reasoning", "coding"],
  "reviewPreference":    ["code-review", "analysis"],
  "contextBudget": 30000,
  "loopCostCap": 1.00,
  "loopIterationCap": 20,
  "maxOutputTokens": 8192,
  "allowedProviders": ["deepseek"]
}
```

Save as `.kondi-chat/profiles/deepseek-only.json`, run `/mode deepseek-only`.

### Multi-provider orchestra

```json
{
  "name": "my-orchestra",
  "description": "Plan with Claude, code on DeepSeek, review on GLM.",
  "contextBudget": 40000,
  "loopCostCap": 3.00,
  "loopIterationCap": 20,
  "maxOutputTokens": 8192,
  "allowedProviders": ["anthropic", "deepseek", "zai"],
  "rolePinning": {
    "discuss":      "claude-sonnet-4-5-20250929",
    "dispatch":     "claude-sonnet-4-5-20250929",
    "execute":      "deepseek-chat",
    "reflect":      "glm-5.1",
    "compress":     "glm-4.5-flash"
  }
}
```

### Free-tier-only

If you have Gemini and Z.AI Coding Plan keys, this profile spends nothing per call.

```json
{
  "name": "free",
  "description": "Gemini 2.5 Pro (free) for everything, GLM-flash (free) for compression.",
  "contextBudget": 30000,
  "loopCostCap": 0.10,
  "loopIterationCap": 15,
  "maxOutputTokens": 8192,
  "allowedProviders": ["google", "zai"],
  "rolePinning": {
    "discuss":      "models/gemini-2.5-pro",
    "dispatch":     "models/gemini-2.5-pro",
    "execute":      "models/gemini-2.5-pro",
    "reflect":      "models/gemini-2.5-pro",
    "compress":     "glm-4.5-flash"
  }
}
```

## See also

- [routing.md](routing.md) — the three-tier router that consumes these profiles
- [configuration.md](configuration.md) — every other config file kondi-chat reads
- `src/router/profiles.ts` — the source of truth for built-in profiles and field defaults
- `src/router/registry.ts` — model IDs and capability tags you can reference in `rolePinning` / `executionPreference`
