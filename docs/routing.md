# Routing

The thesis of kondi-chat is that **the right model depends on the phase**. Planning a refactor is not the same job as writing the diff, which is not the same job as reviewing it, which is not the same job as compressing old tool output to fit in context. Most coding agents pin one model to all of it; kondi-chat picks per phase.

This page explains how that pick happens, how to read the router's output, and how to debug a wrong pick.

## Phases

Every LLM call in kondi-chat is tagged with a **phase** before the router runs. The phase is what tells the router what kind of model the call needs.

| Phase | Triggered by | Typical fit |
|---|---|---|
| `discuss` | Conversational turns, plain Q&A | A capable general model — Sonnet, GPT-5.4 |
| `dispatch` | The agent calls `create_task` to scope a multi-step task | Strong reasoning / planning |
| `execute` | Inside the agent loop, picking the model for the next iteration's tool calls | Coding-tuned (Gemini 2.5 Pro, DeepSeek V3, GLM-4.6) |
| `reflect` | Post-execute review of what just happened | Code review (Sonnet, GLM-5.1) |
| `verify` | Local tools only (tests, lint) | No LLM call |
| `compress` | Cross-turn context summarization fires at `contextBudget × 1.2` | Cheap and fast (GLM-4.5-flash, Haiku) |
| `state_update` | Background memory / plan updates | Cheap and fast |
| `consult` | Agent calls `consult({role})` for a domain expert | Whatever the consultant's `model` field says (bypasses normal routing) |

`/help intent-router` in the TUI shows a slightly terser version of this.

## The three tiers

For every routable call, the router walks three tiers in order. The first tier that returns a model wins.

```
       ┌──────────────────────────────────────────┐
       │  1. NN Router                             │
       │     Trained classifier, ~5ms, no LLM.    │
       │     Falls through until ≥100 samples     │
       │     across ≥2 models or confidence low.  │
       └──────────────────────────────────────────┘
                          ↓ fallthrough
       ┌──────────────────────────────────────────┐
       │  2. Intent Router (primary)               │
       │     Cheap LLM (default Haiku, configurable│
       │     per profile) reads each enabled       │
       │     model's description + capabilities    │
       │     and picks the best fit.               │
       └──────────────────────────────────────────┘
                          ↓ fallthrough
       ┌──────────────────────────────────────────┐
       │  3. Rule Router                           │
       │     Static phase→capability map. Picks    │
       │     `getBest(cap)` or `getCheapest(cap)`  │
       │     depending on `preferLocal`.           │
       └──────────────────────────────────────────┘
```

The intent tier is doing most of the real work in practice. The NN tier exists so that, after enough use, routing becomes a free local classifier instead of a $0.0003 LLM call. The rule tier is the safety net.

### When a profile pins a phase

If the active profile sets `rolePinning` for the current phase and the pinned model is enabled, the pin acts as a **fallback after the intent router**, not a hard override. The intent router still gets first shot — it sees the pinned model in its candidate list along with any other comparable enabled models, and can pick a different one when the task complexity warrants it (e.g. the profile pins `dispatch: gpt-5.4` but Opus is also enabled — for a truly hard plan, the classifier may pick Opus).

The pin only fires unconditionally if the intent classifier errors out or hallucinates a model ID that isn't in the registry.

### When a profile sets `allowedProviders`

This is a hard fence. Every tier — NN, intent, rules, and the intent classifier LLM itself — is filtered to models from those providers. The `zai` profile uses this so a session is guaranteed to stay inside Z.AI end to end.

## `@mention` and `/use` overrides

Routing can be bypassed two ways:

- **`@alias message`** — pins the next turn to that model. Autocomplete pops when `@` is typed at the start of input. Prefix matching: `@gemi` picks `@gemini` if unambiguous.
- **`/use <alias>`** — pins all subsequent turns until `/use auto` is called.

These bypass tiers 1–3 entirely and emit a `route_reason: 'override'` event.

## Reading the routing output

Every turn prints a one-line summary as part of the activity stream:

```
router: phase=execute (coding intent detected)
→ glm-4.6 (intent: coding)
```

- `phase=execute` — what phase the call was tagged with
- `(coding intent detected)` — task-kind classification (coding vs. chat)
- `→ glm-4.6` — the model that was picked
- `(intent: coding)` — which tier picked it. Possible values:
  - `intent: <reason>` — tier 2 chose, reason from the classifier
  - `nn: <conf>` — tier 1 chose with `conf` confidence
  - `rule: <cap>` — tier 3 fallback, capability that matched
  - `pin: <phase>` — profile pin fired (intent tier failed or returned nothing)
  - `override` — user-supplied `@alias` or `/use`

## `/routing` — the diagnostic command

Type `/routing` in the TUI for a full breakdown of how the router has been deciding in this session:

```
/routing

  tier distribution:
    intent  43  (78%)   nn  0  (0%)   rules  12  (22%)

  by phase:
    discuss  → claude-sonnet-4-5  (12)
    dispatch → gpt-5.4            (8)
    execute  → models/gemini-2.5-pro (24)
    reflect  → claude-sonnet-4-5  (8)
    compress → glm-4.5-flash      (12)

  model success rate (last 100):
    claude-sonnet-4-5     20/20  100%   $0.42
    gpt-5.4               8/8    100%   $0.18
    models/gemini-2.5-pro 23/24   95%   $0.00 (free tier)
    glm-4.5-flash         12/12  100%   $0.00

  NN training: 55 samples / 100 required (need ≥2 models with ≥10 samples each)
```

If routing isn't matching your expectations, this is the first place to look:

- **NN at 0% after long use** → not enough samples per model. Need ≥2 models with ≥10 samples each before the NN engages.
- **Intent at low %** → the intent classifier is erroring out (wrong API key, model not enabled). Check `/help intent-router`.
- **Rules dominating** → your profile's capability tags don't match what's in the registry, so the intent classifier is finding nothing to pick from. Re-check `executionPreference` against `src/router/registry.ts` capability strings.

## Debugging a specific bad pick

1. Run `/routing` — confirm the tier and reason for the bad pick.
2. If `intent: …` and the wrong model: the classifier made a bad call. Check whether the candidate model descriptions in the registry actually distinguish them — vague descriptions produce vague picks.
3. If `rule: …` and the wrong model: tier 2 fell through, so the intent classifier errored. Look at the activity stream for the error.
4. If `pin: …` and the wrong model: your `rolePinning` is wrong, or the intent tier produced no candidates (allowedProviders + capability filter wiped them all out).
5. Worst case: pin the model you want with `/use <alias>` and file a routing issue with the `/routing` output attached.

## See also

- [profiles.md](profiles.md) — how `rolePinning`, `allowedProviders`, and capability preferences interact
- [configuration.md](configuration.md#profilesjson) — every profile field
- `/help intent-router` in the TUI
- `src/router/intent-router.ts` and `src/router/rules.ts` for the implementation
