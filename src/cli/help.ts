/**
 * In-app help. Hand-authored topic database keyed by slash command or feature
 * name. `/help` lists topics; `/help <topic>` shows a single entry; if the
 * topic is unknown, the closest-match suggestion is returned.
 */

export interface HelpTopic {
  syntax?: string;
  description: string;
  examples?: string[];
  related?: string[];
}

const TOPICS: Record<string, HelpTopic> = {
  '/mode': {
    syntax: '/mode [quality|balanced|cheap|zai|<custom>]',
    description: 'Show or set the active budget profile. Profiles control loop caps, cost caps, model priorities, and optional provider allow-lists. Persisted across restarts via .kondi-chat/config.json.',
    examples: ['/mode', '/mode quality', '/mode zai'],
    related: ['/use', '/cost', '/routing'],
  },
  '/use': {
    syntax: '/use <alias> | /use auto',
    description: 'Pin the agent to a specific model for every subsequent turn, or return to auto-routing. Aliases resolve on an unambiguous prefix (`/use gemi` → gemini). Ambiguous prefixes list the candidates. The bottom-of-viewport model indicator updates immediately when this runs — no turn required.',
    examples: ['/use claude', '/use gemini', '/use glm', '/use auto'],
    related: ['/models', '/mode', 'mentions'],
  },
  '/models': {
    description: 'List all registered models with their aliases and health status.',
    related: ['/use', '/health'],
  },
  '/status': {
    description: 'Show session cost, token usage, and context window utilization.',
    related: ['/cost', '/analytics'],
  },
  '/cost': {
    description: 'Breakdown of LLM cost by model and phase for the current session.',
    related: ['/status', '/analytics'],
  },
  '/attach': {
    syntax: '/attach <path>',
    description: 'Queue an image (PNG/JPG/GIF/WebP, ≤10MB) to send with the next message. Up to 5 images per turn.',
    examples: ['/attach ./screenshot.png'],
    related: [],
  },
  '/sessions': {
    description: 'List recent sessions (id, message count, cost).',
    related: ['/resume'],
  },
  '/resume': {
    syntax: '/resume <id>',
    description: 'Print the exact restart command to resume a session. v1 does not hot-swap; relaunch with --resume <id>.',
    related: ['/sessions'],
  },
  '/checkpoints': {
    description: 'List checkpoints created before mutating tool calls.',
    related: ['/undo'],
  },
  '/undo': {
    syntax: '/undo [N | <id>]',
    description: 'Revert to a previous checkpoint. No argument restores the latest; N reverts that many checkpoints back; an id restores a specific one.',
    examples: ['/undo', '/undo 2', '/undo cp-1712438400-abcd'],
    related: ['/checkpoints'],
  },
  '/routing': {
    description: 'Routing dashboard: tier distribution (intent/nn/rules), per-model success rates and cost, model×tier matrix, quality scores, NN training readiness, and by-phase breakdown. The intent tier is the primary — if it is dominant you know the router is picking models with full model descriptions instead of falling back to hardcoded rules.',
    related: ['/models', '/cost', '/analytics'],
  },
  '/rate-limits': {
    description: 'Show per-provider RPM/TPM usage and any queued requests.',
  },
  '/telemetry': {
    syntax: '/telemetry [enable|disable|status|details|export|delete]',
    description: 'Control opt-in local telemetry. Nothing is sent to any server in v1.',
  },
  '/consultants': {
    description:
      'List the domain-expert consultants configured for this project. Each consultant is a (model, system-prompt) pair stored in .kondi-chat/consultants.json. The agent can call them via the `consult` tool when it decides a problem has a clear domain angle — aerospace safety, security, database, etc. Edit the JSON to add, remove, or tune experts without touching code.',
    related: ['consultants', '/models'],
  },
  'consultants': {
    description:
      'Consultants are domain-expert personas the agent calls on demand via the `consult` tool. Each is a triple of (role id, provider/model, system prompt) stored in .kondi-chat/consultants.json. Consultants are pure text-in/text-out — they cannot read files, run commands, or see the main conversation. They exist to give the agent a specialized opinion without setting up a full sub-agent. Defaults include aerospace-engineer, security-auditor, and database-architect. To add one, append an entry to the JSON: {"role": "ml-researcher", "name": "...", "description": "...", "provider": "anthropic", "model": "claude-sonnet-4-5-20250929", "system": "You are a machine-learning researcher..."}. Consultations are logged to the ledger as phase: consult so /routing and /cost can attribute the spend.',
    related: ['/consultants', '/loop'],
  },
  '/loop': {
    syntax: '/loop <goal>',
    description: 'Run an autonomous agent loop toward a stated goal. Each iteration the model may call tools, produce partial output, and decide whether the goal is met. If the model returns final text without calling any tool but has not emitted DONE or STUCK, the backend synthesizes a "continue" follow-up and keeps iterating — LoopGuard still enforces the profile\'s iteration and cost caps. The model signals termination with DONE (success) or STUCK: <reason> (blocked) on its own line. The `/loop` command streams tool_call and activity events in real time like a normal submit, not a silent command.',
    examples: ['/loop fix all the failing tests and commit when green', '/loop find every TODO in src/ and resolve them'],
    related: ['/mode', 'type-ahead', '/undo'],
  },
  '/council': {
    syntax: '/council [list | run <profile> <brief>]',
    description: 'Run multi-model deliberation via the council tool. Councils are expensive (fan out across frontier models for multiple rounds) and blocking (synchronous subprocess) — the agent CANNOT invoke them automatically; only explicit /council runs them. Not available from inside the agent toolset.',
  },
  '/help': {
    syntax: '/help [topic]',
    description: 'Show general help or a specific topic.',
    examples: ['/help', '/help /undo', '/help memory'],
  },
  // Feature topics
  'memory': {
    description: 'KONDI.md files provide persistent project conventions. User ~/.kondi-chat/KONDI.md applies everywhere; <repo>/KONDI.md applies to a project; nearest-ancestor KONDI.md applies to a subdirectory.',
    related: ['/help update_memory'],
  },
  'permissions': {
    description: 'Tools run through a permission gate (auto-approve/confirm/always-confirm). Dangerous shell commands (rm -rf, sudo, git push --force) are always-confirm regardless of config.',
  },
  'checkpoints': {
    description: 'Every turn that mutates files snapshots state first. Git repos use git stash; non-git dirs copy files. /undo restores the latest.',
    related: ['/undo', '/checkpoints'],
  },
  'hooks': {
    description: 'Shell or tool-call hooks run before or after agent tools. Configured in .kondi-chat/hooks.json. See docs/hooks.md.',
  },
  'non-interactive': {
    description: 'Flags: --prompt "<text>", --pipe, --json, --sessions. Exit codes: 0 ok, 1 error, 2 max-iter, 3 max-cost, 5 permission-denied.',
  },
  'shortcuts': {
    description: 'TUI keybindings. Ctrl+C quit · Enter send OR queue if a turn is running (see `type-ahead`) · Ctrl+N newline in input · Ctrl+O toggle tool-call detail view · Ctrl+T toggle stats detail view · Ctrl+R toggle reasoning detail view (chain-of-thought for reasoning models) · Ctrl+Y copy last assistant response to clipboard · Ctrl+A toggle activity log · Left/Right/Home/End move input cursor · Up/Down recall input history · Esc cascades: close detail view → clear input → clear queued submits. Permission dialogs: y/Enter approve · n/Esc deny · a approve this exact command for session · t yolo-approve everything for this turn.',
    related: ['permissions', 'type-ahead', 'mentions'],
  },
  'type-ahead': {
    description: 'Enter during an in-flight turn queues the new message instead of dispatching it. A dim "⧗ queued: …" line drops into scrollback and the status bar shows "⧗ queued: N (Esc to clear)". When the current turn finishes, the oldest queued entry fires automatically. Guarantees at most one handleSubmit is ever in flight on the backend, so concurrent turns cannot race over session state, tool attribution, or permissions. Esc on an empty input clears the queue.',
    related: ['shortcuts'],
  },
  'mentions': {
    description: '@<alias> at the start of a message forces one specific model for that single turn without changing the router state. Typing `@` alone triggers an autocomplete list of every enabled alias, filterable as you keep typing. Aliases resolve on unambiguous prefix (`@gemi` → @gemini). Ambiguous prefixes report candidates. For a persistent pin use /use <alias> instead.',
    related: ['/use', '/models', 'shortcuts'],
  },
  'zai': {
    description: 'Z.AI (GLM) is supported as an OpenAI-compatible provider. Set ZAI_API_KEY in .env. The Coding Plan endpoint (https://api.z.ai/api/coding/paas/v4) is used — NOT the pay-as-you-go /api/paas/v4. Use /mode zai to route everything through the tiered zai profile: glm-5.1 (reasoning) for planning/review, glm-4.6 for execution/coding, glm-4.5-flash (free!) for compression and summarization. Profile restricts routing via allowedProviders so nothing leaks to other providers.',
    related: ['/mode', 'reasoning-models', 'compression'],
  },
  'reasoning-models': {
    description: 'Reasoning models (GLM-5.x, OpenAI o-series, DeepSeek-R1, Anthropic extended-thinking) emit hidden chain-of-thought that is billed as OUTPUT tokens at full rate but not shown inline. A single 20-char reply can cost 500+ output tokens of unseen reasoning — the "80× reasoning tax." Ctrl+R opens the reasoning panel so you can see what the model was actually thinking. Keep reasoning models off the hot path if quota matters; use them only where the depth pays for itself (planning, code review). Cache discount still applies to cached input tokens.',
    related: ['shortcuts', 'zai'],
  },
  'compression': {
    description: 'Context is capped at the active profile contextBudget. Inside a single agent-loop turn, old tool_result payloads are stubbed in place across three escalation passes (keep 2 turns at 300 chars, keep 1 turn at 100 chars, keep 1 turn at 50 chars) — no LLM calls, just string rewriting. Between turns, ContextManager.compact() summarizes older messages via the active profile compression model (glm-4.5-flash in zai mode, claude-haiku-4-5 otherwise) and writes a COMPACT_BOUNDARY marker. Compaction triggers at contextBudget × 1.2, not at the model context window.',
    related: ['/mode', 'zai'],
  },
  'intent-router': {
    description: 'The LLM-based intent router is the primary model-selection tier. On every turn it reads every enabled model description + capabilities and asks a cheap classifier LLM which one best fits the task. Scoped to the active profile allowedProviders (so zai mode never picks claude-opus). Classifier LLM is also profile-scoped (zai uses glm-4.5-flash — free — instead of claude-haiku). Falls through to rule-based routing only when the intent tier errors or the profile has zero valid candidates. /routing shows the per-tier distribution.',
    related: ['/routing', '/mode'],
  },
  'caching': {
    description: 'Prompt cache hits are tracked on both Anthropic (cache_read_input_tokens) and OpenAI-compatible (prompt_tokens_details.cached_tokens) responses. Cached tokens are recorded separately on the ledger entry and discounted in cost estimates (10% of input rate on Anthropic, 50% on OpenAI/Z.AI). See cachedInputTokens in the ledger and /routing for live totals.',
    related: ['/routing', '/cost'],
  },
};

export function formatHelp(topic?: string): string {
  if (!topic) {
    const keys = Object.keys(TOPICS).sort();
    return [
      'Topics (use /help <topic> for details):',
      ...keys.map(k => `  ${k}  —  ${TOPICS[k].description.slice(0, 60)}`),
    ].join('\n');
  }
  const entry = TOPICS[topic] || TOPICS[topic.startsWith('/') ? topic : `/${topic}`];
  if (!entry) {
    const suggestion = closestMatch(topic, Object.keys(TOPICS));
    return suggestion ? `No help for ${topic}. Did you mean ${suggestion}?` : `No help for ${topic}.`;
  }
  const parts: string[] = [];
  if (entry.syntax) parts.push(`Syntax:  ${entry.syntax}`);
  parts.push(entry.description);
  if (entry.examples?.length) parts.push('\nExamples:\n  ' + entry.examples.join('\n  '));
  if (entry.related?.length) parts.push(`\nRelated: ${entry.related.join(', ')}`);
  return parts.join('\n');
}

function closestMatch(query: string, candidates: string[]): string | null {
  let best: { k: string; score: number } | null = null;
  for (const c of candidates) {
    if (c.includes(query) || query.includes(c)) {
      const score = Math.abs(c.length - query.length);
      if (!best || score < best.score) best = { k: c, score };
    }
  }
  return best?.k || null;
}
