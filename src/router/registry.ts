/**
 * Model Registry — catalog of available models and their capabilities.
 *
 * Stored as YAML in .kondi-chat/models.yml, editable by the user
 * and managed via /models commands. The router uses this to know
 * what's available and how much it costs.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '../types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model capabilities are open-ended strings, not a fixed enum.
 * Default capabilities: reasoning, coding, fast-coding, summarization, analysis, general
 * Users can add domain-specific ones: robot-orchestration, image-generation, etc.
 * The router learns which capabilities matter through training data.
 */
export type ModelCapability = string;

export interface ModelEntry {
  /** Unique ID used in API calls (e.g., "claude-sonnet-4-5-20250929") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short alias for @mentions in chat (e.g., "claude", "gpt", "deepseek") */
  alias?: string;
  /** Provider for API routing */
  provider: ProviderId;
  /** What this model is good at — ordered by strength */
  capabilities: ModelCapability[];
  /** Cost per 1M input tokens (USD) */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M: number;
  /** Context window size in tokens */
  contextWindow: number;
  /** Is this model currently enabled? */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Default models
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: ModelEntry[] = [
  // --- Planning & Architecture ---
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    alias: 'opus',
    provider: 'anthropic',
    capabilities: ['planning', 'reasoning', 'architecture', 'analysis'],
    inputCostPer1M: 15,
    outputCostPer1M: 75,
    contextWindow: 200_000,
    enabled: true,
  },
  // --- Open-ended questions & general tasks ---
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    alias: 'gpt',
    provider: 'openai',
    capabilities: ['general', 'reasoning', 'marketing', 'writing', 'coding', 'analysis'],
    inputCostPer1M: 2.5,
    outputCostPer1M: 15,
    contextWindow: 1_000_000,
    enabled: true,
  },
  // --- Mid-tier OpenAI ---
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    alias: 'mini',
    provider: 'openai',
    capabilities: ['general', 'marketing', 'writing', 'fast-coding'],
    inputCostPer1M: 0.75,
    outputCostPer1M: 4.5,
    contextWindow: 400_000,
    enabled: true,
  },
  // --- Cheap OpenAI ---
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    alias: 'nano',
    provider: 'openai',
    capabilities: ['summarization', 'fast-coding', 'general'],
    inputCostPer1M: 0.20,
    outputCostPer1M: 1.25,
    contextWindow: 400_000,
    enabled: true,
  },
  // --- Code generation ---
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    alias: 'deep',
    provider: 'deepseek',
    capabilities: ['coding', 'fast-coding', 'refactoring'],
    inputCostPer1M: 0.27,
    outputCostPer1M: 1.10,
    contextWindow: 128_000,
    enabled: true,
  },
  // --- Code review & analysis ---
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    alias: 'claude',
    provider: 'anthropic',
    capabilities: ['code-review', 'analysis', 'reasoning', 'coding'],
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    contextWindow: 200_000,
    enabled: true,
  },
  // --- Summaries, compression, state updates ---
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    alias: 'haiku',
    provider: 'anthropic',
    capabilities: ['summarization', 'fast-coding', 'general'],
    inputCostPer1M: 0.8,
    outputCostPer1M: 4,
    contextWindow: 200_000,
    enabled: true,
  },
  // --- Local models (Ollama) ---
  {
    id: 'qwen2.5:3b',
    name: 'Qwen 2.5 3B',
    alias: 'qwen',
    provider: 'ollama',
    capabilities: ['general', 'fast-coding'],
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    contextWindow: 32_000,
    enabled: true,
  },
  {
    id: 'phi3.5',
    name: 'Phi 3.5',
    alias: 'phi',
    provider: 'ollama',
    capabilities: ['summarization', 'general', 'fast-coding'],
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    contextWindow: 128_000,
    enabled: true,
  },
  {
    id: 'nemotron-3-nano:4b',
    name: 'Nemotron 3 Nano 4B',
    alias: 'nemo',
    provider: 'ollama',
    capabilities: ['reasoning', 'general', 'fast-coding'],
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    contextWindow: 256_000,
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ModelStatus = 'unknown' | 'available' | 'unavailable';

export class ModelRegistry {
  private models: ModelEntry[] = [];
  private configPath: string;
  /** Runtime availability — not persisted, checked on demand */
  private statusMap: Map<string, { status: ModelStatus; error?: string }> = new Map();

  constructor(storageDir: string) {
    this.configPath = join(storageDir, 'models.yml');
    this.load();
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getAll(): ModelEntry[] {
    return [...this.models];
  }

  getEnabled(): ModelEntry[] {
    return this.models.filter(m => m.enabled);
  }

  /** Get models that are enabled AND confirmed available */
  getAvailable(): ModelEntry[] {
    return this.models.filter(m =>
      m.enabled && this.getStatus(m.id).status !== 'unavailable'
    );
  }

  /** Get the runtime status of a model */
  getStatus(id: string): { status: ModelStatus; error?: string } {
    return this.statusMap.get(id) || { status: 'unknown' };
  }

  getById(id: string): ModelEntry | undefined {
    return this.models.find(m => m.id === id);
  }

  /** Find a model by its @mention alias (case-insensitive) */
  getByAlias(alias: string): ModelEntry | undefined {
    const lower = alias.toLowerCase();
    return this.models.find(m => m.alias?.toLowerCase() === lower && m.enabled);
  }

  /** Get all known aliases for display */
  getAliases(): string[] {
    return this.getEnabled()
      .filter(m => m.alias)
      .map(m => m.alias!);
  }

  /** Get models that have a given capability, sorted by cost (cheapest first). Excludes unavailable models. */
  getByCapability(capability: ModelCapability): ModelEntry[] {
    return this.getAvailable()
      .filter(m => m.capabilities.includes(capability))
      .sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);
  }

  /** Get the cheapest enabled model with a given capability */
  getCheapest(capability: ModelCapability): ModelEntry | undefined {
    return this.getByCapability(capability)[0];
  }

  /** Get the most capable (most expensive) enabled model with a given capability */
  getBest(capability: ModelCapability): ModelEntry | undefined {
    const models = this.getByCapability(capability);
    return models[models.length - 1];
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  add(entry: ModelEntry): void {
    const existing = this.models.findIndex(m => m.id === entry.id);
    if (existing >= 0) {
      this.models[existing] = entry;
    } else {
      this.models.push(entry);
    }
    this.save();
  }

  remove(id: string): boolean {
    const before = this.models.length;
    this.models = this.models.filter(m => m.id !== id);
    if (this.models.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  enable(id: string): boolean {
    const model = this.models.find(m => m.id === id);
    if (model) {
      model.enabled = true;
      this.save();
      return true;
    }
    return false;
  }

  disable(id: string): boolean {
    const model = this.models.find(m => m.id === id);
    if (model) {
      model.enabled = false;
      this.save();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Health checks
  // -------------------------------------------------------------------------

  /**
   * Check availability of all enabled models.
   * - Ollama: check if model is pulled locally
   * - Cloud providers: check if API key is set
   */
  async checkHealth(): Promise<Map<string, { status: ModelStatus; error?: string }>> {
    const enabled = this.getEnabled();

    // Check Ollama models in one call
    const ollamaModels = await this.getOllamaModels();

    // Check each model
    for (const m of enabled) {
      if (m.provider === 'ollama') {
        if (ollamaModels === null) {
          this.statusMap.set(m.id, { status: 'unavailable', error: 'Ollama not running' });
        } else if (ollamaModels.has(m.id) || ollamaModels.has(m.id.split(':')[0])) {
          this.statusMap.set(m.id, { status: 'available' });
        } else {
          this.statusMap.set(m.id, { status: 'unavailable', error: `Not pulled. Run: ollama pull ${m.id}` });
        }
      } else {
        // Cloud provider — check for API key
        const key = this.getApiKeyFor(m.provider);
        if (key) {
          this.statusMap.set(m.id, { status: 'available' });
        } else {
          const envVar = this.getEnvVarFor(m.provider);
          this.statusMap.set(m.id, { status: 'unavailable', error: `No API key. Set ${envVar}` });
        }
      }
    }

    return this.statusMap;
  }

  private async getOllamaModels(): Promise<Set<string> | null> {
    try {
      const resp = await fetch('http://localhost:11434/api/tags', {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      const names = new Set<string>();
      for (const m of data.models || []) {
        names.add(m.name);
        // Also add without tag (e.g., "phi3.5" from "phi3.5:3.8b")
        const base = m.name.split(':')[0];
        names.add(base);
      }
      return names;
    } catch {
      return null;
    }
  }

  private getApiKeyFor(provider: ProviderId): string | undefined {
    switch (provider) {
      case 'anthropic': return process.env.ANTHROPIC_API_KEY;
      case 'openai': return process.env.OPENAI_API_KEY;
      case 'deepseek': return process.env.DEEPSEEK_API_KEY;
      case 'xai': return process.env.XAI_API_KEY;
      case 'google': return process.env.GOOGLE_API_KEY;
      case 'nvidia-router': return process.env.NVIDIA_API_KEY;
      default: return undefined;
    }
  }

  private getEnvVarFor(provider: ProviderId): string {
    const vars: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      xai: 'XAI_API_KEY',
      google: 'GOOGLE_API_KEY',
      'nvidia-router': 'NVIDIA_API_KEY',
    };
    return vars[provider] || 'API_KEY';
  }

  /** Format health check results for display */
  formatHealth(): string {
    const lines: string[] = ['Model Health:'];
    const enabled = this.getEnabled();

    for (const m of enabled) {
      const s = this.getStatus(m.id);
      const icon = s.status === 'available' ? 'OK' : s.status === 'unavailable' ? 'FAIL' : '??';
      const alias = m.alias ? ` @${m.alias}` : '';
      const error = s.error ? ` — ${s.error}` : '';
      lines.push(`  [${icon.padEnd(4)}] ${m.name}${alias} (${m.provider})${error}`);
    }

    const available = enabled.filter(m => this.getStatus(m.id).status === 'available').length;
    const unavailable = enabled.filter(m => this.getStatus(m.id).status === 'unavailable').length;
    lines.push('');
    lines.push(`${available} available, ${unavailable} unavailable, ${enabled.length - available - unavailable} unchecked`);

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Persistence — simple YAML-like format
  // -------------------------------------------------------------------------

  private load(): void {
    if (!existsSync(this.configPath)) {
      this.models = [...DEFAULT_MODELS];
      this.save();
      return;
    }

    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      this.models = JSON.parse(raw);
    } catch {
      this.models = [...DEFAULT_MODELS];
      this.save();
    }
  }

  private save(): void {
    writeFileSync(this.configPath, JSON.stringify(this.models, null, 2));
  }

  /** Format for display */
  format(): string {
    const lines: string[] = [];
    const enabled = this.getEnabled();
    const disabled = this.models.filter(m => !m.enabled);

    if (enabled.length > 0) {
      lines.push('Enabled models:');
      for (const m of enabled) {
        const alias = m.alias ? `@${m.alias}` : '(no alias)';
        lines.push('');
        lines.push(`  ${m.name} ${alias}`);
        lines.push(`    ID:           ${m.id}`);
        lines.push(`    Provider:     ${m.provider}`);
        lines.push(`    Capabilities: ${m.capabilities.join(', ')}`);
        lines.push(`    Cost:         $${m.inputCostPer1M.toFixed(2)} in / $${m.outputCostPer1M.toFixed(2)} out per 1M tokens`);
        lines.push(`    Context:      ${(m.contextWindow / 1000).toFixed(0)}K tokens`);
      }
    }

    if (disabled.length > 0) {
      lines.push('');
      lines.push('Disabled:');
      for (const m of disabled) {
        lines.push(`  ${m.name} — ${m.id} (${m.provider})`);
      }
    }

    return lines.join('\n');
  }
}
