# Getting started

## Install

```bash
# Requires Node 18+. The postinstall downloads the prebuilt TUI binary
# for your platform automatically — no Rust toolchain needed.
npm install -g @thispointon/kondi-chat
```

Supported platforms: Linux x64/arm64, macOS x64/arm64, Windows x64.

**Windows / PowerShell:** if `kondi-chat` won't run because PowerShell blocks the npm-generated script shim, run this once (safe, non-admin):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Or invoke `kondi-chat.cmd` directly instead.

**From source** (for hacking on it):

```bash
git clone https://github.com/thisPointOn/kondi-chat.git
cd kondi-chat
npm install --ignore-scripts            # skip postinstall when building locally
cd tui && cargo build --release && cd ..
npm run chat:tui
```

## Configure

Set at least one provider API key — you don't need all of them. The router auto-excludes providers without keys, so a missing key is never an error.

**Recommended: a `.env` file.** Put one `KEY=value` per line. kondi-chat reads `.env` from the directory you launched it in, from `~/.kondi-chat/.env` (a global file — set keys once, use them everywhere), and from the install directory.

```bash
# ~/.kondi-chat/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
GOOGLE_API_KEY=...               # Gemini — free tier is generous
DEEPSEEK_API_KEY=...             # DeepSeek V3 — ~$0.27/M in, $1.10/M out
ZAI_API_KEY=...                  # Z.AI (GLM) Coding Plan — free GLM-4.5-flash
XAI_API_KEY=...                  # Grok
```

Or `export` the same variables in your shell for a one-off / CI run.

Supported providers: Anthropic, OpenAI, DeepSeek, Google (Gemini), xAI (Grok), Z.AI (GLM), Ollama (local).

On first run, kondi-chat writes default configs under `.kondi-chat/`:
- `config.json` — active profile + enabled providers
- `profiles/*.json` — budget profiles
- `consultants.json` — domain-expert roster
- `models.yml` — model registry (overrides built-ins)
- `permissions.json` — tool-permission tiers
- `hooks.json` — pre/post tool hooks
- `rate-limits.json` — per-provider RPM/TPM

See [configuration.md](configuration.md) for every field.

## First session

```bash
kondi-chat
```

Try some prompts:

- *"Show me the structure of this repo."*
- *"Read src/types.ts and summarise the main types."*
- *"Add a test for computeUnifiedDiff."*
- `@gemini What are the tradeoffs between monorepo and polyrepo?` — pin one turn to a specific model (typing `@` at the start of input pops an autocomplete dropdown)
- `/mode zai` — switch to the Z.AI profile (requires `ZAI_API_KEY`)
- `/loop fix all the failing tests and commit when green` — autonomous loop until `DONE` / `STUCK` or LoopGuard caps trip

### Free-tier path

If you have `GOOGLE_API_KEY` and `ZAI_API_KEY`, you can run a session that costs essentially nothing. Launch `kondi-chat`, then inside the session:

```
/mode zai            # GLM-4.5-flash + GLM-4.6 + GLM-5.1 (all on Z.AI Coding Plan)
```

The profile choice persists across restarts in `.kondi-chat/config.json`, so you only need to do this once. Or build a custom profile that pins coding to Gemini 2.5 Pro and compression to GLM-flash — see the free-tier example in [profiles.md](profiles.md#free-tier-only).

### Cheap path

DeepSeek V3 is currently ~$0.27/M input, $1.10/M output — about 1/15th the cost of Sonnet for similar coding quality. Inside a session:

```
/use deepseek
```

Or create `.kondi-chat/profiles/deepseek-only.json` with `allowedProviders: ["deepseek"]` (see [profiles.md](profiles.md#single-provider-lock-in)) and `/mode deepseek-only`.

## TUI keyboard reference

| Key | What it does |
|---|---|
| Enter | Send (or queue if a turn is already running) |
| Ctrl+O | Tool-call detail view |
| Ctrl+T | Token-stats detail view |
| Ctrl+R | Reasoning detail view (hidden chain-of-thought from GLM-5.x, OpenAI o-series, DeepSeek-R1, Anthropic extended thinking) |
| Ctrl+Y | Copy last assistant response to clipboard |
| Ctrl+C | Quit |
| ←/→/Home/End | Cursor movement inside the input |
| Esc | Close detail view → clear input → clear queued submits |

## Non-interactive

```bash
# Single turn — prompt on the command line, output to stdout
kondi-chat --prompt "write a commit message for the staged changes"

# Pipe stdin in
kondi-chat --prompt "review the diff" --pipe < <(git diff)

# JSON output, for scripts
kondi-chat --prompt "review the diff" --json --pipe < <(git diff)

# Auto-approve specific tools (defaults to always-confirm for risky patterns)
kondi-chat --prompt "run my tests" --auto-approve run_command
```

Exit codes: `0` success · `1` error · `2` max iterations · `3` max cost · `5` permission denied.

## Resume

```bash
kondi-chat --resume          # resume the latest session in this directory
kondi-chat --resume f3a1b2c3  # resume a specific session
kondi-chat --sessions         # list sessions for this directory
```

## Core features

- **Multi-tier routing** — every call goes through NN → Intent → Rules. The intent router (primary) reads each enabled model's description and capabilities and asks a cheap classifier LLM which one fits the task. Scoped to the active profile's `allowedProviders` and `rolePinning`. Run `/routing` to see the tier distribution and NN training progress. See [routing.md](routing.md).
- **Budget profiles** — `balanced`, `quality`, `cheap`, `zai`, `best-value`, `orchestra`, plus any custom `.json` in `.kondi-chat/profiles/`. See [profiles.md](profiles.md).
- **Role pinning** — a profile can prefer specific phases bound to specific model IDs for deterministic multi-provider pipelines. The intent router still gets first shot; pins are a fallback. See [profiles.md#rolepinning](profiles.md#rolepinning).
- **Context compression** — in-loop adaptive stubbing of old tool results + cross-turn summarisation at `contextBudget × 1.2`, using the profile's compression model. See `/help compression` in the TUI.
- **Permissions** — `run_command`, `write_file`, and other mutating tools prompt for confirmation by default. Approval options: `y`/Enter (once), `a` (same args for session), `t` (yolo every confirm-tier tool for this turn). `always-confirm` patterns (rm -rf, sudo, curl|sh, force-push) bypass `t`. See [configuration.md#permissionsjson](configuration.md#permissionsjson).
- **Checkpoints** — every mutating turn snapshots state. `/undo` restores the latest. See `/help checkpoints`.
- **Memory** — drop a `KONDI.md` at the project root (or `~/.kondi-chat/KONDI.md` for user-level) to pin conventions into every prompt. See `/help memory`.
- **Hooks** — run shell commands or tool chains before/after tool calls. Configure in `.kondi-chat/hooks.json`. See [configuration.md#hooksjson](configuration.md#hooksjson).
- **Rate limiting** — per-provider RPM/TPM buckets. Run `/rate-limits`. See [configuration.md#rate-limitsjson](configuration.md#rate-limitsjson).
- **Sub-agents** — the agent can `spawn_agent` to delegate focused subtasks (research / worker / planner roles).
- **Consultants** — domain-expert personas (aerospace engineer, security auditor, database architect) the agent can call via the `consult` tool. Configure in `.kondi-chat/consultants.json`. See [configuration.md#consultantsjson](configuration.md#consultantsjson).
- **Autonomous `/loop`** — `/loop <goal>` runs until the model emits `DONE` / `STUCK` or LoopGuard caps trip. See `/help /loop`.
- **Councils** — `/council run <profile> <brief>` fans out to multi-model deliberation. Explicit-only: the agent cannot auto-invoke councils. The deliberation engine is bundled; profiles live in `.kondi-chat/councils/*.json`.

Run `/help` inside the TUI for the full topic index.
