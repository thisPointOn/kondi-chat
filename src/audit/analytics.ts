/**
 * Analytics — aggregated cost and usage data across sessions.
 *
 * Reads all ledger files from .kondi-chat/ and builds summaries
 * by day, model, provider, and phase. Persists a rolling summary
 * so it doesn't have to re-read old files.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerEntry } from '../types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailySummary {
  date: string; // YYYY-MM-DD
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<string, ModelDaySummary>;
  byProvider: Record<string, ProviderDaySummary>;
}

export interface ModelDaySummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ProviderDaySummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  models: string[];
}

export interface AnalyticsSummary {
  period: string;
  days: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Record<string, ModelDaySummary>;
  byProvider: Record<string, ProviderDaySummary>;
  dailyBreakdown: DailySummary[];
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export class Analytics {
  private storageDir: string;
  private summaryPath: string;
  private dailyData: Map<string, DailySummary> = new Map();

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.summaryPath = join(storageDir, 'analytics.json');
    this.load();
  }

  /** Rebuild analytics from all ledger files */
  rebuild(): void {
    this.dailyData.clear();

    const files = readdirSync(this.storageDir)
      .filter(f => f.endsWith('-ledger.json'));

    for (const file of files) {
      try {
        const entries: LedgerEntry[] = JSON.parse(
          readFileSync(join(this.storageDir, file), 'utf-8')
        );
        for (const entry of entries) {
          this.addEntry(entry);
        }
      } catch {
        // Skip corrupt files
      }
    }

    this.save();
  }

  /** Add a single entry (for live updates during a session) */
  addEntry(entry: LedgerEntry): void {
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    let day = this.dailyData.get(date);
    if (!day) {
      day = {
        date,
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        byModel: {},
        byProvider: {},
      };
      this.dailyData.set(date, day);
    }

    day.totalCalls++;
    day.totalInputTokens += entry.inputTokens;
    day.totalOutputTokens += entry.outputTokens;
    day.totalCostUsd += entry.costUsd;

    // By model
    if (!day.byModel[entry.model]) {
      day.byModel[entry.model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    }
    day.byModel[entry.model].calls++;
    day.byModel[entry.model].inputTokens += entry.inputTokens;
    day.byModel[entry.model].outputTokens += entry.outputTokens;
    day.byModel[entry.model].costUsd += entry.costUsd;

    // By provider
    if (!day.byProvider[entry.provider]) {
      day.byProvider[entry.provider] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: [] };
    }
    day.byProvider[entry.provider].calls++;
    day.byProvider[entry.provider].inputTokens += entry.inputTokens;
    day.byProvider[entry.provider].outputTokens += entry.outputTokens;
    day.byProvider[entry.provider].costUsd += entry.costUsd;
    if (!day.byProvider[entry.provider].models.includes(entry.model)) {
      day.byProvider[entry.provider].models.push(entry.model);
    }
  }

  /** Get summary for the last N days (default 30) */
  getSummary(days = 30): AnalyticsSummary {
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 86400000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const filtered = [...this.dailyData.values()]
      .filter(d => d.date >= cutoffStr)
      .sort((a, b) => a.date.localeCompare(b.date));

    const totals: AnalyticsSummary = {
      period: `Last ${days} days`,
      days: filtered.length,
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      byModel: {},
      byProvider: {},
      dailyBreakdown: filtered,
    };

    for (const day of filtered) {
      totals.totalCalls += day.totalCalls;
      totals.totalInputTokens += day.totalInputTokens;
      totals.totalOutputTokens += day.totalOutputTokens;
      totals.totalCostUsd += day.totalCostUsd;

      for (const [model, data] of Object.entries(day.byModel)) {
        if (!totals.byModel[model]) {
          totals.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        }
        totals.byModel[model].calls += data.calls;
        totals.byModel[model].inputTokens += data.inputTokens;
        totals.byModel[model].outputTokens += data.outputTokens;
        totals.byModel[model].costUsd += data.costUsd;
      }

      for (const [provider, data] of Object.entries(day.byProvider)) {
        if (!totals.byProvider[provider]) {
          totals.byProvider[provider] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: [] };
        }
        totals.byProvider[provider].calls += data.calls;
        totals.byProvider[provider].inputTokens += data.inputTokens;
        totals.byProvider[provider].outputTokens += data.outputTokens;
        totals.byProvider[provider].costUsd += data.costUsd;
        for (const m of data.models) {
          if (!totals.byProvider[provider].models.includes(m)) {
            totals.byProvider[provider].models.push(m);
          }
        }
      }
    }

    return totals;
  }

  /** Format for display */
  format(days = 30): string {
    const s = this.getSummary(days);
    if (s.totalCalls === 0) return 'No usage data yet.';

    const lines: string[] = [
      `═══ Usage Analytics (${s.period}) ═══`,
      `Total: ${s.totalCalls} calls | ${s.totalInputTokens.toLocaleString()}in / ${s.totalOutputTokens.toLocaleString()}out | $${s.totalCostUsd.toFixed(4)}`,
      '',
      'By Provider:',
    ];

    for (const [provider, data] of Object.entries(s.byProvider).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
      lines.push(`  ${provider.padEnd(15)} ${data.calls} calls  ${data.inputTokens.toLocaleString().padStart(10)}in  ${data.outputTokens.toLocaleString().padStart(10)}out  $${data.costUsd.toFixed(4)}`);
    }

    lines.push('', 'By Model:');
    for (const [model, data] of Object.entries(s.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
      lines.push(`  ${model.slice(0, 30).padEnd(32)} ${data.calls} calls  ${data.inputTokens.toLocaleString().padStart(10)}in  ${data.outputTokens.toLocaleString().padStart(10)}out  $${data.costUsd.toFixed(4)}`);
    }

    if (s.dailyBreakdown.length > 1) {
      lines.push('', 'Daily:');
      for (const day of s.dailyBreakdown.slice(-7)) { // Last 7 days
        lines.push(`  ${day.date}  ${day.totalCalls} calls  $${day.totalCostUsd.toFixed(4)}`);
      }
      if (s.dailyBreakdown.length > 7) {
        lines.push(`  ... ${s.dailyBreakdown.length - 7} earlier days`);
      }
    }

    return lines.join('\n');
  }

  /** Export all data as JSON */
  exportAll(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      daily: [...this.dailyData.values()].sort((a, b) => a.date.localeCompare(b.date)),
    }, null, 2);
  }

  // ── Persistence ──────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.summaryPath)) {
      this.rebuild();
      return;
    }
    try {
      const data = JSON.parse(readFileSync(this.summaryPath, 'utf-8'));
      for (const day of data.daily || []) {
        this.dailyData.set(day.date, day);
      }
    } catch {
      this.rebuild();
    }
  }

  save(): void {
    writeFileSync(this.summaryPath, JSON.stringify({
      daily: [...this.dailyData.values()].sort((a, b) => a.date.localeCompare(b.date)),
    }, null, 2));
  }
}
