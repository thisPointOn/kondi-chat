# kondi-chat

A multi-model AI coding CLI that routes between Claude, GPT, DeepSeek, Gemini, Grok, and local models. It picks the right model for each task based on cost/quality profiles, runs an agent loop with file tools, and renders inline in the terminal so scroll, select, and copy all work natively.

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

Every message is classified (coding task vs discussion) and routed to the best available model based on your active budget profile. The router has three tiers:

1. **NN Router** — fast, trained on your accumulated usage data
2. **Intent Router** — LLM-based classification for cold-start / new models
3. **Rule Router** — deterministic fallback using profile preferences

You see the routing decision on every turn:

```
router: phase=execute (coding intent detected)
→ gpt-5.4 (rules: balanced: coding)
```

### Budget profiles

| Mode | Use case | Iteration cap | Cost cap |
|------|----------|--------------|----------|
| `quality` | Complex architecture, frontier reasoning | 30 | $10.00 |
| `balanced` | Everyday coding and chat (default) | 20 | $3.00 |
| `cheap` | Quick lookups, high-volume exploration | 8 | $0.75 |

Switch at any time: `/mode quality`

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
  "maxOutputTokens": 8192
}
```

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

For decisions that matter, run a multi-model council:

```
/council run architecture "Should we use microservices or a monolith for this project?"
```

Multiple models debate the question across several rounds, with a manager model synthesizing the final recommendation. Profiles control which models participate, how many rounds, and the debate format.

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
┌─ permission ──────────────────────────────────────┐
│ Permission required [confirm]                      │
│                                                    │
│ Tool: run_command                                  │
│ npm test                                           │
│                                                    │
│ [y] approve   [n] deny   [a] approve all (session) │
└────────────────────────────────────────────────────┘
```

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
| `Ctrl+N` | Insert newline |
| `Ctrl+O` | View tool calls (current turn) |
| `Ctrl+T` | View token stats (current turn) |
| `Ctrl+A` | Toggle activity log |
| `Up/Down` | Input history (bash-style) |
| `Escape` | Close detail view / clear input |
| `Ctrl+C` | Exit |

Mouse wheel scrolls the terminal scrollback. Text selection and copy work natively — no special mode needed.

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
| Anthropic | Claude Opus, Sonnet, Haiku | Yes |
| OpenAI | GPT-5.4, GPT-4o, o3 | Yes |
| DeepSeek | DeepSeek Chat, Coder | Yes |
| Google | Gemini 2.5 Pro, Flash | Yes |
| xAI | Grok | Yes |
| Ollama | Any local model | No (local) |

kondi-chat works with any combination of providers. The router automatically excludes providers without keys and routes to what's available.

## Building from source

Prerequisites:
- Node.js 18+
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

```bash
git clone https://github.com/thisPointOn/kondi-chat.git
cd kondi-chat
npm install

# Build the Rust TUI (recommended)
cd tui && cargo build --release && cd ..

# Run with the TUI
npm run chat:tui

# Or run the Node backend directly (no Rust needed, no TUI)
npm run chat
```

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
