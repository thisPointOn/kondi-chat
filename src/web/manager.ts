/**
 * Web Tools — web_search and web_fetch, always available.
 *
 * web_search: DuckDuckGo HTML scrape by default (zero config). If
 * BRAVE_SEARCH_API_KEY is set, upgrades to Brave's structured API
 * for better results. Either way the tool is always registered —
 * the model always sees web_search in its tool list.
 *
 * web_fetch: fetches any public URL, strips HTML to readable text.
 * SSRF guards block localhost and private ranges. No API key needed.
 *
 * Both tools work on any machine with Node and an internet connection.
 * No Docker, no MCP server, no external service.
 */

import type { ToolDefinition } from '../types.ts';

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const MAX_FETCH_BYTES = 1_048_576;
const MAX_MARKDOWN_BYTES = 20 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface SearchResult { title: string; url: string; snippet: string; }
export interface FetchResult { url: string; content: string; contentType: string; sizeBytes: number; truncated?: boolean; }

interface CacheEntry { value: unknown; expiresAt: number; }

// ---------------------------------------------------------------------------
// SSRF guards
// ---------------------------------------------------------------------------

const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PRIVATE_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTML processing
// ---------------------------------------------------------------------------

function htmlToPlain(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '')
              .replace(/<header[\s\S]*?<\/header>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, lvl) => '\n\n' + '#'.repeat(parseInt(lvl)) + ' ')
       .replace(/<\/h[1-6]>/gi, '\n')
       .replace(/<li[^>]*>/gi, '\n- ')
       .replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/p>/gi, '\n\n')
       .replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  if (s.length > MAX_MARKDOWN_BYTES) s = s.slice(0, MAX_MARKDOWN_BYTES) + '\n\n(truncated)';
  return s;
}

// ---------------------------------------------------------------------------
// URL safety check (re-applied at every redirect hop)
// ---------------------------------------------------------------------------

function assertSafeUrl(candidate: string): URL {
  let p: URL;
  try { p = new URL(candidate); } catch { throw new Error(`Invalid URL: ${candidate}`); }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') {
    throw new Error(`Unsupported scheme: ${p.protocol}`);
  }
  if (isPrivateHost(p.hostname)) {
    throw new Error(`Blocked private/localhost host: ${p.hostname}`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Web Tools Manager
// ---------------------------------------------------------------------------

export class WebToolsManager {
  private braveKey: string;
  private cache = new Map<string, CacheEntry>();

  constructor() {
    this.braveKey = process.env.BRAVE_SEARCH_API_KEY || '';
  }

  /** Always true — web tools are always available. */
  isEnabled(): boolean { return true; }

  getTools(): ToolDefinition[] { return WEB_TOOLS; }

  // ── Cache ────────────────────────────────────────────────────────────

  private cacheGet<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { this.cache.delete(key); return null; }
    return entry.value as T;
  }

  private cacheSet(key: string, value: unknown): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  // ── Search ───────────────────────────────────────────────────────────

  async search(query: string, count = 5): Promise<SearchResult[]> {
    const key = `search:${query}:${count}`;
    const cached = this.cacheGet<SearchResult[]>(key);
    if (cached) return cached;

    const results = this.braveKey
      ? await this.searchBrave(query, count)
      : await this.searchDuckDuckGo(query, count);

    this.cacheSet(key, results);
    return results;
  }

  /** Brave Search API — structured JSON, better quality, requires API key. */
  private async searchBrave(query: string, count: number): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': this.braveKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Brave search HTTP ${resp.status}`);
    const data = await resp.json() as any;
    return (data.web?.results || []).slice(0, count).map((r: any) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.description || ''),
    }));
  }

  /**
   * DuckDuckGo HTML scrape — zero config, no API key. Fetches the
   * lite/HTML version of DuckDuckGo and parses result links + snippets
   * from the page. Not as structured as Brave but works everywhere
   * with no signup.
   */
  private async searchDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; kondi-chat/0.1)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`DuckDuckGo search HTTP ${resp.status}`);
    const html = await resp.text();

    // Parse result blocks from the DDG HTML lite page.
    // Each result is an <a class="result__a"> with the title/URL,
    // followed by <a class="result__snippet"> with the snippet.
    const results: SearchResult[] = [];
    const resultBlockRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: Array<{ url: string; title: string }> = [];
    let match;
    while ((match = resultBlockRe.exec(html)) !== null) {
      // DDG wraps the real URL in a redirect: /l/?uddg=<encoded_url>&...
      let href = match[1];
      const uddg = href.match(/uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      titles.push({ url: href, title });
    }

    const snippets: string[] = [];
    while ((match = snippetRe.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, '').trim());
    }

    for (let i = 0; i < Math.min(titles.length, count); i++) {
      results.push({
        title: titles[i].title,
        url: titles[i].url,
        snippet: snippets[i] || '',
      });
    }

    return results;
  }

  // ── Fetch ────────────────────────────────────────────────────────────

  async fetch(url: string): Promise<FetchResult> {
    const key = `fetch:${url}`;
    const cached = this.cacheGet<FetchResult>(key);
    if (cached) return cached;

    let parsed = assertSafeUrl(url);
    let resp: Response;
    let hops = 0;
    while (true) {
      resp = await fetch(parsed.toString(), {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kondi-chat/0.1)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) throw new Error(`fetch ${resp.status} with no Location header`);
        if (++hops > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
        parsed = assertSafeUrl(new URL(loc, parsed).toString());
        continue;
      }
      break;
    }
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const contentType = resp.headers.get('content-type') || '';
    const reader = resp.body?.getReader();
    let bytes = new Uint8Array(0);
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_FETCH_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    }
    const raw = new TextDecoder('utf-8').decode(bytes);
    const content = contentType.includes('html') ? htmlToPlain(raw) : raw.slice(0, MAX_MARKDOWN_BYTES);
    const out: FetchResult = {
      url: parsed.toString(),
      content,
      contentType,
      sizeBytes: bytes.byteLength,
      truncated: content.length >= MAX_MARKDOWN_BYTES,
    };
    this.cacheSet(key, out);
    return out;
  }

  // ── Tool executor ────────────────────────────────────────────────────

  async executeTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    try {
      if (name === 'web_search') {
        const query = String(args.query || '');
        if (!query) return { content: 'web_search requires a non-empty query', isError: true };
        const count = (args.count as number) || 5;
        const results = await this.search(query, count);
        if (results.length === 0) return { content: `No results for: ${query}` };
        const backend = this.braveKey ? 'brave' : 'duckduckgo';
        return {
          content: `(via ${backend})\n\n` + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'),
        };
      }
      if (name === 'web_fetch') {
        const url = String(args.url || '');
        if (!url) return { content: 'web_fetch requires a url', isError: true };
        const r = await this.fetch(url);
        return { content: `${r.url} (${r.contentType}, ${r.sizeBytes} bytes)\n\n${r.content}` };
      }
      return { content: `Unknown web tool: ${name}`, isError: true };
    } catch (e) {
      return { content: `Web tool error: ${(e as Error).message}`, isError: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool definitions — always registered, no API key gate
// ---------------------------------------------------------------------------

const WEB_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns top results with title, URL, and snippet. Works out of the box with no API key (uses DuckDuckGo). Set BRAVE_SEARCH_API_KEY for better results via Brave.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Max results (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a web page and extract its readable text content. Strips HTML to clean text. Blocks private/localhost URLs (SSRF protection).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (http or https)' },
      },
      required: ['url'],
    },
  },
];
