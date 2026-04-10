# 17 — Documentation

## Product Description

Documentation covers everything a user needs to go from install to advanced usage: quick-start README, first-session walkthrough, full configuration reference, router training guide, tool reference, profile system, MCP setup, council integration, JSON-RPC protocol for custom frontends, and in-app contextual help via `/help <topic>`.

**Why it matters:** A tool without documentation is unusable beyond the initial demo. Good docs dramatically reduce support burden, empower users to self-serve, and signal that the project is production-quality. In-app help keeps users in flow without context-switching to a browser.

**Revised 2026-04-10 (simplification pass):** Dropped the `scripts/generate-docs.ts` auto-generation pipeline and CI drift check — write docs by hand for v1; revisit if drift becomes a real problem. Dropped `HelpSystem` class in favor of a simple lookup function over the embedded JSON. Dropped search-by-keyword (closest-match suggestion is enough). Dropped TypeScript-example-compile lint. Effort dropped from 5 days to 2.5 days.

## User Stories

1. **Getting started:** A new user visits the GitHub repo. The README shows a 30-second quick-start (install, set API key, run, example prompt). Within 2 minutes they have a working session.

2. **Configuration reference:** A user wants to add a custom model. They check `docs/configuration.md` and find the `models.yml` format with a copy-pasteable example. They also find the router training guide linked from the same page.

3. **Writing a profile:** A user wants a "robotics" profile that prefers specialized models. They read `docs/profiles.md`, copy the example JSON, customize it, save to `.kondi-chat/profiles/robotics.json`, and run `/mode robotics`.

4. **In-app help:** During a session, the user wonders what `/use` does. They type `/help /use` and get a contextual help message with syntax, examples, and related commands.

5. **Building a custom frontend:** A developer wants to integrate kondi-chat into VS Code. They read `docs/api.md` and see the full JSON-RPC protocol: events, commands, field types. They implement their client and connect.

## Clarifications (2026-04-10)

- **Topic resolution:** Define an alias map and precedence for `/help <topic>`; normalize command vs feature names to avoid ambiguity.
- **Source of truth:** Choose a canonical doc source (generator from protocol definitions vs hand-written) and set regeneration triggers to prevent drift.
- **Embedding:** Decide whether help data is embedded at build time or read from `dist/` at runtime; define fallback order and paths to keep `/help` working after packaging.
- **Asciinema:** Specify hosting, refresh cadence, and fallback behavior when casts fail to render (e.g., link to GIF/PNG fallback).
- **API docs:** Declare one canonical source for `docs/api.md` (e.g., protocol definitions), and ensure other references regenerate from it to avoid competing versions.
## Technical Design

### Documentation structure

```
README.md                    # Quick start (1 page)
docs/
  getting-started.md         # First session walkthrough
  installation.md            # All install methods (points to Spec 16)
  configuration.md           # All config files explained
  routing.md                 # Router architecture + training
  tools.md                   # Every tool with examples
  profiles.md                # Budget profiles, custom profiles
  memory.md                  # KONDI.md memory system (Spec 04)
  permissions.md             # Permission system (Spec 01)
  hooks.md                   # Hooks (Spec 12)
  checkpoints.md             # Undo/checkpoints (Spec 05)
  mcp.md                     # MCP server setup
  council.md                 # Council integration
  web-tools.md               # Web search/fetch (Spec 11)
  non-interactive.md         # CLI/CI usage (Spec 10)
  telemetry.md               # Telemetry disclosure (Spec 15)
  api.md                     # JSON-RPC protocol for custom frontends
  troubleshooting.md         # Common issues + fixes
  architecture.md            # High-level design (dev-facing)
```

### In-app help

The `/help` command supports three forms:

1. `/help` — general help (list of topics)
2. `/help <topic>` — show a specific topic (command, tool, feature)
3. `/help <command>` — show help for a slash command

Help content is embedded in the backend binary (not fetched from docs directory) so it works offline. Content is loaded from a single JSON file at build time:

```json
{
  "commands": {
    "/use": {
      "syntax": "/use <alias> | /use auto",
      "description": "Pin the agent to a specific model or return to auto-routing",
      "examples": ["/use claude", "/use opus", "/use auto"],
      "related": ["/models", "/mode"]
    }
  },
  "tools": { ... },
  "features": { ... }
}
```

### README structure

```markdown
# kondi-chat

Multi-model AI coding CLI with smart routing between Claude, GPT, Gemini, DeepSeek, and local models.

## Install

[30-second install section for each method]

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-...
kondi-chat
```

[screenshot or asciinema recording]

## Features

[one-line bullets for top features, linking to docs/]

## Documentation

[links to docs/]
```

### Asciinema recordings

Key flows recorded as asciinema casts and embedded in README:
- First session (install -> chat -> result)
- Code editing with diff preview
- Multi-model routing in action
- Sub-agent spawning

## Implementation Details

### New files

**`docs/help-content.json`** — Machine-readable help for in-app `/help`:

```json
{
  "version": 1,
  "commands": {
    "/help": {
      "syntax": "/help [topic]",
      "description": "Show help for a topic, command, or tool",
      "examples": ["/help", "/help /use", "/help tools"],
      "related": []
    },
    "/use": { ... },
    "/mode": { ... },
    "/models": { ... }
  },
  "tools": {
    "read_file": {
      "description": "Read the contents of a file",
      "arguments": [
        { "name": "path", "type": "string", "required": true },
        { "name": "max_lines", "type": "number", "required": false, "default": 200 }
      ],
      "example": { "path": "src/auth.ts" }
    }
  },
  "features": {
    "routing": {
      "title": "Smart Routing",
      "summary": "kondi-chat routes each request to the best model",
      "docs": "docs/routing.md"
    }
  }
}
```

**`src/cli/help.ts`**

```typescript
export interface HelpEntry {
  syntax?: string;
  description: string;
  examples?: string[];
  related?: string[];
}

/** Resolve a topic to formatted help text. Returns the topic list when topic is undefined. */
export function getHelp(topic?: string): string;
```

The function loads `help-content.json` once on first call and stores it in a module-level Map. No class. No keyword search. Unknown topics fall back to a Levenshtein closest-match suggestion.

### Modified files

**`src/cli/backend.ts`** — Extend `/help`:

```typescript
case '/help': {
  const topic = parts.slice(1).join(' ').trim();
  return helpSystem.get(topic);
}
```

### Documentation files

Each `docs/*.md` file follows this structure:

1. **Overview** — what and why (1 paragraph)
2. **Quick example** — the 80% use case (code block)
3. **Reference** — all config keys, options, behaviors
4. **Common recipes** — copy-paste examples
5. **Troubleshooting** — common issues specific to this feature
6. **See also** — links to related docs

### Hand-written docs (v1)

All `docs/*.md` files are hand-written. No `scripts/generate-docs.ts`, no CI drift check. The risk of drift is real but manageable: tools and protocol events are added rarely, and a release-checklist line item ("update docs/tools.md") catches the common cases. Auto-generation is a v2 concern if drift becomes painful.

### README

The README is hand-written but includes a generated "table of tools" section that can be updated via the script.

## Protocol Changes

None. Documentation is out-of-band.

## Configuration

None. Documentation is static.

In-app help reads `help-content.json` embedded at build time (via `require` or file-system read from `dist/`).

## Error Handling

| Scenario | Handling |
|----------|----------|
| `/help` on unknown topic | Show list of available topics, suggest closest match via Levenshtein |
| help-content.json missing | Fall back to minimal hard-coded help |
| Auto-generated docs out of sync in CI | Fail the build, print diff, instruct "run scripts/generate-docs.ts" |
| Broken links in docs | CI lint step catches broken internal links |
| Code examples outdated | CI runs example extraction and verifies syntax (TypeScript compile check) |

## Testing Plan

1. **Doc build tests** (CI):
   - `scripts/generate-docs.ts` produces expected output
   - No broken internal links
   - Code examples in docs compile (TypeScript)
   - Markdown lint passes

2. **Help system tests**:
   - `/help` returns list
   - `/help /use` returns specific entry
   - `/help unknown` returns helpful suggestion
   - Search by keyword works

3. **Manual review checklist**:
   - Getting-started walkthrough still works end-to-end
   - Each doc file has all 6 sections
   - Screenshots/recordings are current

## Dependencies

- **Depends on:** All feature specs (docs cover every feature), Spec 16 (Packaging — installation docs)
- **Depended on by:** Nothing technically, but adoption depends on docs

## Estimated Effort

**2.5 days** (revised from 5 days)
- Day 1: README + getting-started + installation + configuration + tools + profiles.
- Day 2: routing + permissions + hooks + memory + checkpoints + non-interactive + mcp + council + web-tools + telemetry + api + troubleshooting (one short page each).
- Day 2.5: In-app help (`help.ts` + `help-content.json`) + asciinema recordings.
