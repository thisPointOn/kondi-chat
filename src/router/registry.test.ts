import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRegistry, type ModelEntry } from './registry.ts';

describe('ModelRegistry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kondi-registry-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes with default models', () => {
    const registry = new ModelRegistry(tempDir);
    const all = registry.getAll();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some(m => m.provider === 'anthropic')).toBe(true);
    expect(all.some(m => m.provider === 'deepseek')).toBe(true);
  });

  it('persists and reloads', () => {
    const r1 = new ModelRegistry(tempDir);
    const count = r1.getAll().length;
    const r2 = new ModelRegistry(tempDir);
    expect(r2.getAll().length).toBe(count);
  });

  it('filters enabled models', () => {
    const registry = new ModelRegistry(tempDir);
    const all = registry.getAll();
    const enabled = registry.getEnabled();
    expect(enabled.length).toBeLessThanOrEqual(all.length);
    expect(enabled.every(m => m.enabled)).toBe(true);
  });

  it('finds by capability', () => {
    const registry = new ModelRegistry(tempDir);
    const coders = registry.getByCapability('coding');
    expect(coders.length).toBeGreaterThan(0);
    expect(coders.every(m => m.capabilities.includes('coding'))).toBe(true);
    // Should be sorted by cost (cheapest first)
    for (let i = 1; i < coders.length; i++) {
      expect(coders[i].inputCostPer1M).toBeGreaterThanOrEqual(coders[i - 1].inputCostPer1M);
    }
  });

  it('getCheapest returns lowest cost model with capability', () => {
    const registry = new ModelRegistry(tempDir);
    const cheapest = registry.getCheapest('coding');
    expect(cheapest).toBeDefined();
    const all = registry.getByCapability('coding');
    expect(cheapest!.inputCostPer1M).toBe(all[0].inputCostPer1M);
  });

  it('getBest returns highest cost model with capability', () => {
    const registry = new ModelRegistry(tempDir);
    const best = registry.getBest('reasoning');
    expect(best).toBeDefined();
    const all = registry.getByCapability('reasoning');
    expect(best!.inputCostPer1M).toBe(all[all.length - 1].inputCostPer1M);
  });

  it('adds and removes models', () => {
    const registry = new ModelRegistry(tempDir);
    const before = registry.getAll().length;

    registry.add({
      id: 'test-model',
      name: 'Test',
      provider: 'ollama',
      capabilities: ['coding', 'robot-orchestration'],
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      contextWindow: 32_000,
      enabled: true,
    });
    expect(registry.getAll().length).toBe(before + 1);
    expect(registry.getById('test-model')).toBeDefined();
    expect(registry.getByCapability('robot-orchestration')).toHaveLength(1);

    registry.remove('test-model');
    expect(registry.getAll().length).toBe(before);
  });

  it('enables and disables models', () => {
    const registry = new ModelRegistry(tempDir);
    const model = registry.getEnabled()[0];

    registry.disable(model.id);
    expect(registry.getById(model.id)!.enabled).toBe(false);
    expect(registry.getEnabled().every(m => m.id !== model.id)).toBe(true);

    registry.enable(model.id);
    expect(registry.getById(model.id)!.enabled).toBe(true);
  });

  it('supports custom capabilities', () => {
    const registry = new ModelRegistry(tempDir);
    registry.add({
      id: 'ros-model',
      name: 'ROS Bot',
      provider: 'ollama',
      capabilities: ['robot-orchestration', 'autonomous-navigation'],
      inputCostPer1M: 0,
      outputCostPer1M: 0,
      contextWindow: 32_000,
      enabled: true,
    });
    expect(registry.getByCapability('robot-orchestration')).toHaveLength(1);
    expect(registry.getByCapability('autonomous-navigation')).toHaveLength(1);
    expect(registry.getByCapability('nonexistent')).toHaveLength(0);
  });
});
