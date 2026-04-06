import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoutingCollector, type RoutingSample } from './collector.ts';

const makeSample = (overrides?: Partial<RoutingSample>): RoutingSample => ({
  timestamp: new Date().toISOString(),
  phase: 'execute',
  taskKind: 'implementation',
  promptLength: 500,
  contextTokens: 2000,
  failures: 0,
  promoted: false,
  modelId: 'deepseek-chat',
  provider: 'deepseek',
  succeeded: true,
  inputTokens: 2000,
  outputTokens: 1000,
  costUsd: 0.001,
  latencyMs: 1500,
  routeReason: 'cheapest coder',
  ...overrides,
});

describe('RoutingCollector', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kondi-collector-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records and retrieves samples', () => {
    const collector = new RoutingCollector(tempDir);
    collector.record(makeSample());
    collector.record(makeSample({ modelId: 'gpt-4o', provider: 'openai' }));
    expect(collector.getAll()).toHaveLength(2);
  });

  it('persists across instances', () => {
    const c1 = new RoutingCollector(tempDir);
    c1.record(makeSample());
    c1.record(makeSample());

    const c2 = new RoutingCollector(tempDir);
    expect(c2.getAll()).toHaveLength(2);
  });

  it('computes stats correctly', () => {
    const collector = new RoutingCollector(tempDir);
    collector.record(makeSample({ succeeded: true }));
    collector.record(makeSample({ succeeded: false }));
    collector.record(makeSample({ modelId: 'gpt-4o', provider: 'openai', succeeded: true }));

    const stats = collector.getStats();
    expect(stats.totalSamples).toBe(3);
    expect(stats.byModel['deepseek-chat'].total).toBe(2);
    expect(stats.byModel['deepseek-chat'].succeeded).toBe(1);
    expect(stats.byModel['gpt-4o'].total).toBe(1);
    expect(stats.byModel['gpt-4o'].succeeded).toBe(1);
  });

  it('tracks readiness for training', () => {
    const collector = new RoutingCollector(tempDir);

    // Not ready with no data
    expect(collector.getStats().readyForTraining).toBe(false);

    // Not ready with single model
    for (let i = 0; i < 100; i++) {
      collector.record(makeSample());
    }
    expect(collector.getStats().readyForTraining).toBe(false);

    // Ready with multiple models
    collector.record(makeSample({ modelId: 'gpt-4o', provider: 'openai' }));
    expect(collector.getStats().readyForTraining).toBe(true);
  });

  it('tracks stats by phase', () => {
    const collector = new RoutingCollector(tempDir);
    collector.record(makeSample({ phase: 'discuss' }));
    collector.record(makeSample({ phase: 'discuss' }));
    collector.record(makeSample({ phase: 'execute' }));

    const stats = collector.getStats();
    expect(stats.byPhase['discuss'].total).toBe(2);
    expect(stats.byPhase['execute'].total).toBe(1);
  });

  it('exports training data with dynamic features', () => {
    const collector = new RoutingCollector(tempDir);
    collector.record(makeSample({ phase: 'execute', taskKind: 'implementation' }));
    collector.record(makeSample({ phase: 'discuss', taskKind: undefined, modelId: 'gpt-4o' }));
    collector.record(makeSample({ phase: 'execute', taskKind: 'robot-control', succeeded: false }));

    const exported = collector.exportForTraining();
    expect(exported.features).toHaveLength(3);
    expect(exported.modelNames).toContain('deepseek-chat');
    expect(exported.modelNames).toContain('gpt-4o');

    // Feature names should include discovered phases and task kinds
    expect(exported.featureNames.some(f => f === 'phase:execute')).toBe(true);
    expect(exported.featureNames.some(f => f === 'phase:discuss')).toBe(true);
    expect(exported.featureNames.some(f => f === 'kind:robot-control')).toBe(true);
    expect(exported.featureNames.some(f => f === 'kind:implementation')).toBe(true);

    // All feature vectors should be the same length
    const len = exported.features[0].length;
    expect(exported.features.every(f => f.length === len)).toBe(true);
    expect(exported.featureNames.length).toBe(len);
  });
});
