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
    provider: 'anthropic',
    capabilities: ['planning', 'reasoning', 'architecture', 'analysis'],
    inputCostPer1M: 15,
    outputCostPer1M: 75,
    contextWindow: 200_000,
    enabled: true,
  },
  // --- Open-ended questions & general tasks ---
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['general', 'reasoning', 'marketing', 'writing'],
    inputCostPer1M: 2.5,
    outputCostPer1M: 10,
    contextWindow: 128_000,
    enabled: true,
  },
  // --- Marketing & creative ---
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    capabilities: ['marketing', 'writing', 'general', 'fast-coding'],
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
    contextWindow: 128_000,
    enabled: true,
  },
  // --- Code generation ---
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'deepseek',
    capabilities: ['coding', 'fast-coding', 'refactoring'],
    inputCostPer1M: 0.14,
    outputCostPer1M: 0.28,
    contextWindow: 128_000,
    enabled: true,
  },
  // --- Code review & analysis ---
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
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
    provider: 'anthropic',
    capabilities: ['summarization', 'fast-coding', 'general'],
    inputCostPer1M: 0.8,
    outputCostPer1M: 4,
    contextWindow: 200_000,
    enabled: true,
  },
  // --- Local models (Ollama) ---
  {
    id: 'qwen2.5-coder:32b',
    name: 'Qwen 2.5 Coder 32B',
    provider: 'ollama',
    capabilities: ['coding', 'fast-coding', 'refactoring'],
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    contextWindow: 128_000,
    enabled: true,
  },
  {
    id: 'qwen2.5:14b',
    name: 'Qwen 2.5 14B',
    provider: 'ollama',
    capabilities: ['general', 'reasoning'],
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    contextWindow: 128_000,
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  private models: ModelEntry[] = [];
  private configPath: string;

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

  getById(id: string): ModelEntry | undefined {
    return this.models.find(m => m.id === id);
  }

  /** Get models that have a given capability, sorted by cost (cheapest first) */
  getByCapability(capability: ModelCapability): ModelEntry[] {
    return this.getEnabled()
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
        lines.push(
          `  ${m.id.padEnd(35)} ${m.provider.padEnd(12)} ` +
          `$${m.inputCostPer1M.toFixed(2)}/$${m.outputCostPer1M.toFixed(2)} per 1M  ` +
          `[${m.capabilities.join(', ')}]`
        );
      }
    }

    if (disabled.length > 0) {
      lines.push('Disabled:');
      for (const m of disabled) {
        lines.push(`  ${m.id.padEnd(35)} ${m.provider.padEnd(12)} (disabled)`);
      }
    }

    return lines.join('\n');
  }
}
