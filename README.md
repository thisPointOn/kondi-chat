# kondi-chat

A multi-model AI coding CLI that learns which model to use for each task. Optimizes for cost, quality, and reliability across providers.

## What Makes This Different

### 1. Intelligent Model Routing
Instead of using one model for everything, kondi-chat routes each task to the best model:
- **Planning** → frontier model (GPT-5.4, Opus)
- **Code generation** → cheapest capable coder (DeepSeek, local Qwen)
- **Summarization** → cheapest available (Haiku, Phi, Nano)
- **Promotion** → if a cheap model fails, automatically escalate

Three-tier routing system:
- **NN Router** — trained on your usage data, predicts best model per task
- **Intent Router** — LLM classifies prompts against model descriptions (cold-start)
- **Rule Router** — phase × task kind lookup (always-available fallback)

### 2. Self-Improving Router
The system trains itself:
1. Rule router makes decisions (teacher)
2. Every decision is logged with rich signals: success/fail, user acceptance, quality score, cost, latency
3. After ~100+ samples, train a lightweight NN that takes over
4. NN learns which model gives the best response for each type of prompt
5. Reliability is a first-class signal — unreliable models get routed around

Training signals include:
- Verification pass/fail (tests, typecheck)
- User retry detection (implicit rejection)
- API errors and fallbacks
- Quality scoring (response length, tool usage, latency)
- Cost efficiency (quality per dollar)
- Prompt embeddings (content-level routing)

### 3. Budget Profiles
Three modes that change the entire system's behavior:

| Mode | Planning | Execution | Loop cap | Cost cap |
|---|---|---|---|---|
| `/mode quality` | Frontier | Mid-tier | 10 iters | $5.00 |
| `/mode balanced` | Mid-tier | Cheapest | 6 iters | $2.00 |
| `/mode cheap` | Cheapest | Local only | 3 iters | $0.50 |

### 4. Autonomous Loops with Guards
```
/loop cheap "add unit tests for all modules"
```
Runs the agent in a tight loop with cost/iteration guards:
- Iteration caps per profile
- Cost caps (break before overspending)
- Error deduplication (same error 3x = stuck, stop)
- Automatic model promotion on persistent failures

### 5. @Mention Any Model
```
@opus plan the architecture for a new feature
@deep write the implementation
@claude review the code
@haiku summarize what we did
```
Each model sees the full conversation context. Use the right model for the right job, manually or let the router decide.

### 6. Agent Loop with Tools
The model doesn't just chat — it reads files, searches code, runs commands, writes code, and creates task cards:

| Tool | What it does |
|---|---|
| `read_file` | Read a project file |
| `write_file` | Create or overwrite a file (with backup) |
| `edit_file` | Search/replace edit (with backup) |
| `list_files` | List directory contents |
| `search_code` | Grep for patterns |
| `run_command` | Run shell commands (tests, builds) |
| `create_task` | Dispatch → Execute → Verify → Reflect pipeline |
| `update_plan` | Track goals, decisions, constraints |

### 7. Pipeline Execution
When code needs to be written, a full pipeline runs:
1. **Dispatch** — frontier model creates a task card (bounded spec)
2. **Execute** — worker model writes code from the task card
3. **Apply** — changes written to disk with automatic backup
4. **Verify** — local tests, lint, typecheck
5. **Reflect** — frontier summarizes results

### 8. MCP Support
Compatible with Claude Code's MCP servers:
```
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /home
/mcp add github npx -y @modelcontextprotocol/server-github
/mcp add my-api http https://api.example.com/mcp
```
Local (stdio) and remote (HTTP) servers. Tools auto-discovered and available to the agent. Smart tool filtering per phase to save tokens.

### 9. Full Audit Trail
Every LLM call recorded:
- `/ledger` — every call: model, phase, tokens, cost, latency
- `/cost` — breakdown by phase and model
- `/routing` — model reliability, success rates, training data readiness
- `/status` — context utilization, compaction count, cache hit rate
- `/export` — dump everything to JSON
- Automatic file backups on every write

### 10. Context Efficiency
- **Threshold-based auto-compaction** — summarizes old messages when approaching context window
- **Compact boundary markers** — only sends recent messages after summary
- **System prompt caching** — context goes in system prompt for cache efficiency
- **Tool result compaction** — older tool results truncated after model consumes them
- **Token budget tracking** — real-time context utilization monitoring

### 11. Streaming Responses
All providers stream token by token — Anthropic, OpenAI, Ollama, DeepSeek. Responses appear as they're generated.

### 12. Open-Ended Capabilities
Models, task kinds, and capabilities are all open strings. Add:
```
/models add aerospace-llm ollama aerospace,physics 0 0 aero
```
Then `@aero calculate thrust-to-weight ratio` routes to it. The NN learns new domains from usage data.

## Supported Providers
- **Anthropic** (Claude Opus, Sonnet, Haiku)
- **OpenAI** (GPT-5.4, Mini, Nano)
- **DeepSeek** (V3)
- **Google** (Gemini)
- **xAI** (Grok)
- **Ollama** (any local model)
- **NVIDIA** (NIM router)

## Quick Start

```bash
# Install
npm install

# Create .env with API keys
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
echo "OPENAI_API_KEY=sk-proj-..." >> .env

# Pull embedding model (optional, for content-aware routing)
ollama pull nomic-embed-text

# Run
npm run chat
```

## Keyboard Shortcuts
| Key | Action |
|---|---|
| Enter | Send message |
| Ctrl+N | New line |
| Ctrl+O | View tool calls |
| Ctrl+T | View token stats |
| Ctrl+M | View full message |
| Ctrl+A | Expand activity log |
| Escape | Back to chat / clear input |
| Ctrl+C | Exit |

## Architecture

```
src/
├── cli/          TUI (Ink/React) + agent loop
│   ├── main.tsx  Entry point, agent loop, command handling
│   └── ui/       React components (App, ChatView, InputBar, etc.)
├── context/      Context management, budget, compaction
├── engine/       Pipeline, task cards, tools, verification, file apply
├── providers/    Multi-provider LLM caller with streaming + retry
├── router/       Three-tier routing, model registry, profiles, training
│   ├── registry  Model catalog with capabilities and health checks
│   ├── rules     Rule-based router (teacher)
│   ├── nn-router NN inference (student)
│   ├── intent    LLM-based classification (cold-start)
│   ├── profiles  Budget modes (quality/balanced/cheap)
│   ├── collector Training data with rich quality signals
│   ├── embeddings Local embedding service
│   └── train.py  NN trainer (numpy, no PyTorch)
├── mcp/          MCP client, config, tool manager
└── audit/        Ledger, cost tracking
```
