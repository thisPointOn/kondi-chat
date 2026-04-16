# kondi-chat

**A multi-provider terminal coding agent with a learned, cost-aware router.**

Not another wrapper that asks you to pick a model. kondi-chat's intent router reads every model in your profile, understands what each phase needs, and picks the right one — *GPT-5.4 for planning, Gemini 2.5 Pro for coding, Sonnet for review* — informed by what happened in prior phases, under an explicit cost cap. The more you use it, the better it routes.

<!-- Demo GIF goes here once recorded (vhs tape in scripts/demo.tape) -->

## What makes it different

- **Context-aware multi-model router.** The intent router reads every model's description and capabilities, sees what happened in prior pipeline phases ("Gemini just wrote the code, tests passed, now pick a reviewer"), and selects the best model for each step. It's not a lookup table — it's an LLM making an informed per-step decision, scoped to the models your profile declares. A learned NN tier trains on your accumulated usage and takes over for phases it's confident about. Profile pins serve as fallbacks, not overrides — the router gets first shot at an intelligent pick.

- **Multi-provider pipelines.** A profile declares which models are available and (optionally) which it prefers per phase. The `best-value` profile gives the router Opus, GPT-5.4, Sonnet, Gemini 2.5 Pro, and GLM-4.5-flash — the router chooses between comparable models (Opus vs. GPT-5.4 for planning) based on task complexity and cost. When the agent dispatches a task via `create_task`, the pipeline streams each phase's model choice live into the TUI — no opaque "thinking…" blocks.

- **Explicit cost caps.** Every profile declares `contextBudget`, `loopIterationCap`, and `loopCostCap`. The agent loop adaptively stubs old tool results to stay under the context ceiling — no LLM call, just local string rewriting. Cross-turn compaction uses a profile-scoped cheap model (free `glm-4.5-flash` on Z.AI's Coding Plan). Cached-token discounts are tracked separately in the ledger for Anthropic, OpenAI, and Z.AI.

- **Domain consultants and multi-model deliberation.** Consultants are file-configurable expert personas (aerospace engineer, security auditor, database architect) with lazy-loaded persistent context; the agent calls them via the `consult` tool when a problem has a domain angle. `/council run <profile>` kicks off a structured multi-round debate among frontier models for decisions that matter more than one model can decide alone.

- **Terminal UX without the gymnastics.** Rust TUI rendering into an inline viewport, so content lands in your terminal's native scrollback. Wheel scroll, drag-to-select, and copy all work like they do in `cat` or `less` — no alternate-screen capture, no escape-sequence fights with tmux.

## Not a Cursor replacement

kondi-chat does not integrate with an IDE. It runs in a terminal pane next to whatever editor you already use. The closest comparable is [Aider](https://github.com/Aider-AI/aider) — more mature, larger community, simpler install. kondi-chat bets on three different things than Aider: routing as the core abstraction, declarative multi-provider pipelines, and first-class cost control. If those differences don't matter to you, Aider is the right tool.

## Install

```bash
# One command (requires Node 18+). The postinstall script downloads
# a prebuilt Rust TUI binary for your platform automatically.
npm install -g kondi-chat
```

No Rust toolchain needed. The TUI binary is downloaded from the
GitHub release matching your package version. Supported platforms:
Linux x64/arm64, macOS x64/arm64, Windows x64.

```bash
# From source (if you want to hack on it)
git clone https://github.com/thisPointOn/kondi-chat.git
cd kondi-chat
npm install                              # also runs postinstall
cd tui && cargo build --release && cd .. # optional: build TUI from source
```

## Quick start

1. Set at least one API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-proj-...
# or both, plus any others you have
```

2. Run:

```bash
kondi-chat
```

3. Chat:

```
> Explain this codebase
> Write a Python script that parses CSV files and outputs JSON
> @opus Plan a refactor of the auth module
> @deep Write the implementation
```

## Features

### Multi-model routing

Every message is classified (coding task vs discussion) and routed to the best available model based on your active budget profile. The router has three tiers, evaluated in order:

1. **NN Router** — fast, trained on your accumulated usage data. Runs automatically once you have ≥100 samples across ≥2 models. Falls through if not yet trained or low-confidence.
2. **Intent Router** — *the primary tier.* An LLM reads every enabled model's description + capabilities and classifies which one best fits the current task. Scoped to the active profile's `allowedProviders` (so `zai` mode never escapes to Claude). Uses a cheap classifier model chosen from the in-profile registry (e.g. `glm-4.5-flash` — free — in zai mode).
3. **Rule Router** — minimal phase/task-kind fallback. Only runs if the intent tier fails or produces no candidate.

You see the routing decision on every turn:

```
router: phase=execute (coding intent detected)
→ glm-4.6 (intent: coding)
```

Run `/routing` at any time to see the tier distribution (intent/nn/rules), per-model success rates and cost, model×tier matrix, NN training readiness, and per-phase breakdown. This is the tool for verifying that routing is actually hitting the intent tier as expected.

### Budget profiles

| Mode | Use case | Iteration cap | Cost cap |
|------|----------|--------------|----------|
| `quality` | Complex architecture, frontier reasoning | 30 | $10.00 |
| `balanced` | Everyday coding and chat (default) | 20 | $3.00 |
| `cheap` | Quick lookups, high-volume exploration | 8 | $0.75 |
| `zai` | Z.AI (GLM) Coding Plan — glm-5.1 plans, glm-4.6 codes, glm-4.5-flash compresses (free) | 20 | $3.00 |

Switch at any time: `/mode quality`. The active profile is persisted to `.kondi-chat/config.json` so it survives restarts.

**Provider scoping.** A profile can restrict routing to a subset of providers by setting `allowedProviders`. When set, the intent router, rule router, cross-turn compactor, and intent classifier LLM all stay inside that allow-list — nothing leaks out. See the `zai` profile for an example.

Create custom profiles by adding JSON files to `.kondi-chat/profiles/`:

```json
{
  "name": "my-profile",
  "description": "Custom workflow",
  "executionPreference": ["coding", "fast-coding"],
  "planningPreference": ["reasoning", "planning"],
  "loopIterationCap": 15,
  "loopCostCap": 5.00,
  "contextBudget": 40000,
  "maxOutputTokens": 8192,
  "allowedProviders": ["anthropic", "openai"]
}
```

`contextBudget` is also the ceiling the compactor enforces. Inside an agent loop, old tool results are progressively stubbed to stay under it — no LLM calls, just local string rewriting. Between turns, cross-turn compaction fires at `contextBudget × 1.2` and summarizes older messages using the profile-scoped compression model (glm-4.5-flash in zai mode, claude-haiku in unrestricted profiles). See `/help compression` and `/help intent-router`.

#### Multi-provider pipelines and model preferences

A profile declares which models are available via `rolePinning` and the router intelligently selects among them per phase. Pins are **soft preferences with fallback semantics**, not hard overrides — the intent router gets first shot at picking the best model for each step (informed by phase context, model descriptions, and cost), and the pin only fires if the router produces no result.

The `best-value` profile demonstrates the design:

```json
{
  "name": "best-value",
  "allowedProviders": ["anthropic", "openai", "google", "zai"],
  "rolePinning": {
    "discuss":      "claude-sonnet-4-5-20250929",
    "dispatch":     "gpt-5.4",
    "execute":      "models/gemini-2.5-pro",
    "reflect":      "claude-sonnet-4-5-20250929",
    "compress":     "glm-4.5-flash",
    "state_update": "glm-4.5-flash"
  }
}
```

The classifier sees exactly these 5 models (Sonnet, GPT-5.4, Gemini Pro, GLM-flash — plus Opus which is also enabled in the registry). For the `dispatch` phase, the profile suggests GPT-5.4 — but the classifier also sees Opus and can choose it when the task is genuinely complex enough to justify the 6× price premium. For simpler planning calls, GPT-5.4 wins on cost. The router makes that call per turn, not per session.

The pipeline passes context between phases so the classifier makes informed decisions: *"Gemini just wrote the code, tests passed, now pick a reviewer — and don't pick the same model that wrote the code."* The phase descriptions are baked into the prompt so the classifier understands what `reflect` means (code review, catch bugs) vs. `dispatch` (architecture, planning, task decomposition).

Two bundled profiles use this:
- **`best-value`** — Sonnet + GPT-5.4 for chat/planning, Gemini Pro for coding (free), Sonnet for review, GLM-flash for compression (free). The router chooses between comparable models based on task complexity.
- **`orchestra`** — deterministic pipeline: GPT-5.4 plans, Gemini codes, GLM-5.1 reviews. More rigid, for workflows where you want explicit role binding.

Activate with `/mode best-value` or `/mode orchestra`.

### Agent tools

The agent has access to:

| Tool | Description |
|------|-------------|
| `read_file` | Read files from the project |
| `write_file` | Create or overwrite files |
| `edit_file` | Search/replace edits with diff output |
| `list_files` | List directory contents |
| `search_code` | Grep for patterns across the codebase |
| `run_command` | Execute shell commands |
| `create_task` | Dispatch multi-phase coding tasks (routes each phase to a profile-appropriate model) |
| `consult` | Ask a domain-expert consultant for an opinion — see the Consultants section |
| `update_plan` | Update the session goal and plan |
| `update_memory` | Write to KONDI.md memory files |
| `git_status` | View git repository state |
| `git_commit` | Create git commits |
| `git_diff` | View diffs |
| `web_search` | Search the web (requires Brave API key) |
| `web_fetch` | Fetch and extract web page content |
| `spawn_agent` | Spawn sub-agents for parallel work |

### Council deliberation

For decisions that matter, run a multi-model council explicitly:

```
/council run architecture "Should we use microservices or a monolith for this project?"
```

Multiple models debate the question across several rounds, with a manager model synthesizing the final recommendation. Profiles control which models participate, how many rounds, and the debate format.

**Councils are explicit-only.** The agent cannot auto-invoke a council — `COUNCIL_TOOL` is deliberately **not** registered in the agent toolset. Councils are expensive (fan out across frontier models for multiple rounds) and blocking (synchronous subprocess) so they only run when the user types `/council` themselves.

### Domain-expert consultants

The agent can call on domain experts via the `consult` tool when it decides a problem benefits from a specialized perspective. Defaults ship with:

- **aerospace-engineer** — flight safety, fault tolerance, margins, certification
- **security-auditor** — OWASP top-10, authn/authz, input validation, crypto misuse
- **database-architect** — indexes, query plans, migration safety, isolation levels

Consultants are defined in `.kondi-chat/consultants.json` (auto-created on first run with the defaults above). Each entry:

```json
{
  "role": "ml-researcher",
  "name": "ML Research Scientist",
  "description": "Review experimental designs, loss functions, evaluation protocols, distribution shift, and reproducibility.",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",
  "system": "You are an ML research scientist. When reviewing an experimental design, think about: sample size and power, evaluation leakage, distribution shift between train and deploy, ablation coverage, baseline fairness, reproducibility (seeds, data provenance, code), and what conclusion the reported results actually support vs. what is being claimed. Be blunt about overclaiming.",
  "contextText": "Project is a recommender system for a mid-size e-commerce site. Eval is offline NDCG@10 against a 30-day holdout. Production serves 1M users/day.",
  "contextFiles": ["docs/eval-protocol.md", "docs/data-splits.md"],
  "maxOutputTokens": 2048
}
```

**Field reference:**

| Field | Purpose |
|---|---|
| `role` | Machine id — what the agent passes in `consult({role: "..."})`. |
| `name` | Human-readable display name. |
| `description` | Shown to the agent so it can decide *when* to reach for this consultant. Keep it concrete — "review for flight safety and fault tolerance" beats "do engineering review." |
| `provider` + `model` | Which LLM runs the persona. Can be any enabled model, regardless of the active profile's `allowedProviders`. |
| `system` | The persona definition — this is where the actual expertise lives. |
| `contextText` *(optional)* | Static baseline context baked into every call: mission specs, target platform, stable constraints, vocabulary. |
| `contextFiles` *(optional)* | Relative paths read from disk **lazily on each call** (not at startup), so edits to spec files show up in the next consultation without restarting. Capped per-file at 50KB and 200KB total by default — override with `contextFileMaxBytes` / `contextTotalMaxBytes` if you need more. Paths are sandboxed to the working directory; `../` escapes are rejected. |
| `maxOutputTokens` *(optional)* | Default 2048. |

The agent decides *when* to consult. Consultants are **pure text-in / text-out** — they see only the question (plus any caller-supplied `context` arg, plus the consultant's own `contextText` + `contextFiles`), not the session history, and they cannot call any tools themselves. If you need an expert that can actually read arbitrary files or run commands, use `spawn_agent` instead.

Consultations log to the ledger as `phase: consult` with the role in the reason field, so `/routing` and `/cost` attribute the spend to the consultant that did the work. Run `/consultants` in the TUI to see the roster, including a preview of each consultant's baseline context and attached files.

### Autonomous loop mode

Run the agent against a goal until it explicitly reports completion or hits the profile's iteration/cost caps:

```
/loop fix all the failing tests and commit when green
/loop find every TODO in src/ and resolve them
```

Unlike a regular turn — which stops as soon as the model returns a final answer without calling tools — `/loop` synthesizes a "continue" follow-up whenever the model appears to stop early, and keeps iterating. The model signals termination itself by emitting `DONE` or `STUCK: <reason>` on a line by itself, at which point the loop ends and the final summary is written to scrollback.

**Safety rails:**

- `LoopGuard` enforces the active profile's `loopIterationCap` and `loopCostCap`. The loop can't outrun your budget.
- Checkpoints are still created before the first mutating tool call, so `/undo` works the same way as for a normal turn.
- Permission prompts still fire for every `confirm`-tier tool call. Use `t` in the permission dialog to yolo-approve everything for the duration of the current iteration if you trust the loop.
- `Ctrl+C` aborts the TUI (and therefore the backend), stopping the loop immediately.
- All tool-call, activity, and message events stream in real time — you can watch the loop work and `Ctrl+O` into the tool-call detail view at any moment.

### @mention routing

Direct a message to a specific model by prefixing your prompt with `@<alias>`:

```
> @opus Analyze the security implications of this auth flow
> @deep Write the implementation based on the analysis above
> @gemini Review the code for edge cases
```

**Autocomplete.** Typing `@` as the first character of the input pops an autocomplete list of every enabled model alias (same source as `/models`). Keep typing to narrow it — `@ge` filters to `@gemini` and `@gemini-pro`.

**Prefix matching.** Aliases resolve on an unambiguous prefix, so you don't have to type the whole thing. `@gemi` lands on `@gemini` because it's the only enabled alias starting with those letters. If your prefix is ambiguous (e.g. `@gem` when both `@gemini` and `@gemini-pro` are enabled), the backend reports the ambiguity and lists the candidates so you can disambiguate.

**`/use <alias>`** is the persistent equivalent: it pins *all* subsequent turns to the given model until you run `/use auto` to return to router-based selection. The bottom-of-viewport model indicator updates immediately when `/use` runs — no need to send a turn first.

### Session management

- **Session resume** — pick up where you left off with `/resume`
- **Undo / checkpoints** — revert file changes with `/undo`
- **Auto-save** — sessions are saved periodically and on exit

### MCP support

Connect to any MCP-compatible tool server:

```
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /home
/mcp add github npx -y @modelcontextprotocol/server-github
/mcp add my-api http https://api.example.com/mcp
```

MCP tools appear alongside built-in tools and are available to the agent automatically.

### Git integration

The TUI shows your current branch and dirty-file count in the status bar. Git tools (`git_status`, `git_commit`, `git_diff`) let the agent interact with your repository. Checkpoints are created before mutating operations so `/undo` can roll back.

### Permission system

Tool calls that write files, run commands, or access the network require approval:

```
┌─ permission ──────────────────────────────────────────┐
│ Permission required [confirm]                          │
│                                                        │
│ Tool: run_command                                      │
│ npm test                                               │
│                                                        │
│ [y/⏎] approve   [n] deny   [a] same cmd (session)      │
│ [t] yolo — approve everything for the rest of this turn│
└────────────────────────────────────────────────────────┘
```

- **`y` / Enter** — approve this one call
- **`n` / Esc** — deny
- **`a`** — approve this exact command (fingerprint-matched) for the rest of the session
- **`t`** — yolo: approve every confirm-tier tool call until the assistant turn ends. Cleared automatically when the turn finishes. Does **not** bypass `always-confirm` tier (rm -rf, sudo, force-push to main, etc. — still prompt every time)

Configure defaults in `.kondi-chat/permissions.json`.

### Analytics and cost tracking

```
/analytics          # usage by model/provider (last 30 days)
/analytics 7        # last 7 days
/analytics export   # export all data as JSON
/cost               # cost breakdown for current session
```

### Non-interactive mode

Run kondi-chat in CI, scripts, or pipelines:

```bash
# Pipe a prompt
echo "Explain this error" | kondi-chat --pipe

# Direct prompt
kondi-chat --prompt "Add error handling to auth.ts" --json

# Auto-approve specific tools
kondi-chat --prompt "Fix the tests" --auto-approve run_command,write_file
```

## Commands

| Command | Description |
|---------|-------------|
| `/mode [profile]` | Show or switch budget profile. Persisted across restarts via config.json. |
| `/use <alias>` | Force a specific model (`/use auto` for router). Supports unambiguous prefix matching — `/use gemi` → gemini. Updates the model indicator immediately. |
| `/models` | List available models and aliases |
| `/health` | Check model availability |
| `/routing` | Routing stats dashboard — tier distribution (intent/nn/rules), per-model cost, model×tier matrix, NN training readiness, per-phase breakdown |
| `/status` | Session stats and context utilization |
| `/cost` | Cost breakdown by model |
| `/analytics [days]` | Usage analytics |
| `/consultants` | List domain-expert consultants the agent can call via the `consult` tool |
| `/council [list\|run]` | Council deliberation — explicit-only, never auto-invoked by the agent |
| `/loop <goal>` | Autonomous agent loop with guards — cycles until the model emits DONE / STUCK or LoopGuard caps hit |
| `/undo [n]` | Undo last n file changes |
| `/resume` | Resume a previous session |
| `/sessions` | List saved sessions |
| `/mcp` | List MCP servers and tools |
| `/tools` | List agent tools |
| `/help [topic]` | Show all commands or a specific help topic (zai, compression, intent-router, type-ahead, mentions, consultants, etc.) |
| `/quit` | Exit |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message — or queue it if a turn is already running |
| `Ctrl+N` | Insert newline in input |
| `Ctrl+O` | Toggle tool-call detail view (current turn) |
| `Ctrl+T` | Toggle token-stats detail view (current turn) |
| `Ctrl+R` | Toggle reasoning detail view — hidden chain-of-thought from reasoning models (GLM-5.x, OpenAI o-series, DeepSeek-R1, Anthropic extended thinking) |
| `Ctrl+Y` | Copy last assistant response to system clipboard (raw markdown) |
| `Ctrl+A` | Toggle activity log |
| `←` / `→` | Move cursor within input |
| `Home` / `End` | Jump to start / end of input |
| `Backspace` / `Delete` | Delete before / at cursor |
| `↑` / `↓` | Recall input history (bash-style) |
| `Esc` | Close detail view → clear input → clear queued submits (in that order) |
| `Ctrl+C` | Exit |

**Type-ahead queue.** If you hit Enter while a turn is still running, the new message is queued instead of fired concurrently. The TUI renders a dim `⧗ queued: …` line in scrollback as confirmation, and the status bar shows `⧗ queued: N (Esc to clear)`. When the current turn finishes, the oldest queued entry fires automatically and the spinner picks back up. This guarantees at most one `handleSubmit` is ever in flight on the backend — concurrent turns can't race over shared session state, tool call attribution, or the permission dialog. `Esc` on an empty input clears the queue if you change your mind mid-stack.

Mouse wheel scrolls the terminal scrollback. Text selection and copy work natively — no special mode needed.

Markdown tables in assistant responses are rendered with box-drawing characters. Code fences, headers, and lists render as-is. When a response was produced by a reasoning model, a dim magenta `[^R reasoning]` tag appears in the header so you know `Ctrl+R` will show something.

## Configuration

### Environment variables

Create a `.env` file in the project root or export directly:

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT) |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `XAI_API_KEY` | xAI (Grok) |
| `ZAI_API_KEY` | Z.AI (GLM) — Coding Plan endpoint |
| `BRAVE_SEARCH_API_KEY` | Brave Search (web tools) |
| `OLLAMA_BASE_URL` | Ollama (local models, default: http://localhost:11434) |

### Project-level config

All configuration lives in `.kondi-chat/` in the project root:

```
.kondi-chat/
  config.json           # General settings
  permissions.json      # Tool permission tiers
  profiles/             # Budget profiles (quality.json, balanced.json, cheap.json, + custom)
  models.yml            # Model registry
  sessions/             # Saved sessions
  analytics.json        # Usage data
  backend.log           # Backend diagnostic log
```

## Providers

| Provider | Models | Key required |
|----------|--------|-------------|
| Anthropic | Claude Opus, Sonnet, Haiku (with prompt caching + extended thinking) | Yes |
| OpenAI | GPT-5.4, GPT-4o, o3 | Yes |
| DeepSeek | DeepSeek Chat, Coder | Yes |
| Google | Gemini 2.5 Pro, Flash | Yes |
| xAI | Grok | Yes |
| Z.AI | GLM 5.1, 5, 4.7, 4.6, 4.5, 4.5-air, 4.5-flash (free) — via OpenAI-compatible Coding Plan endpoint | Yes |
| Ollama | Any local model | No (local) |

kondi-chat works with any combination of providers. The router automatically excludes providers without keys and routes to what's available.

### Z.AI (GLM Coding Plan)

Z.AI's OpenAI-compatible API is used through the **Coding Plan** endpoint (`https://api.z.ai/api/coding/paas/v4`) rather than the general-purpose `/api/paas/v4`. If you subscribed to the GLM Coding Plan on z.ai, your key is authorized on the coding endpoint only — hitting the general PaaS endpoint returns HTTP 429 with error code 1113 ("insufficient balance"). kondi-chat handles this automatically; just set `ZAI_API_KEY` in your `.env`.

Use `/mode zai` to activate the bundled `zai` profile, which restricts routing to Z.AI models exclusively via `allowedProviders: ["zai"]`:

| Phase | Capability | Routed to | In/Out per 1M |
|---|---|---|---|
| planning / reasoning / analysis / code-review | `planning`, `reasoning`, `analysis` | `glm-5.1` | $1.40 / $4.40 |
| execution / coding / fast-coding / general | `coding`, `fast-coding`, `general` | `glm-4.6` | $0.60 / $2.20 |
| compression / state_update / summarization | `summarization` | `glm-4.5-flash` | **free** |

**Reasoning tax caveat.** `glm-5.1` is a reasoning model — it emits hidden chain-of-thought that is billed as **output tokens at the full $4.40/M rate** but not shown inline. A single 20-char reply can cost 500+ output tokens of invisible thinking. Press `Ctrl+R` in the TUI to see what the model was actually reasoning about. For high-volume agent-loop work, consider pinning execution to `@glm` (glm-4.6, non-reasoning) with `/use glm` so you only pay the reasoning premium on planning phases.

**Prompt caching.** z.ai's Coding Plan endpoint serves `prompt_tokens_details.cached_tokens` automatically for repeated prefixes ≥1k tokens. kondi-chat tracks cache hits per call and discounts them 50% in the cost estimator. Cache hit totals appear in `/routing` and `/cost`.

## Building from source

Prerequisites:
- Node.js 18+
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

```bash
git clone https://github.com/thisPointOn/kondi-chat.git
cd kondi-chat
npm install

# Build the Rust TUI (required)
cd tui && cargo build --release && cd ..

# Run the TUI
npm run chat:tui

# Or run just the Node backend (used by `kondi-chat` in non-interactive mode,
# and spawned as a child process by the Rust TUI at runtime)
npm start
```

The Rust TUI is the only frontend; the Node backend is the engine it talks to over JSON-RPC on stdio. There is no pure-Node "chat" frontend — `npm run chat:tui` is the interactive entry point, and `npm start` / `kondi-chat --prompt …` are non-interactive entry points that bypass the TUI entirely.

## Architecture

```
┌─────────────────────────────────────────┐
│  Rust TUI (tui/)                         │
│  Ratatui + Crossterm, inline viewport    │
│  Renders to terminal, handles input      │
├──────────── JSON-RPC over stdio ────────┤
│  Node.js Backend (src/)                  │
│  LLM routing, tools, MCP, context mgmt  │
│  Providers: Anthropic, OpenAI, etc.      │
└─────────────────────────────────────────┘
```

The Rust TUI spawns the Node.js backend as a child process. They communicate via JSON-RPC over stdin/stdout. All LLM calls, tool execution, and state management happen in the backend. The TUI is purely display and input.

## License

MIT -- see [LICENSE](LICENSE).
