# kondi-chat

A multi-model AI coding CLI that routes between Claude, GPT, DeepSeek, Gemini, Grok, Z.AI (GLM), and local models. It picks the right model for each task based on cost/quality profiles, runs an agent loop with file tools, and renders inline in the terminal so scroll, select, and copy all work natively.

<!-- TODO: Add demo gif (record with `vhs` or `asciinema`) -->

## Why kondi-chat

Most AI coding tools lock you into one model and one provider. kondi-chat routes every request through an intelligent router that picks the best model for the job — frontier models for planning, fast models for edits, cheap models for grunt work. You set a budget profile and the router handles the rest.

**What makes it different:**

- **Multi-model routing** — not just "pick a model." The router classifies your intent (coding vs discussion), consults budget profiles, and selects from all available providers. Switch from `balanced` to `quality` mid-session and the router re-targets automatically.
- **Council deliberation** — for high-stakes decisions, spawn a multi-model debate where 3-5 models argue to consensus. No other CLI tool does this.
- **Budget profiles** — `cheap` mode costs pennies. `quality` mode uses frontier models. `balanced` is the default. Create custom profiles for specific workflows.
- **Provider-agnostic** — works with Anthropic, OpenAI, DeepSeek, Google, xAI, Ollama (local), and any MCP-compatible server. Add a model in one command.
- **Real terminal app** — inline viewport rendering (like Codex). The chat scrolls in your terminal's native scrollback. Mouse wheel, text selection, copy all work. No alternate-screen capture.

## Install

```bash
# npm (requires Node 18+)
npm install -g kondi-chat

# Homebrew (macOS)
brew tap thisPointOn/tap
brew install kondi-chat

# From source
git clone https://github.com/thisPointOn/kondi-chat.git
cd kondi-chat
npm install
cd tui && cargo build --release && cd ..
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
| `create_task` | Dispatch multi-phase coding tasks |
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

### @mention routing

Direct a message to a specific model:

```
> @opus Analyze the security implications of this auth flow
> @deep Write the implementation based on the analysis above
> @gemini Review the code for edge cases
```

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
| `/mode [profile]` | Show or switch budget profile |
| `/use <alias>` | Force a specific model (`/use auto` for router) |
| `/models` | List available models and aliases |
| `/health` | Check model availability |
| `/routing` | Show routing stats and training data |
| `/status` | Session stats and context utilization |
| `/cost` | Cost breakdown by model |
| `/analytics [days]` | Usage analytics |
| `/council [list\|run]` | Council deliberation |
| `/loop <prompt>` | Autonomous agent loop with guards |
| `/undo [n]` | Undo last n file changes |
| `/resume` | Resume a previous session |
| `/sessions` | List saved sessions |
| `/mcp` | List MCP servers and tools |
| `/tools` | List agent tools |
| `/help` | Show all commands |
| `/quit` | Exit |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
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
| `Esc` | Close detail view / clear input |
| `Ctrl+C` | Exit |

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
