# kondi-chat

Multi-model AI coding CLI with intelligent routing, budget profiles, and council deliberation.

<!-- TODO: Add demo gif -->

## Install

```bash
# npm
npm install -g kondi-chat

# Homebrew (macOS)
brew tap kondi/tap
brew install kondi-chat

# From source
git clone https://github.com/kondi/kondi-chat.git
cd kondi-chat
npm install
npm run build:tui
```

## Features

- **Multi-model routing** -- Claude, GPT, DeepSeek, Gemini, Grok, and Ollama (local models)
- **Intelligent cost-aware routing** with three budget profiles (quality, balanced, cheap)
- **Agent loop with tools** -- read, write, and edit files; run commands; search code
- **Council deliberation** -- multi-model debate for high-stakes decisions
- **Session resume** with undo and checkpoints
- **MCP support** -- stdio and HTTP servers, auto-discovered tools
- **Git integration** -- commits, diffs, and branch awareness
- **Permission system** -- approve or deny tool calls
- **Analytics and cost tracking** -- per-model, per-phase breakdowns
- **Inline terminal rendering** -- scroll, select, and copy work natively via the Rust TUI

## Quick start

Set at least one API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Optional: additional providers
export OPENAI_API_KEY=sk-proj-...
export DEEPSEEK_API_KEY=...
```

Run:

```bash
kondi-chat
```

Basic usage:

```
> Explain this codebase
> @opus Plan a refactor of the auth module
> @deep Write the implementation
> /mode cheap
> /loop "Add tests for all untested modules"
```

## Configuration

### Budget profiles

Switch modes at any time with `/mode`:

| Mode | Planning model | Execution model | Loop cap | Cost cap |
|------|---------------|-----------------|----------|----------|
| quality | Frontier | Mid-tier | 10 | $5.00 |
| balanced | Mid-tier | Cheapest | 6 | $2.00 |
| cheap | Cheapest | Local only | 3 | $0.50 |

### Custom model profiles

Add models dynamically:

```
/models add my-llm ollama general 0 0 myalias
```

### MCP servers

```
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /home
/mcp add github npx -y @modelcontextprotocol/server-github
/mcp add my-api http https://api.example.com/mcp
```

### Environment variables

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
DEEPSEEK_API_KEY=...
GOOGLE_API_KEY=...
XAI_API_KEY=...
```

## Commands

| Command | Description |
|---------|-------------|
| `/mode <profile>` | Switch budget profile (quality, balanced, cheap) |
| `/loop <prompt>` | Run agent in autonomous loop with guards |
| `/models` | List available models |
| `/models add ...` | Register a new model |
| `/mcp add ...` | Add an MCP server |
| `/mcp list` | List connected MCP servers |
| `/cost` | Show cost breakdown |
| `/ledger` | Show full API call ledger |
| `/routing` | Show model reliability and routing stats |
| `/status` | Show context utilization and stats |
| `/export` | Export session data to JSON |
| `/undo` | Undo last file change |
| `/help` | Show available commands |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Enter | Send message |
| Ctrl+N | New line |
| Ctrl+O | View tool calls |
| Ctrl+T | View token stats |
| Ctrl+M | View full message |
| Ctrl+A | Expand activity log |
| Escape | Back to chat / clear input |
| Ctrl+C | Exit |

## Building from source

Prerequisites:

- Node.js 18 or later
- Rust toolchain (rustup, cargo)

```bash
git clone https://github.com/kondi/kondi-chat.git
cd kondi-chat
npm install
npm run build:tui
npm start
```

To run the TUI (requires Rust build):

```bash
npm run chat:tui
```

To run the Node backend directly (no Rust needed):

```bash
npm run chat
```

## License

MIT
