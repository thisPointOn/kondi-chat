import { describe, it, expect } from 'vitest';
import { estimateTokens, ContextBudget } from './budget.ts';

describe('estimateTokens', () => {
  it('returns ~1 token per 4 chars', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokens('')).toBe(0);
  });

  it('handles longer strings', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });
});

describe('ContextBudget', () => {
  it('includes all sections when under budget', () => {
    const budget = new ContextBudget(10_000);
    budget.add('a', 'Section A content', 1, false);
    budget.add('b', 'Section B content', 2, true);
    const result = budget.assemble();
    expect(result).toContain('Section A content');
    expect(result).toContain('Section B content');
    expect(budget.getDropped()).toEqual([]);
    expect(budget.getCompressed()).toEqual([]);
  });

  it('respects priority order (lower number = higher priority)', () => {
    const budget = new ContextBudget(10_000);
    budget.add('low', 'Low priority', 3, true);
    budget.add('high', 'High priority', 1, true);
    budget.add('mid', 'Mid priority', 2, true);
    const result = budget.assemble();
    const highIdx = result.indexOf('High priority');
    const midIdx = result.indexOf('Mid priority');
    const lowIdx = result.indexOf('Low priority');
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('drops sections that exceed budget', () => {
    // Budget of 10 tokens = ~40 chars
    const budget = new ContextBudget(10);
    budget.add('fits', 'Hi', 1, false);
    budget.add('too-big', 'x'.repeat(200), 2, false); // non-compressible, won't fit
    const result = budget.assemble();
    expect(result).toContain('Hi');
    expect(result).not.toContain('x'.repeat(200));
    expect(budget.getDropped()).toContain('too-big');
  });

  it('truncates compressible sections when budget is tight', () => {
    // Budget allows ~1200 chars (300 tokens)
    const budget = new ContextBudget(300);
    budget.add('small', 'Small section', 1, false);
    budget.add('big', 'x'.repeat(2000), 2, true); // compressible, will be truncated
    const result = budget.assemble();
    expect(result).toContain('Small section');
    expect(result).toContain('[... truncated ...]');
    expect(budget.getCompressed()).toContain('big');
  });

  it('skips empty content', () => {
    const budget = new ContextBudget(10_000);
    budget.add('empty', '', 1, false);
    budget.add('whitespace', '   ', 1, false);
    budget.add('real', 'Real content', 2, false);
    const result = budget.assemble();
    expect(result).toBe('Real content');
  });

  it('reports total estimate', () => {
    const budget = new ContextBudget(10_000);
    budget.add('a', 'a'.repeat(40), 1, false); // 10 tokens
    budget.add('b', 'b'.repeat(80), 2, false); // 20 tokens
    expect(budget.getTotalEstimate()).toBe(30);
  });
});
