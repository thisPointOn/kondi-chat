# 11 — Web Tools

## Product Description

Web Tools gives the agent `web_search` and `web_fetch` tools for looking up current documentation, API references, error messages, and general web content. Results are cached, rate-limited, and converted from HTML to clean markdown. Multiple search backends are supported (Brave Search API, SerpAPI, Ollama web search) and selected via config.

**Why it matters:** Static training data goes stale. Documentation changes, APIs evolve, and new libraries appear. Web access lets the agent look up current information instead of confidently producing outdated code. For error messages, a quick search often finds the exact fix faster than reasoning from first principles.

**Revised 2026-04-10 (simplification pass):** v1 ships with **one backend: Brave Search**. SerpAPI / Ollama web search / DuckDuckGo scraping are deferred to v2 — adding them is a ~30-line function each, not a foundational feature. Disk cache deleted (in-memory LRU only, survives one process). Separate `src/web/rate-limiter.ts` deleted — reuse the `TokenBucket` class from Spec 14 (`src/providers/rate-limiter.ts`). `htmlToMarkdown` returns a plain string instead of a structured `{title, content, links}`. Effort dropped from 4 days to 2 days.

## User Stories

1. **Lookup current docs:** The agent encounters a new version of a library. It calls `web_search("nextjs 15 app router metadata")` and gets the top 5 results. It then calls `web_fetch` on the most relevant one and reads the current documentation.

2. **Error resolution:** A build fails with an obscure error. The agent calls `web_search("TypeError Cannot read properties of undefined next-auth v5")` and finds a GitHub issue with the fix. It applies the fix from the issue.

3. **Cached search:** The agent searches for "react 19 server components" twice in a session. The second call hits the cache and returns instantly without a new API call.

4. **Rate-limited backend:** The user has set their Brave Search API limit to 10 queries per minute. The 11th query in a minute is queued and runs when the window opens. The agent sees a brief delay but no error.

5. **HTML to markdown conversion:** The agent fetches a GitHub README page. The HTML (with nav, sidebars, ads) is extracted to clean markdown containing just the main content. The agent sees a readable 5 KB markdown instead of a 200 KB HTML blob.

## Clarifications (2026-04-10)

- **SSRF safeguards:** `web_fetch` must block localhost, RFC1918, link-local, and `.local`/`.internal` hostnames, and must reject/abort on redirects to those ranges. No raw file:// or other schemes.
- **Backend selection:** If a `backend` is configured, use it exclusively and fail closed on errors (do not silently fall through). If set to `auto`, apply an explicit priority list and log which backend was chosen.
- **Cache bounds:** disk cache under `.kondi-chat/web-cache/` must have a configurable max size and per-user separation; strip query params from cache keys only when safe; avoid caching secrets in URLs.
- **Rate limiting:** queues must have a max length and a wait timeout (surfaced as an error). Waiting requests should be cancelable if the agent turn ends.
- **Tool schemas:** define `web_search` result `{ query, backend, results: [{ title, url, snippet, score? }] }` and `web_fetch` result `{ url, backend, status, content, content_type, truncated?: bool }`.
## Technical Design

### Architecture

```
Agent calls web_search or web_fetch
        │
        v
┌─────────────────────────────┐
│ WebToolsManager             │
│                             │
│  RateLimiter                │
│   - per-backend quotas      │
│                             │
│  Cache (in-memory + disk)   │
│   - key: search query / URL │
│   - TTL: 1 hour default     │
│                             │
│  Backend (configured)       │
│   - Brave Search API        │
│   - SerpAPI                 │
│   - Ollama web search       │
│                             │
│  HtmlExtractor              │
│   - readability-like        │
│   - HTML -> Markdown        │
└─────────────────────────────┘
        │
        v
Tool result with content
```

### Search backend (v1)

| Backend | Env var | Notes |
|---------|---------|-------|
| `brave` | `BRAVE_SEARCH_API_KEY` | Free tier: 2000/month |

v1 ships with Brave only. If `BRAVE_SEARCH_API_KEY` is missing, `web_search` is not registered and a one-line notice is printed to stderr on startup. SerpAPI / Ollama / DuckDuckGo adapters can be added under a `backends/` subdirectory when there is concrete demand.

### HTML extraction

Uses a readability-style algorithm:
1. Parse HTML into a DOM (via `htmlparser2` or equivalent)
2. Score elements based on content density, tag type, class names
3. Extract the main content element
4. Convert to markdown (headers, lists, links, code blocks preserved)
5. Strip nav, footer, sidebars, scripts, styles

Target size: 5-20 KB of markdown per page. Longer pages are truncated with a "(truncated)" marker.

## Implementation Details

### New files

**`src/web/manager.ts`**

```typescript
import type { ToolDefinition } from '../types.ts';

const RATE_LIMIT_RPM = 60;
const CACHE_TTL_MS = 3_600_000;
const CACHE_MAX_ENTRIES = 100;
const MAX_FETCH_BYTES = 1_048_576;

export interface SearchResult { title: string; url: string; snippet: string; }
export interface FetchResult { url: string; content: string; contentType: string; sizeBytes: number; }

export class WebToolsManager {
  constructor(apiKey: string);

  async search(query: string, count?: number): Promise<SearchResult[]>;
  async fetch(url: string): Promise<FetchResult>;

  getTools(): ToolDefinition[];
  async executeTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
}
```

**`src/web/extractor.ts`**

```typescript
/** Extract main content from HTML and convert to a markdown string. Uses htmlparser2 with a small readability heuristic. */
export function htmlToMarkdown(html: string, baseUrl?: string): string;
```

Rate limiting piggybacks on Spec 14's `TokenBucket` (`src/providers/rate-limiter.ts`) — `WebToolsManager` constructs one with `RATE_LIMIT_RPM`.

### Tool definitions

Added to `WebToolsManager.getTools()`:

```typescript
const WEB_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web for current information (documentation, APIs, errors, articles). Returns top results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        count: { type: 'number', description: 'Number of results (default: 5, max: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and extract its main content as markdown. Use after web_search to read promising results, or directly on known URLs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch (must be http or https)' },
      },
      required: ['url'],
    },
  },
];
```

### Modified files

**`src/cli/backend.ts`** — Initialize and register:

```typescript
import { WebToolsManager } from '../web/manager.ts';

const webConfig = loadWebConfig(storageDir);  // Read from config + env
const webTools = new WebToolsManager(webConfig, join(storageDir, 'web-cache'));

// Register each web tool with ToolManager. The executor signature is
// (args, toolCtx) => Promise<{ content, isError? }> per ToolManager.registerTool.
for (const tool of webTools.getTools()) {
  toolManager.registerTool(tool, async (args, _toolCtx) => webTools.executeTool(tool.name, args));
}
```

**Revised:** `ToolManager.registerTool` takes `(args, toolCtx) => ...`, not `(args) => ...`. Also, web tools should respect cancellation when the agent turn ends (per 2026-04-10 clarification), which requires threading an `AbortSignal` through `toolCtx`. Current `ToolContext` has no abort signal; punting to a future extension, but web fetches should at minimum honor a wall-clock timeout.

**`src/mcp/tool-manager.ts`** — Add categories:

```typescript
const BUILTIN_CATEGORIES: Record<string, string[]> = {
  // ... existing
  web_search: ['web', 'analysis'],
  web_fetch: ['web', 'analysis'],
};

const PHASE_TOOLS: Record<string, string[]> = {
  discuss: ['filesystem', 'coding', 'analysis', 'planning', 'system', 'web'],
  // ...
};
```

### Backend adapters

Implementation sketches for each backend:

**Brave Search:**

```typescript
private async braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': this.config.apiKey!, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  const data = await res.json() as any;
  return (data.web?.results || []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    publishedAt: r.age,
  }));
}
```

Similar adapters for SerpAPI, Ollama, DuckDuckGo.

### Permission integration

Both `web_search` and `web_fetch` default to the `confirm` permission tier because they make external network calls with agent-chosen inputs. Users can override in `.kondi-chat/permissions.json`:

```json
{
  "tools": {
    "web_search": "auto-approve",
    "web_fetch": "confirm"
  }
}
```

The confirmation dialog for `web_fetch` shows the URL the agent wants to fetch, so the user can catch accidental or suspicious URLs before the call is made.

### Caching

**In-memory LRU only:** `Map` with `CACHE_MAX_ENTRIES` cap, `CACHE_TTL_MS` expiration per entry. LRU eviction on overflow. No disk cache. **Revised:** disk cache removed — it was extra complexity for a one-line win (cache hits across restarts of a tool nobody restarts often).

Cache keys: `search:<query>:<count>` and `fetch:<normalized-url>`.

## Protocol Changes

None required. Web tools use the standard tool execution protocol. Optionally, the backend can emit richer `activity` events for web calls:

```json
{
  "type": "activity",
  "text": "web_search: 'react 19 features' [brave]",
  "activity_type": "web"
}
```

## Configuration

No `.kondi-chat/web.json`. Only env var: `BRAVE_SEARCH_API_KEY`. All other knobs are constants in `manager.ts`. **Revised:** config file deleted.

## Error Handling

| Scenario | Handling |
|----------|----------|
| No backend configured | Tool not registered; web_search returns "No search backend configured" |
| API key missing | Error at tool call: "Missing API key for backend X. Set env var Y." |
| Rate limit from upstream | Respect `Retry-After` header, queue the request |
| HTML fetch >1 MB | Truncate to maxFetchBytes, add "(truncated)" notice |
| HTML parse failure | Fall back to raw text extraction |
| SSL/TLS error | Error to agent, include URL |
| 4xx/5xx responses | Error to agent with status code and response body preview |
| Timeout (default 15s) | Error: "Fetch timeout" |
| robots.txt disallow | Optional: honor via config flag `respectRobots` (default true) |
| Non-HTML content (PDF, image) | For PDFs: extract text if possible; for images: "Non-text content, 234 KB image" |

## Testing Plan

1. **Unit tests** (`src/web/*.test.ts`):
   - Each backend adapter with mocked fetch
   - HTML extraction on fixture pages (GitHub README, MDN docs, Stack Overflow)
   - Cache get/set/expiration
   - Rate limiter token bucket math
   - URL normalization (for cache keys)

2. **Integration tests**:
   - Tool registration with ToolManager
   - Full search -> fetch flow on mocked backend
   - Cache persistence across process restarts

3. **E2E tests** (opt-in, hits real APIs):
   - Real Brave Search call returns valid results
   - Real URL fetch returns clean markdown

## Dependencies

- **Depends on:** `src/mcp/tool-manager.ts` (tool registration)
- **Depended on by:** Spec 07 (Sub-agents — research sub-agents use web tools), Spec 14 (Rate Limiting — web rate limits integrate with global rate limit system)
- **External:** API keys for search backends (user-provided)
- **Library choices:** `htmlparser2` (small, fast) for HTML parsing; no heavy Cheerio dependency

## Estimated Effort

**2 days** (revised from 4 days)
- Day 1: `WebToolsManager` with Brave adapter, in-memory LRU cache, `TokenBucket` reuse from Spec 14, SSRF guards, `web_search` and `web_fetch` tools.
- Day 2: `htmlToMarkdown` with htmlparser2 + small readability heuristic, tool registration, smoke tests on fixture HTML.
