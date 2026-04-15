# Getting Started

## Install

```bash
git clone https://github.com/<you>/kondi-chat
cd kondi-chat
npm install
cargo build --manifest-path tui/Cargo.toml --release
```

## Configure

Set at least one provider API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
# or
export ZAI_API_KEY=...          # Z.AI (GLM) Coding Plan
# or any combination; the router uses whatever's present
```

Supported providers: Anthropic, OpenAI, DeepSeek, Google (Gemini), xAI (Grok),
Z.AI (GLM), Ollama (local). Set the matching `<PROVIDER>_API_KEY` environment
variable for each one you want enabled; the router automatically excludes
providers without keys.

On first run, kondi-chat writes a default `.kondi-chat/config.json` based on
which environment variables are set, plus `.kondi-chat/profiles/*.json`
(budget profiles), `.kondi-chat/consultants.json` (domain-expert roster), and
`.kondi-chat/models.yml` (model registry).

## First session

Run the TUI:

```bash
npm run chat:tui
```

Try some prompts:

- "Show me the structure of this repo."
- "Read src/types.ts and summarize the main types."
- "Add a test for computeUnifiedDiff."
- `@gemini What are the tradeoffs between monorepo and polyrepo?` — route one message to a specific model (prefix `@` triggers an autocomplete dropdown)
- `/mode zai` — switch to the bundled Z.AI profile (requires `ZAI_API_KEY`)
- `/loop fix all the failing tests and commit when green` — autonomous loop that runs until DONE or LoopGuard trips

Key TUI shortcuts while in a session:

- **Enter** — send (or queue if a turn is already running; see `/help type-ahead`)
- **Ctrl+O** — tool-call detail view
- **Ctrl+T** — token stats detail view
- **Ctrl+R** — reasoning detail view (hidden chain-of-thought from GLM-5.x, OpenAI o-series, DeepSeek-R1, Anthropic extended thinking)
- **Ctrl+Y** — copy last assistant response to clipboard
- **Ctrl+C** — quit
- **←/→/Home/End** — cursor movement inside the input
- **Esc** — close detail view → clear input → clear queued submits

## Non-interactive

```bash
# single turn
kondi-chat --prompt "write a commit message for the staged changes" --pipe

# JSON for scripts
kondi-chat --prompt "review the diff" --json < <(git diff)
```

## Resume

```bash
kondi-chat --resume          # resume latest session in this directory
kondi-chat --resume f3a1b2c3  # resume a specific session
kondi-chat --sessions         # list sessions
```

## Core features

- **Multi-tier routing** — every call goes through NN → Intent → Rules. The intent router (primary) reads every enabled model's description and capabilities and asks a cheap classifier LLM which one fits the task. Scoped to the active profile's `allowedProviders` and `rolePinning`. Run `/routing` to see the tier distribution and NN training progress.
- **Budget profiles** — `balanced`, `cheap`, `quality`, `zai`, `orchestra`, plus any custom `.json` you drop in `.kondi-chat/profiles/`. See `/help /mode` and `docs/configuration.md`.
- **Role pinning** — a profile can hard-bind specific phases to specific model IDs (`{"discuss": "gpt-5.4", "execute": "models/gemini-2.5-pro", "reflect": "glm-5.1"}`) for deterministic multi-provider pipelines. Used by `orchestra`.
- **Context compression** — in-loop adaptive stubbing of old tool results + cross-turn summarization at `contextBudget × 1.2` using the profile's compression model. See `/help compression`.
- **Permissions** — tools like `run_command` and `write_file` prompt for confirmation by default. Approval options: `y`/Enter (once), `a` (same cmd for session), `t` (yolo everything for this turn). See `/help permissions`.
- **Checkpoints** — every mutating turn snapshots state. `/undo` restores the latest. See `docs/checkpoints.md`.
- **Memory** — drop a `KONDI.md` at the project root (or user home) to pin conventions into every prompt. See `docs/memory.md`.
- **Hooks** — run shell commands or tool chains before/after tool calls. Configure in `.kondi-chat/hooks.json`. See `docs/hooks.md`.
- **Rate limiting** — per-provider RPM/TPM buckets. See `/rate-limits`.
- **Sub-agents** — the agent can `spawn_agent` to delegate focused subtasks.
- **Consultants** — domain-expert personas (aerospace engineer, security auditor, database architect, …) the agent can call via the `consult` tool when it decides a problem has a domain angle. Each consultant has a model, a system prompt, and optional persistent context (baked text + lazy-loaded spec files). Configure in `.kondi-chat/consultants.json`. See `/help consultants` and `docs/configuration.md`.
- **Autonomous `/loop`** — `/loop <goal>` runs the agent in a loop until it emits `DONE` or `STUCK`, or LoopGuard caps trip. See `/help /loop`.
- **Councils** — `/council run <profile> <brief>` fans out to a multi-model deliberation. Explicit-only: the agent cannot auto-invoke councils.

Run `/help` inside the TUI for a topic index. Useful deep-dive topics: `/help zai`, `/help orchestra` (via configuration.md), `/help consultants`, `/help intent-router`, `/help compression`, `/help type-ahead`, `/help mentions`, `/help shortcuts`, `/help reasoning-models`, `/help caching`.
