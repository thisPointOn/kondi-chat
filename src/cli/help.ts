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
    syntax: '/mode [quality|balanced|cheap|<custom>]',
    description: 'Show or set the active budget profile. Profiles control loop caps, cost caps, and model priorities.',
    examples: ['/mode', '/mode quality', '/mode cheap'],
    related: ['/use', '/cost'],
  },
  '/use': {
    syntax: '/use <alias> | /use auto',
    description: 'Pin the agent to a specific model, or return to auto-routing.',
    examples: ['/use claude', '/use gpt-4o', '/use auto'],
    related: ['/models', '/mode'],
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
  '/rate-limits': {
    description: 'Show per-provider RPM/TPM usage and any queued requests.',
  },
  '/telemetry': {
    syntax: '/telemetry [enable|disable|status|details|export|delete]',
    description: 'Control opt-in local telemetry. Nothing is sent to any server in v1.',
  },
  '/council': {
    syntax: '/council [list | run <profile> <brief>]',
    description: 'Run multi-model deliberation via the council tool.',
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
