/**
 * Embedding Module — lightweight text embeddings for content-aware routing.
 *
 * Embeds prompts so the router can distinguish "calculate thrust-to-weight
 * ratio" from "fix the CSS layout" even when both are execute/implementation.
 *
 * Backends:
 *   - ollama: local GPU, nomic-embed-text (768D) or any Ollama embedding model
 *   - openai: OpenAI embeddings API (text-embedding-3-small, 1536D)
 *   - compatible: any OpenAI-compatible embedding endpoint
 *
 * Embeddings are cached to disk so we don't re-compute on restart.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  /** Backend type */
  backend: 'ollama' | 'openai' | 'compatible';
  /** Model name (e.g., "nomic-embed-text", "text-embedding-3-small") */
  model: string;
  /** Base URL for the API */
  baseUrl: string;
  /** API key (not needed for Ollama) */
  apiKey?: string;
  /** Expected embedding dimension (for validation) */
  dimension: number;
}

const DEFAULT_CONFIGS: Record<string, EmbeddingConfig> = {
  ollama: {
    backend: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434',
    dimension: 768,
  },
  openai: {
    backend: 'openai',
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    dimension: 1536,
  },
};

// ---------------------------------------------------------------------------
// Embedding Service
// ---------------------------------------------------------------------------

export class EmbeddingService {
  private config: EmbeddingConfig;
  private cache: Map<string, number[]> = new Map();
  private cacheDir: string;
  private cacheFile: string;

  constructor(storageDir: string, config?: Partial<EmbeddingConfig>) {
    // Default to Ollama with nomic-embed-text
    this.config = {
      ...DEFAULT_CONFIGS.ollama,
      ...config,
    };

    this.cacheDir = join(storageDir, 'embeddings');
    this.cacheFile = join(this.cacheDir, 'cache.json');
    mkdirSync(this.cacheDir, { recursive: true });
    this.loadCache();
  }

  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  getDimension(): number {
    return this.config.dimension;
  }

  /**
   * Embed a text string. Returns the embedding vector.
   * Results are cached by content hash.
   */
  async embed(text: string): Promise<number[]> {
    // Truncate very long texts — embedding models have limits
    const truncated = text.slice(0, 8192);
    const hash = this.hash(truncated);

    // Check cache
    const cached = this.cache.get(hash);
    if (cached) return cached;

    // Call embedding API
    const embedding = await this.callApi(truncated);

    // Cache and persist
    this.cache.set(hash, embedding);
    this.saveCache();

    return embedding;
  }

  /**
   * Embed multiple texts in a batch. More efficient than individual calls.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const truncated = texts.map(t => t.slice(0, 8192));
    const results: number[][] = [];
    const uncached: { index: number; text: string }[] = [];

    // Check cache first
    for (let i = 0; i < truncated.length; i++) {
      const hash = this.hash(truncated[i]);
      const cached = this.cache.get(hash);
      if (cached) {
        results[i] = cached;
      } else {
        uncached.push({ index: i, text: truncated[i] });
      }
    }

    // Batch call for uncached
    if (uncached.length > 0) {
      const embeddings = await this.callApiBatch(uncached.map(u => u.text));
      for (let i = 0; i < uncached.length; i++) {
        const hash = this.hash(uncached[i].text);
        this.cache.set(hash, embeddings[i]);
        results[uncached[i].index] = embeddings[i];
      }
      this.saveCache();
    }

    return results;
  }

  /** Check if the embedding backend is reachable. */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const embedding = await this.callApi('test');
      if (embedding.length !== this.config.dimension) {
        return {
          ok: false,
          error: `Expected ${this.config.dimension}D, got ${embedding.length}D`,
        };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Number of cached embeddings. */
  cacheSize(): number {
    return this.cache.size;
  }

  // -------------------------------------------------------------------------
  // API calls
  // -------------------------------------------------------------------------

  private async callApi(text: string): Promise<number[]> {
    const results = await this.callApiBatch([text]);
    return results[0];
  }

  private async callApiBatch(texts: string[]): Promise<number[][]> {
    switch (this.config.backend) {
      case 'ollama':
        return this.callOllama(texts);
      case 'openai':
      case 'compatible':
        return this.callOpenAIEmbeddings(texts);
      default:
        throw new Error(`Unknown embedding backend: ${this.config.backend}`);
    }
  }

  private async callOllama(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch — call individually
    const results: number[][] = [];
    for (const text of texts) {
      const resp = await fetch(`${this.config.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, input: text }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Ollama embedding failed (${resp.status}): ${body.slice(0, 200)}`);
      }

      const data: any = await resp.json();
      const embedding = data.embeddings?.[0];
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Ollama returned invalid embedding format');
      }
      results.push(embedding);
    }
    return results;
  }

  private async callOpenAIEmbeddings(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const resp = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Embedding API failed (${resp.status}): ${body.slice(0, 200)}`);
    }

    const data: any = await resp.json();
    const embeddings = data.data
      ?.sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);

    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error('Embedding API returned wrong number of results');
    }

    return embeddings;
  }

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  private loadCache(): void {
    if (!existsSync(this.cacheFile)) return;
    try {
      const raw = readFileSync(this.cacheFile, 'utf-8');
      const entries: [string, number[]][] = JSON.parse(raw);
      this.cache = new Map(entries);
    } catch {
      this.cache = new Map();
    }
  }

  private saveCache(): void {
    const entries = Array.from(this.cache.entries());
    writeFileSync(this.cacheFile, JSON.stringify(entries));
  }
}
