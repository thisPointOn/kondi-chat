/**
 * Minimal Mock LLM for tests.
 *
 * Pass a pre-canned queue of LLMResponses; each call dequeues the next.
 * Tests that exercise multi-turn tool loops can enqueue the full sequence.
 */

import type { LLMRequest, LLMResponse } from '../types.ts';

export interface MockLLMOptions {
  responses: Array<Partial<LLMResponse>>;
}

export interface MockLLM {
  call: (req: LLMRequest) => Promise<LLMResponse>;
  calls: LLMRequest[];
}

export function createMockLLM(opts: MockLLMOptions): MockLLM {
  const queue = [...opts.responses];
  const calls: LLMRequest[] = [];
  return {
    calls,
    async call(req: LLMRequest): Promise<LLMResponse> {
      calls.push(req);
      const next = queue.shift();
      if (!next) throw new Error('Mock LLM: no more responses queued');
      return {
        content: next.content ?? '',
        model: next.model ?? req.model ?? 'mock',
        provider: next.provider ?? req.provider ?? 'anthropic',
        inputTokens: next.inputTokens ?? 10,
        outputTokens: next.outputTokens ?? 20,
        latencyMs: next.latencyMs ?? 1,
        toolCalls: next.toolCalls,
      };
    },
  };
}
