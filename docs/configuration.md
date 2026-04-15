# Configuration

All config lives under `.kondi-chat/` in your project, with some files under
`~/.kondi-chat/` for user-level defaults.

## `config.json`

Auto-created on first run from the wizard. Also updated whenever you switch
profiles with `/mode <name>` so the active profile persists across restarts.

```json
{
  "defaultProfile": "zai",
  "providers": ["anthropic", "openai", "zai"]
}
```

Startup precedence for the active profile:

1. If launched with `--resume <id>`, the resumed session's saved profile wins.
2. Otherwise, `defaultProfile` from this file is used.
3. Otherwise, `balanced` is the fallback.

`defaultProfile` accepts any profile name, not just the three built-ins — custom
profiles in `profiles/*.json` are valid targets.

## `profiles/*.json`

Built-in profiles (`balanced.json`, `quality.json`, `cheap.json`, `zai.json`) are
rewritten on every startup so the code stays authoritative. Custom profiles are
any other `.json` file in this directory and are never overwritten.

```json
{
  "name": "zai",
  "description": "Z.AI (GLM) models only — glm-5.1 plans, glm-4.6 codes, glm-4.5-flash compresses",
  "planningPreference": ["planning", "reasoning", "analysis"],
  "executionPreference": ["coding", "fast-coding", "general"],
  "reviewPreference":    ["analysis", "reasoning"],
  "contextBudget": 30000,
  "maxIterations": 20,
  "loopCostCap": 3.00,
  "loopIterationCap": 20,
  "promotionThreshold": 2,
  "includeReflection": true,
  "includeVerification": true,
  "preferLocal": false,
  "maxOutputTokens": 8192,
  "allowedProviders": ["zai"]
}
```

Field reference:

| Field | Purpose |
|---|---|
| `planningPreference` | Capability-tag preference list used by the rule-router for `discuss` / planning phases. `getBest(cap)` picks the most-capable match; `preferLocal: true` switches to `getCheapest(cap)`. |
| `executionPreference` | Same idea for execute phases. The first match wins. |
| `reviewPreference` | Reserved for review/critique phases. |
| `contextBudget` | **Token ceiling enforced by the in-loop compactor.** Tool results older than the last 2 iterations are progressively stubbed until the total message estimate fits under this. Also drives the cross-turn compaction threshold — `compactor.maybeCompact()` fires at `contextBudget × 1.2`. Not related to the model's native context window. |
| `maxIterations` / `loopIterationCap` | Hard stop on how many agent-loop iterations a single user turn can run before the LoopGuard calls it. |
| `loopCostCap` | Dollar cap per user turn. |
| `promotionThreshold` | After N consecutive failures, the router "promotes" to `getBest('coding')` instead of `getCheapest('coding')`. |
| `includeReflection` | Whether the loop runs a reflect phase after each execute. |
| `includeVerification` | Whether the loop runs a verify phase (tests, linters). |
| `preferLocal` | Rule-router selects `getCheapest` instead of `getBest`, and prefers Ollama models. |
| `maxOutputTokens` | Per-call output cap sent to every LLM request in this profile. |
| `allowedProviders` | **Optional provider allow-list.** When set, the rule router's scoped registry only considers models from these providers, AND the intent router filters candidates AND its classifier LLM the same way, AND the compactor uses a compression model from within the allow-list. This is how `zai` mode stays inside Z.AI end-to-end. |
| `rolePinning` | **Optional phase→model map.** When the router selects for a pinned phase, it returns that exact model ID and skips the NN/intent/rules tiers. Unpinned phases route normally. Keys are `LedgerPhase` strings (`discuss`, `dispatch`, `execute`, `verify`, `reflect`, `compress`, `state_update`, `consult`). Use this for multi-provider pipelines where you want deterministic role binding — e.g. `{"discuss": "gpt-5.4", "execute": "models/gemini-2.5-pro", "reflect": "glm-5.1"}`. If a pinned model ID is missing or disabled, routing falls through instead of failing. |

Example multi-provider pipeline profile (`profiles/orchestra.json`):

```json
{
  "name": "orchestra",
  "description": "Multi-provider role pipeline — GPT-5.4 plans and reflects, Gemini 2.5 Pro codes, GLM-5.1 reviews.",
  "planningPreference": ["planning", "reasoning", "analysis"],
  "executionPreference": ["coding", "fast-coding", "general"],
  "reviewPreference": ["code-review", "analysis", "reasoning"],
  "contextBudget": 40000,
  "maxIterations": 24,
  "loopCostCap": 5.00,
  "loopIterationCap": 24,
  "promotionThreshold": 2,
  "includeReflection": true,
  "includeVerification": true,
  "preferLocal": false,
  "maxOutputTokens": 8192,
  "allowedProviders": ["openai", "google", "zai"],
  "rolePinning": {
    "discuss":  "gpt-5.4",
    "dispatch": "gpt-5.4",
    "execute":  "models/gemini-2.5-pro",
    "reflect":  "glm-5.1",
    "compress": "glm-4.5-flash",
    "state_update": "glm-4.5-flash"
  }
}
```

Activate with `/mode orchestra`. The preference lists are still honored for any phase you don't explicitly pin; the `rolePinning` just intercepts pinned phases before the tier chain runs.

## `consultants.json`

Domain-expert personas the agent can call via the `consult` tool. Auto-created on first run with three defaults: `aerospace-engineer`, `security-auditor`, `database-architect`. Each entry is a standalone consultant definition:

```json
[
  {
    "role": "aerospace-engineer",
    "name": "Senior Aerospace Engineer",
    "description": "Review designs for flight-safety, fault tolerance, margins, certification.",
    "provider": "openai",
    "model": "gpt-5.4",
    "system": "You are a senior aerospace engineer with 30 years of experience...",
    "contextText": "Target platform: ARM Cortex-R52 triple-core lockstep. DO-178C DAL-B.",
    "contextFiles": ["specs/fmea.md", "specs/safety-case.md"],
    "maxOutputTokens": 2048
  }
]
```

Field reference:

| Field | Purpose |
|---|---|
| `role` | Machine id — what the agent passes in `consult({role: "..."})`. |
| `name` | Human-readable display name. |
| `description` | Shown to the agent so it can decide *when* to reach for this consultant. Keep concrete. |
| `provider` + `model` | Which LLM runs the persona. Can be any enabled model, regardless of the active profile's `allowedProviders` (consultants are explicit opt-in by the agent, so they're allowed to cross the profile fence). |
| `system` | The persona definition. This is where the expertise actually lives — model choice is secondary to a well-written system prompt. |
| `contextText` *(optional)* | Static baseline context baked into every call: project constraints, vocabulary, mission specs, stable decisions. Appended to the system prompt so it benefits from provider-side prompt caching. |
| `contextFiles` *(optional)* | Relative paths read from disk **lazily on each consultation** (not at startup), so edits to spec files show up in the next call without restarting. Capped per-file at `contextFileMaxBytes` (default 50,000) and in total at `contextTotalMaxBytes` (default 200,000). Paths are sandboxed to the working directory; `../` escapes are rejected. |
| `contextFileMaxBytes` / `contextTotalMaxBytes` | Override the defaults if you need to attach larger reference material. |
| `maxOutputTokens` | Default 2048. |

Consultants are **pure text-in/text-out**: they see the persona's system prompt (with persistent context baked in), the caller's question, and any per-call `context` arg — nothing else. They cannot read arbitrary files, run commands, or see the main session's history. If you need an expert that can use tools, use `spawn_agent` instead.

Consultations log to the audit ledger as `phase: 'consult'` with the role id in the prompt summary, so `/routing` and `/cost` attribute the spend correctly.

## `permissions.json`

## `permissions.json`

```json
{
  "defaultTier": "confirm",
  "tools": {
    "read_file": "auto-approve",
    "write_file": "confirm",
    "run_command": "confirm"
  },
  "alwaysConfirmPatterns": [
    "rm\\s+(-[rfR]+\\s+|--recursive)",
    "git\\s+push\\s+(-f|--force)",
    "sudo\\s+"
  ]
}
```

Tiers: `auto-approve`, `confirm`, `always-confirm` (cannot be auto-approved
from config).

Runtime decisions from the TUI permission dialog:

| Key | Decision | Scope |
|---|---|---|
| `y` / Enter | `approved` | This call only |
| `n` / Esc | `denied` | — |
| `a` | `approved-session` | Fingerprint-matched: same tool + same args remains auto-approved until session end |
| `t` | `approved-turn` | **Yolo.** Every confirm-tier call auto-approved until the assistant turn ends. Cleared automatically when the turn finishes. Does not bypass `always-confirm` tier — those still prompt every time |

`always-confirm` patterns are regex. Anything matching them (rm-rf, sudo,
force-push, pipe-to-shell, etc.) prompts every time and cannot be session-
approved or turn-approved.

## `hooks.json`

```json
{
  "hooks": {
    "after_write_file": "npx prettier --write {path}",
    "after_edit_file": ["npx prettier --write {path}", "npx eslint --fix {path}"]
  },
  "builtin": { "autoFormat": true },
  "defaultFailureMode": "warn",
  "defaultTimeoutMs": 15000
}
```

Variables: `{path}`, `{command}`, `{content}`, `{result}`, `{cwd}`.

## `rate-limits.json`

Per-provider RPM/TPM budgets. Auto-created on first run.

```json
{
  "limits": {
    "anthropic": { "rpm": 50, "tpm": 400000, "maxConcurrent": 10 },
    "openai":    { "rpm": 30, "tpm": 150000, "maxConcurrent": 10 }
  }
}
```

## `telemetry.json`

Opt-in local telemetry. Controlled via `/telemetry enable`/`disable`. No
network in v1.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` / `XAI_API_KEY` | Provider auth |
| `ZAI_API_KEY` | Z.AI (GLM) auth. Used against the Coding Plan endpoint `https://api.z.ai/api/coding/paas/v4`, not the general-purpose `/api/paas/v4` |
| `BRAVE_SEARCH_API_KEY` | Enables web_search / web_fetch (Spec 11) |
| `KONDI_CHAT_NO_TELEMETRY=1` | Forces telemetry off and deletes local data on load |
| `KONDI_NO_UPDATE_CHECK=1` | Skip the 24-hour update check |
| `KONDI_CONFIG_DIR` | Override `.kondi-chat/` location |
