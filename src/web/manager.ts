/**
 * Web Tools — web_search and web_fetch backed by Brave Search API.
 *
 * v1: single backend, in-memory LRU cache, reuses the provider rate limiter
 * bucket machinery under a synthetic 'brave' provider. SSRF guards on fetch
 * block localhost and private ranges. HTML is stripped to plain text with
 * a small regex pipeline — not perfect but keeps the dependency surface at
 * zero.
 */

import type { ToolDefinition } from '../types.ts';
import { getRateLimiter } from '../providers/rate-limiter.ts';

const RATE_LIMIT_RPM = 60;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const MAX_FETCH_BYTES = 1_048_576;
const MAX_MARKDOWN_BYTES = 20 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface SearchResult { title: string; url: string; snippet: string; }
export interface FetchResult { url: string; content: string; contentType: string; sizeBytes: number; truncated?: boolean; }

interface CacheEntry { value: unknown; expiresAt: number; }

const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PRIVATE_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  // RFC1918
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  // Link-local
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function htmlToPlain(html: string): string {
  // Strip scripts/styles first, then tags, then collapse whitespace.
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '')
              .replace(/<header[\s\S]*?<\/header>/gi, '');
  // Preserve some structure
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, lvl) => '\n\n' + '#'.repeat(parseInt(lvl)) + ' ')
       .replace(/<\/h[1-6]>/gi, '\n')
       .replace(/<li[^>]*>/gi, '\n- ')
       .replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/p>/gi, '\n\n')
       .replace(/<[^>]+>/g, '');
  // Decode a few common entities
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  if (s.length > MAX_MARKDOWN_BYTES) s = s.slice(0, MAX_MARKDOWN_BYTES) + '\n\n(truncated)';
  return s;
}

export class WebToolsManager {
  private apiKey: string;
  private cache = new Map<string, CacheEntry>();
  private enabled: boolean;

  constructor() {
    this.apiKey = process.env.BRAVE_SEARCH_API_KEY || '';
    this.enabled = this.apiKey !== '';
    // No stderr write: absence of an optional env var is not an error and
    // fires on every single startup. getTools() returns [] when disabled
    // so the agent simply never sees the web tools.
  }

  isEnabled(): boolean { return this.enabled; }

  getTools(): ToolDefinition[] {
    if (!this.enabled) return [];
    return WEB_TOOLS;
  }

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

  async search(query: string, count = 5): Promise<SearchResult[]> {
    if (!this.enabled) throw new Error('web_search disabled: BRAVE_SEARCH_API_KEY not set');
    const key = `search:${query}:${count}`;
    const cached = this.cacheGet<SearchResult[]>(key);
    if (cached) return cached;

    const limiter = getRateLimiter();
    if (limiter) await limiter.acquire('brave', 1);

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': this.apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`brave search ${resp.status}`);
    const data = await resp.json() as any;
    const results: SearchResult[] = (data.web?.results || []).slice(0, count).map((r: any) => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      snippet: String(r.description || ''),
    }));
    this.cacheSet(key, results);
    return results;
  }

  async fetch(url: string): Promise<FetchResult> {
    if (!this.enabled) throw new Error('web_fetch disabled: BRAVE_SEARCH_API_KEY not set (web tools are gated together in v1)');
    const key = `fetch:${url}`;
    const cached = this.cacheGet<FetchResult>(key);
    if (cached) return cached;

    // SSRF guard — re-applied at every redirect hop so a public URL that
    // 302s to 127.0.0.1 (or an RFC1918 host) is blocked on the final target.
    const assertSafe = (candidate: string): URL => {
      let p: URL;
      try { p = new URL(candidate); } catch { throw new Error(`Invalid URL: ${candidate}`); }
      if (p.protocol !== 'https:' && p.protocol !== 'http:') {
        throw new Error(`Unsupported scheme: ${p.protocol}`);
      }
      if (isPrivateHost(p.hostname)) {
        throw new Error(`Blocked private/localhost host: ${p.hostname}`);
      }
      return p;
    };

    let parsed = assertSafe(url);
    let resp: Response;
    let hops = 0;
    while (true) {
      resp = await fetch(parsed.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) throw new Error(`fetch ${resp.status} with no Location header`);
        if (++hops > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
        parsed = assertSafe(new URL(loc, parsed).toString());
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

  async executeTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    try {
      if (name === 'web_search') {
        const query = String(args.query || '');
        if (!query) return { content: 'web_search requires a non-empty query', isError: true };
        const count = (args.count as number) || 5;
        const results = await this.search(query, count);
        if (results.length === 0) return { content: `No results for: ${query}` };
        return {
          content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'),
        };
      }
      if (name === 'web_fetch') {
        const url = String(args.url || '');
        if (!url) return { content: 'web_fetch requires a url', isError: true };
        const r = await this.fetch(url);
        return { content: `${r.url} (${r.contentType})\n\n${r.content}` };
      }
      return { content: `Unknown web tool: ${name}`, isError: true };
    } catch (e) {
      return { content: `Web tool error: ${(e as Error).message}`, isError: true };
    }
  }
}

const WEB_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web via Brave Search. Returns top results with title, URL, and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its main content as plain text. HTML is stripped of scripts/styles/nav. Blocks localhost and private IPs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
      },
      required: ['url'],
    },
  },
];
