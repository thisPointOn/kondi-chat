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
    expect(userMessage).toContain('What is 2+2?');
  });

  it('includes session state in assembled prompt when present', () => {
    const session = createSession('anthropic');
    session.state.goal = 'Build a REST API';
    session.state.decisions = ['Use Express'];
    const cm = new ContextManager(session);
    cm.addUserMessage('Next step?');
    const { userMessage } = cm.assemblePrompt();
    expect(userMessage).toContain('Build a REST API');
    expect(userMessage).toContain('Use Express');
  });

  it('includes grounding context when available', () => {
    const session = createSession('anthropic');
    session.groundingContext = '## Files\nindex.ts: main entry';
    const cm = new ContextManager(session, { contextBudget: 50_000 });
    cm.addUserMessage('What does this project do?');
    const { userMessage, cacheablePrefix } = cm.assemblePrompt();
    expect(userMessage).toContain('index.ts: main entry');
    expect(cacheablePrefix).toContain('index.ts: main entry');
  });

  it('respects custom context budget', () => {
    const session = createSession('anthropic');
    const cm = new ContextManager(session, { contextBudget: 500 });
    expect(cm.getConfig().contextBudget).toBe(500);
  });
});
