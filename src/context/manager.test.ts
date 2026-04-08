import { describe, it, expect } from 'vitest';
import { ContextManager, createSession } from './manager.ts';
import type { LLMResponse } from '../types.ts';

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('creates a session with correct defaults', () => {
    const session = createSession('anthropic', 'claude-sonnet-4-5-20250929', '/tmp');
    expect(session.id).toBeTruthy();
    expect(session.activeProvider).toBe('anthropic');
    expect(session.activeModel).toBe('claude-sonnet-4-5-20250929');
    expect(session.workingDirectory).toBe('/tmp');
    expect(session.messages).toEqual([]);
    expect(session.tasks).toEqual([]);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
    expect(session.totalCostUsd).toBe(0);
  });

  it('initializes empty session state', () => {
    const session = createSession('openai');
    expect(session.state.goal).toBe('');
    expect(session.state.decisions).toEqual([]);
    expect(session.state.constraints).toEqual([]);
    expect(session.state.currentPlan).toEqual([]);
    expect(session.state.recentFailures).toEqual([]);
    expect(session.state.lastUpdatedAtTurn).toBe(0);
  });

  it('works without optional params', () => {
    const session = createSession('deepseek');
    expect(session.activeProvider).toBe('deepseek');
    expect(session.activeModel).toBeUndefined();
    expect(session.workingDirectory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

const fakeResponse = (content = 'test response'): LLMResponse => ({
  content,
  model: 'claude-sonnet-4-5-20250929',
  provider: 'anthropic',
  inputTokens: 100,
  outputTokens: 50,
  latencyMs: 500,
});

describe('ContextManager', () => {
  it('adds user messages to session', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    cm.addUserMessage('Hello');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('Hello');
    expect(session.messages[0].timestamp).toBeTruthy();
  });

  it('adds assistant messages and tracks tokens', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    cm.addAssistantMessage(fakeResponse('Hi there'));
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(session.messages[0].content).toBe('Hi there');
    expect(session.messages[0].model).toBe('claude-sonnet-4-5-20250929');
    expect(session.totalInputTokens).toBe(100);
    expect(session.totalOutputTokens).toBe(50);
  });

  it('accumulates tokens across multiple messages', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    cm.addAssistantMessage(fakeResponse('r1'));
    cm.addAssistantMessage(fakeResponse('r2'));
    expect(session.totalInputTokens).toBe(200);
    expect(session.totalOutputTokens).toBe(100);
  });

  it('assembles prompt with system prompt and user message', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session, { systemPrompt: 'You are helpful.' });
    cm.addUserMessage('What is 2+2?');
    const { systemPrompt, userMessage } = cm.assemblePrompt();
    expect(systemPrompt).toBe('You are helpful.');
    expect(userMessage).toBe('What is 2+2?');
  });

  it('includes session state in system prompt, not user message', () => {
    const session = createSession('anthropic');
    session.state.goal = 'Build a REST API';
    session.state.decisions = ['Use Express'];
    const cm = new ContextManager(session);
    cm.addUserMessage('Next step?');
    const { systemPrompt, userMessage } = cm.assemblePrompt();
    expect(systemPrompt).toContain('Build a REST API');
    expect(systemPrompt).toContain('Use Express');
    expect(userMessage).toBe('Next step?');
  });

  it('includes grounding context in system prompt', () => {
    const session = createSession('anthropic');
    session.groundingContext = '## Files\nindex.ts: main entry';
    const cm = new ContextManager(session, { contextBudget: 50_000 });
    cm.addUserMessage('What does this project do?');
    const { systemPrompt, cacheablePrefix } = cm.assemblePrompt();
    expect(systemPrompt).toContain('index.ts: main entry');
    expect(cacheablePrefix).toContain('index.ts: main entry');
  });

  it('estimates context size', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    cm.addUserMessage('Hello');
    cm.addAssistantMessage(fakeResponse('Hi there'));
    const size = cm.estimateCurrentContextSize();
    expect(size).toBeGreaterThan(0);
  });

  it('tracks budget status', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session, { modelContextWindow: 100_000 });
    cm.addUserMessage('Hello');
    cm.addAssistantMessage(fakeResponse('Hi'));
    const status = cm.getBudgetStatus();
    expect(status.modelContextWindow).toBe(100_000);
    expect(status.contextUtilization).toBeGreaterThan(0);
    expect(status.contextUtilization).toBeLessThan(1);
    expect(status.compactionCount).toBe(0);
  });

  it('normalizes messages: merges consecutive user messages', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    session.messages.push(
      { role: 'user', content: 'Hello', timestamp: '' },
      { role: 'user', content: 'World', timestamp: '' },
      { role: 'assistant', content: 'Hi', timestamp: '' },
    );
    const normalized = cm.normalizeForAPI(session.messages);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].content).toContain('Hello');
    expect(normalized[0].content).toContain('World');
    expect(normalized[1].role).toBe('assistant');
  });

  it('normalizes messages: strips compact boundaries', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    session.messages.push(
      { role: 'system', content: '[COMPACT_BOUNDARY]\nSummary here', timestamp: '' },
      { role: 'user', content: 'Hello', timestamp: '' },
      { role: 'assistant', content: 'Hi', timestamp: '' },
    );
    const normalized = cm.normalizeForAPI(session.messages);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].role).toBe('user');
  });

  it('normalizes messages: truncates extremely long messages', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    const longContent = 'x'.repeat(100_000);
    session.messages.push(
      { role: 'user', content: longContent, timestamp: '', tokenCount: 25_000 },
    );
    const normalized = cm.normalizeForAPI(session.messages);
    expect(normalized[0].content.length).toBeLessThan(longContent.length);
    expect(normalized[0].content).toContain('[... message truncated ...]');
  });

  it('assembles prompt using messages after compact boundary', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session);
    // Simulate a compacted session
    session.messages.push(
      { role: 'system', content: '[COMPACT_BOUNDARY]\nEarlier we discussed X', timestamp: '' },
      { role: 'user', content: 'Continue with Y', timestamp: '' },
    );
    const { systemPrompt, userMessage } = cm.assemblePrompt();
    expect(systemPrompt).toContain('Earlier we discussed X');
    expect(userMessage).toBe('Continue with Y');
  });
});
