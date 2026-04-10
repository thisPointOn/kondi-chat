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
```

On first run, kondi-chat writes a default `.kondi-chat/config.json` based on
which environment variables are set.

## First session

Run the TUI:

```bash
npm run chat:tui
```

Try some prompts:

- "Show me the structure of this repo."
- "Read src/types.ts and summarize the main types."
- "Add a test for computeUnifiedDiff."

Press `^O` to view tool calls in detail, `^T` for stats, `^C` to quit.

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

- **Permissions** — tools like `run_command` and `write_file` prompt for
  confirmation by default. See `docs/permissions.md`.
- **Checkpoints** — every mutating turn snapshots state. `/undo` restores the
  latest. See `docs/checkpoints.md`.
- **Memory** — drop a `KONDI.md` at the project root (or user home) to pin
  conventions into every prompt. See `docs/memory.md`.
- **Hooks** — run shell commands or tool chains before/after tool calls.
  Configure in `.kondi-chat/hooks.json`. See `docs/hooks.md`.
- **Rate limiting** — per-provider RPM/TPM buckets. See `/rate-limits`.
- **Sub-agents** — the agent can `spawn_agent` to delegate focused subtasks.

Run `/help` inside the TUI for a topic index.
