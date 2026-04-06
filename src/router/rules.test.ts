import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRegistry } from './registry.ts';
import { RuleRouter } from './rules.ts';

describe('RuleRouter', () => {
  let tempDir: string;
  let registry: ModelRegistry;
  let router: RuleRouter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kondi-router-test-'));
    registry = new ModelRegistry(tempDir);
    router = new RuleRouter(registry);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('routes discuss to reasoning model', () => {
    const decision = router.select('discuss');
    expect(decision.model.capabilities).toContain('reasoning');
    expect(decision.promoted).toBe(false);
  });

  it('routes dispatch to reasoning model', () => {
    const decision = router.select('dispatch');
    expect(decision.model.capabilities).toContain('reasoning');
  });

  it('routes reflect to reasoning model', () => {
    const decision = router.select('reflect');
    expect(decision.model.capabilities).toContain('reasoning');
  });

  it('routes execute to cheapest coding model', () => {
    const decision = router.select('execute', 'implementation');
    expect(decision.model.capabilities.some(c => c === 'coding' || c === 'fast-coding')).toBe(true);
    // Should be cheapest
    const allCoders = registry.getByCapability('coding');
    expect(decision.model.inputCostPer1M).toBe(allCoders[0].inputCostPer1M);
  });

  it('routes compress to cheapest summarization model', () => {
    const decision = router.select('compress');
    expect(decision.reason).toContain('summarization');
  });

  it('routes state_update to cheap model', () => {
    const decision = router.select('state_update');
    expect(decision.reason).toContain('summarization');
  });

  it('promotes execute to best model after failures', () => {
    const normal = router.select('execute', 'implementation', 0);
    const promoted = router.select('execute', 'implementation', 2, 2);
    expect(promoted.promoted).toBe(true);
    expect(promoted.model.inputCostPer1M).toBeGreaterThanOrEqual(normal.model.inputCostPer1M);
  });

  it('routes analysis tasks to reasoning model', () => {
    const decision = router.select('execute', 'analysis');
    expect(decision.model.capabilities.some(c => c === 'analysis' || c === 'reasoning')).toBe(true);
    expect(decision.reason).toContain('analysis');
  });

  it('routes fix tasks to cheapest coder', () => {
    const decision = router.select('execute', 'fix');
    expect(decision.reason).toContain('fix');
  });

  it('handles unknown phases gracefully', () => {
    const decision = router.select('commit' as any);
    expect(decision.model).toBeDefined();
  });
});
