import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { estimateCost, Ledger } from './ledger.ts';
import type { LLMResponse } from '../types.ts';

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe('estimateCost', () => {
  it('uses known pricing for claude-sonnet-4-5', () => {
    // 1000 input @ $3/M + 500 output @ $15/M
    const cost = estimateCost('claude-sonnet-4-5-20250929', 1000, 500);
    expect(cost).toBeCloseTo(0.003 + 0.0075, 6);
  });

  it('uses known pricing for deepseek-chat', () => {
    const cost = estimateCost('deepseek-chat', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.27 + 1.10, 4);
  });

  it('falls back to default pricing for unknown models', () => {
    const cost = estimateCost('unknown-model', 1_000_000, 1_000_000);
    // default: $3/M in, $15/M out
    expect(cost).toBeCloseTo(3 + 15, 4);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost('gpt-4o', 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const fakeResponse = (overrides?: Partial<LLMResponse>): LLMResponse => ({
  content: 'test response',
  model: 'claude-sonnet-4-5-20250929',
  provider: 'anthropic',
  inputTokens: 100,
  outputTokens: 50,
  latencyMs: 500,
  ...overrides,
});

describe('Ledger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kondi-ledger-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records an LLM call and retrieves it', () => {
    const ledger = new Ledger('test-session');
    const entry = ledger.record('discuss', fakeResponse(), 'test prompt');
    expect(entry.phase).toBe('discuss');
    expect(entry.model).toBe('claude-sonnet-4-5-20250929');
    expect(entry.inputTokens).toBe(100);
    expect(entry.costUsd).toBeGreaterThan(0);
    expect(ledger.getAll()).toHaveLength(1);
  });

  it('records verification entries', () => {
    const ledger = new Ledger('test-session');
    const entry = ledger.recordVerification('task-1', true, 'All tests passed');
    expect(entry.phase).toBe('verify');
    expect(entry.taskId).toBe('task-1');
    expect(entry.costUsd).toBe(0);
    expect(entry.inputTokens).toBe(0);
  });

  it('filters by phase', () => {
    const ledger = new Ledger('test-session');
    ledger.record('discuss', fakeResponse(), 'prompt 1');
    ledger.record('execute', fakeResponse(), 'prompt 2');
    ledger.record('discuss', fakeResponse(), 'prompt 3');
    expect(ledger.getByPhase('discuss')).toHaveLength(2);
    expect(ledger.getByPhase('execute')).toHaveLength(1);
    expect(ledger.getByPhase('reflect')).toHaveLength(0);
  });

  it('filters by task', () => {
    const ledger = new Ledger('test-session');
    ledger.record('execute', fakeResponse(), 'prompt', { taskId: 'task-1' });
    ledger.record('execute', fakeResponse(), 'prompt', { taskId: 'task-2' });
    ledger.record('execute', fakeResponse(), 'prompt', { taskId: 'task-1' });
    expect(ledger.getByTask('task-1')).toHaveLength(2);
    expect(ledger.getByTask('task-2')).toHaveLength(1);
  });

  it('computes totals correctly', () => {
    const ledger = new Ledger('test-session');
    ledger.record('discuss', fakeResponse({ inputTokens: 100, outputTokens: 50 }), 'p1');
    ledger.record('execute', fakeResponse({ inputTokens: 200, outputTokens: 100, model: 'gpt-4o' }), 'p2');

    const totals = ledger.getTotals();
    expect(totals.calls).toBe(2);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(150);
    expect(totals.costUsd).toBeGreaterThan(0);
    expect(Object.keys(totals.byPhase)).toContain('discuss');
    expect(Object.keys(totals.byPhase)).toContain('execute');
    expect(Object.keys(totals.byModel)).toContain('claude-sonnet-4-5-20250929');
    expect(Object.keys(totals.byModel)).toContain('gpt-4o');
  });

  it('persists to disk and reloads', () => {
    const sessionId = 'persist-test';
    const ledger1 = new Ledger(sessionId, tempDir);
    ledger1.record('discuss', fakeResponse(), 'prompt 1');
    ledger1.record('execute', fakeResponse(), 'prompt 2');

    const filePath = join(tempDir, `${sessionId}-ledger.json`);
    expect(existsSync(filePath)).toBe(true);

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw).toHaveLength(2);

    // New ledger instance loads from disk
    const ledger2 = new Ledger(sessionId, tempDir);
    expect(ledger2.getAll()).toHaveLength(2);
  });

  it('truncates long prompt/response summaries', () => {
    const ledger = new Ledger('test-session');
    const longPrompt = 'x'.repeat(1000);
    const entry = ledger.record('discuss', fakeResponse({ content: 'y'.repeat(1000) }), longPrompt);
    expect(entry.promptSummary.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(entry.responseSummary.length).toBeLessThanOrEqual(503);
  });

  it('assigns sequential IDs', () => {
    const ledger = new Ledger('test-session');
    const e1 = ledger.record('discuss', fakeResponse(), 'p1');
    const e2 = ledger.record('discuss', fakeResponse(), 'p2');
    expect(e1.id).toContain('0000');
    expect(e2.id).toContain('0001');
  });
});
