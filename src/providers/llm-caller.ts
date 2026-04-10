/**
 * Multi-provider LLM caller — direct HTTP, no SDKs.
 *
 * Supports:
 * - Simple single-turn (systemPrompt + userMessage)
 * - Multi-turn with tool use (messages array + tools)
 * - Anthropic, OpenAI-compatible, and Gemini providers
 */

import type {
  ProviderId, LLMRequest, LLMResponse,
  ToolDefinition, ToolCall, LLMMessage,
} from '../types.ts';

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

async function* parseSSE(resp: Response): AsyncGenerator<{ type?: string; data?: any }> {
  const reader = resp.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let eventType: string | undefined;
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
          // Blank line = end of SSE event
          if (dataLines.length > 0) {
            const joined = dataLines.join('\n');
            let parsed: any;
            try {
              parsed = JSON.parse(joined);
            } catch {
              parsed = joined;
            }
            yield { type: eventType, data: parsed };
          }
          eventType = undefined;
          dataLines = [];
        } else if (trimmed.startsWith('event:') || trimmed.startsWith('event :')) {
          eventType = trimmed.replace(/^event\s*:\s*/, '');
        } else if (trimmed.startsWith('data:') || trimmed.startsWith('data :')) {
          const raw = trimmed.replace(/^data\s*:\s*/, '');
          if (raw === '[DONE]') continue;
          dataLines.push(raw);
        }
        // Ignore other lines (comments starting with :, id:, retry:, etc.)
      }
    }

    // Flush any remaining event at end of stream
    if (dataLines.length > 0) {
      const joined = dataLines.join('\n');
      let parsed: any;
      try {
        parsed = JSON.parse(joined);
      } catch {
        parsed = joined;
      }
      yield { type: eventType, data: parsed };
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Default models per provider
// ---------------------------------------------------------------------------

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  'anthropic': 'claude-sonnet-4-5-20250929',
  'openai': 'gpt-4o',
  'deepseek': 'deepseek-chat',
  'google': 'models/gemini-2.5-flash',
  'xai': 'grok-3',
  'ollama': 'llama3.1',
  'nvidia-router': 'auto',
};

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function getApiKey(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'anthropic': return process.env.ANTHROPIC_API_KEY;
    case 'openai': return process.env.OPENAI_API_KEY;
    case 'deepseek': return process.env.DEEPSEEK_API_KEY;
    case 'xai': return process.env.XAI_API_KEY;
    case 'google': return process.env.GOOGLE_API_KEY;
    case 'nvidia-router': return process.env.NVIDIA_API_KEY;
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic(
  apiKey: string,
  model: string,
  req: LLMRequest,
): Promise<LLMResponse> {
  const start = Date.now();

  const systemContent: Array<{ type: string; text: string; cache_control?: { type: string } }> = [];
  if (req.cacheablePrefix) {
    systemContent.push({
      type: 'text',
      text: req.cacheablePrefix,
      cache_control: { type: 'ephemeral' },
    });
  }
  systemContent.push({ type: 'text', text: req.systemPrompt });

  let messages: any[];
  if (req.messages) {
    messages = anthropicMessages(req.messages);
  } else {
    messages = [{ role: 'user', content: req.userMessage || '' }];
  }

  const tools = req.tools?.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const body: any = {
    model,
    max_tokens: req.maxOutputTokens ?? 8192,
    system: systemContent,
    messages,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools ? { tools } : {}),
    ...(req.stream ? { stream: true } : {}),
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${text.substring(0, 500)}`);
  }

  // Streaming path
  if (req.stream && req.onToken) {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cached = false;

    // Track tool_use blocks being built
    let currentToolId = '';
    let currentToolName = '';
    let currentToolJson = '';

    for await (const event of parseSSE(resp)) {
      try {
      if (event.type === 'message_start') {
        const usage = event.data?.message?.usage;
        if (usage) {
          inputTokens = usage.input_tokens || 0;
          cached = (usage.cache_read_input_tokens || 0) > 0;
        }
      } else if (event.type === 'content_block_start') {
        const block = event.data?.content_block;
        if (block?.type === 'tool_use') {
          currentToolId = block.id;
          currentToolName = block.name;
          currentToolJson = '';
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.data?.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          content += delta.text;
          req.onToken(delta.text);
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          currentToolJson += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolId) {
          try {
            toolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolJson ? JSON.parse(currentToolJson) : {},
            });
          } catch {
            toolCalls.push({ id: currentToolId, name: currentToolName, arguments: {} });
          }
          currentToolId = '';
          currentToolName = '';
          currentToolJson = '';
        }
      } else if (event.type === 'message_delta') {
        const usage = event.data?.usage;
        if (usage) outputTokens = usage.output_tokens || 0;
      }
      } catch { /* skip malformed SSE event */ }
    }

    return {
      content, model, provider: 'anthropic',
      inputTokens, outputTokens,
      latencyMs: Date.now() - start, cached,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  // Non-streaming path
  const data: any = await resp.json();
  const usage = data.usage || {};

  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const block of data.content || []) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }
  }

  return {
    content, model, provider: 'anthropic',
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    latencyMs: Date.now() - start,
    cached: (usage.cache_read_input_tokens || 0) > 0,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Convert abstract LLMMessage[] to Anthropic message format */
function anthropicMessages(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content || '' });
    } else if (msg.role === 'assistant') {
      // Assistant message may have text + tool_use blocks
      const content: any[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Anthropic: tool results are sent as user messages with tool_result content blocks
      const content: any[] = [];
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          content.push({
            type: 'tool_result',
            tool_use_id: tr.toolCallId,
            content: tr.content,
            ...(tr.isError ? { is_error: true } : {}),
          });
        }
      }
      result.push({ role: 'user', content });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, DeepSeek, xAI, NVIDIA router, Ollama)
// ---------------------------------------------------------------------------

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  provider: ProviderId,
  req: LLMRequest,
): Promise<LLMResponse> {
  const start = Date.now();

  const systemContent = req.cacheablePrefix
    ? `${req.cacheablePrefix}\n\n${req.systemPrompt}`
    : req.systemPrompt;

  // Messages — multi-turn or single-turn
  let messages: any[];
  if (req.messages) {
    messages = [
      { role: 'system', content: systemContent },
      ...openaiMessages(req.messages),
    ];
  } else {
    messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: req.userMessage || '' },
    ];
  }

  // Tools
  const tools = req.tools?.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const max = req.maxOutputTokens ?? 8192;
  const body: any = {
    model,
    messages,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools ? { tools } : {}),
    ...(req.stream ? { stream: true } : {}),
  };

  if (provider === 'openai') {
    body.max_completion_tokens = max; // new OpenAI param
  } else {
    body.max_tokens = max; // legacy / compatible providers
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${provider} API ${resp.status}: ${text.substring(0, 500)}`);
  }

  // Streaming path
  if (req.stream && req.onToken) {
    let content = '';
    const toolCalls: ToolCall[] = [];
    const toolJsonBuffers: Map<number, { id: string; name: string; json: string }> = new Map();
    let actualModel = model;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of parseSSE(resp)) {
      if (!event.data || event.data === '[DONE]') continue;

      let chunk: any;
      try {
        if (typeof event.data === 'string') {
          const raw = event.data.trim();
          const clean = raw.startsWith('data:') ? raw.slice(5).trim() : raw;
          chunk = JSON.parse(clean);
        } else {
          chunk = event.data;
        }
      } catch {
        continue; // Skip unparseable chunks
      }
      if (chunk.model) actualModel = chunk.model;

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        content += delta.content;
        req.onToken(delta.content);
      }

      // Tool calls (streamed incrementally)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id) {
            toolJsonBuffers.set(idx, { id: tc.id, name: tc.function?.name || '', json: '' });
          }
          const buf = toolJsonBuffers.get(idx);
          if (buf && tc.function?.arguments) {
            buf.json += tc.function.arguments;
          }
        }
      }

      // Usage (some providers send this in the final chunk)
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
      }
    }

    // Finalize tool calls
    for (const buf of toolJsonBuffers.values()) {
      try {
        toolCalls.push({ id: buf.id, name: buf.name, arguments: buf.json ? JSON.parse(buf.json) : {} });
      } catch {
        toolCalls.push({ id: buf.id, name: buf.name, arguments: {} });
      }
    }

    return {
      content, model: actualModel, provider,
      inputTokens, outputTokens,
      latencyMs: Date.now() - start,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  // Non-streaming path
  const data: any = await resp.json();
  const choice = data.choices?.[0]?.message || {};
  const usage = data.usage || {};
  const actualModel = data.model || model;

  const toolCalls: ToolCall[] = [];
  if (choice.tool_calls) {
    for (const tc of choice.tool_calls) {
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      });
    }
  }

  return {
    content: choice.content || '',
    model: actualModel,
    provider,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    latencyMs: Date.now() - start,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Convert abstract LLMMessage[] to OpenAI message format */
function openaiMessages(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content || '' });
    } else if (msg.role === 'assistant') {
      const entry: any = { role: 'assistant' };
      if (msg.content) entry.content = msg.content;
      if (msg.toolCalls) {
        entry.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      result.push(entry);
    } else if (msg.role === 'tool') {
      // OpenAI: each tool result is a separate message with role: 'tool'
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.content,
          });
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function callGemini(
  apiKey: string,
  model: string,
  req: LLMRequest,
): Promise<LLMResponse> {
  const start = Date.now();

  const systemText = req.cacheablePrefix
    ? `${req.cacheablePrefix}\n\n${req.systemPrompt}`
    : req.systemPrompt;

  // Gemini tool use: function_declarations
  const tools = req.tools ? [{
    function_declarations: req.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }] : undefined;

  // Messages — multi-turn or single-turn
  let contents: any[];
  if (req.messages) {
    contents = geminiMessages(req.messages);
  } else {
    contents = [{ role: 'user', parts: [{ text: req.userMessage || '' }] }];
  }

  const body: any = {
    system_instruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens ?? 8192,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    ...(tools ? { tools } : {}),
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data: any = await resp.json();
  const usage = data.usageMetadata || {};

  let content = '';
  const toolCalls: ToolCall[] = [];

  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.text) {
      content += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {},
      });
    }
  }

  return {
    content,
    model,
    provider: 'google',
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    latencyMs: Date.now() - start,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Convert abstract LLMMessage[] to Gemini contents format */
function geminiMessages(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', parts: [{ text: msg.content || '' }] });
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: { name: tc.name, args: tc.arguments },
          });
        }
      }
      result.push({ role: 'model', parts });
    } else if (msg.role === 'tool') {
      // Gemini: functionResponse parts
      const parts: any[] = [];
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          parts.push({
            functionResponse: {
              name: tr.toolCallId, // Gemini uses name, not id
              response: { content: tr.content },
            },
          });
        }
      }
      result.push({ role: 'function', parts });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Unified router
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);
// Spec 13 — per-call timeout and per-turn wall-clock cap.
const LLM_TIMEOUT_MS = 120_000;
const TURN_WALL_CLOCK_MS = 300_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); },
           e => { clearTimeout(timer); reject(e); });
  });
}

function parseRetryAfter(msg: string): number | null {
  const m = msg.match(/retry[- ]?after[^0-9]*(\d+)/i);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000;
}

/**
 * Fallback chains: when a model is overloaded (529) or rate-limited (429),
 * try the next model in the chain before giving up.
 */
const FALLBACK_CHAINS: Record<string, { provider: ProviderId; model: string }[]> = {
  'claude-opus-4-20250514': [
    { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'openai', model: 'gpt-5.4' },
  ],
  'claude-sonnet-4-5-20250929': [
    { provider: 'openai', model: 'gpt-5.4' },
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  ],
  'gpt-5.4': [
    { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'openai', model: 'gpt-5.4-mini' },
  ],
};

export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  const provider = req.provider || 'anthropic';
  const model = req.model || DEFAULT_MODELS[provider] || 'claude-sonnet-4-5-20250929';

  const apiKey = getApiKey(provider);
  if (!apiKey && provider !== 'ollama') {
    const envVars: Record<string, string> = {
      'anthropic': 'ANTHROPIC_API_KEY',
      'openai': 'OPENAI_API_KEY',
      'deepseek': 'DEEPSEEK_API_KEY',
      'xai': 'XAI_API_KEY',
      'google': 'GOOGLE_API_KEY',
      'nvidia-router': 'NVIDIA_API_KEY',
    };
    throw new Error(`No API key for "${provider}". Set ${envVars[provider] || 'API_KEY'} in environment or .env file.`);
  }

  // Try the requested model first
  let lastError: Error | null = null;

  const turnDeadline = Date.now() + TURN_WALL_CLOCK_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await withTimeout(callProvider(provider, apiKey, model, req), LLM_TIMEOUT_MS, `${provider}/${model}`);
    } catch (error) {
      lastError = error as Error;
      const statusMatch = lastError.message.match(/API (\d+):/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
      const retryAfter = parseRetryAfter(lastError.message);
      const isTimeout = /timeout after/.test(lastError.message);
      const retryable = RETRYABLE_STATUS_CODES.has(statusCode) || isTimeout;

      if (attempt < MAX_RETRIES && retryable && Date.now() < turnDeadline) {
        const baseDelay = retryAfter ?? Math.min(1000 * Math.pow(2, attempt), 8_000);
        const delay = Math.min(baseDelay, Math.max(0, turnDeadline - Date.now()));
        process.stderr.write(
          `  │  [retry] ${provider}/${model} ${statusCode || 'timeout'} — waiting ${(delay / 1000).toFixed(0)}s (attempt ${attempt + 1}/${MAX_RETRIES})\n`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Not retryable — break to fallback
      break;
    }
  }

  // Try fallback models
  const fallbacks = FALLBACK_CHAINS[model] || [];
  for (const fb of fallbacks) {
    const fbKey = getApiKey(fb.provider);
    if (!fbKey && fb.provider !== 'ollama') continue;

    try {
      process.stderr.write(
        `  │  [fallback] ${provider}/${model} unavailable → trying ${fb.provider}/${fb.model}\n`
      );
      const fbReq = { ...req, provider: fb.provider, model: fb.model };
      const fbResponse = await callProvider(fb.provider, fbKey, fb.model, fbReq);
      fbResponse.wasFallback = true;
      fbResponse.requestedModel = model;
      return fbResponse;
    } catch {
      // Fallback also failed — try next
      continue;
    }
  }

  // All retries and fallbacks exhausted
  throw lastError ?? new Error('All retry attempts and fallbacks exhausted');
}

function callProvider(
  provider: ProviderId,
  apiKey: string | undefined,
  model: string,
  req: LLMRequest,
): Promise<LLMResponse> {
  switch (provider) {
    case 'anthropic':
      return callAnthropic(apiKey!, model, req);

    case 'openai':
      return callOpenAICompatible('https://api.openai.com/v1', apiKey!, model, provider, req);

    case 'deepseek':
      return callOpenAICompatible('https://api.deepseek.com/v1', apiKey!, model, provider, req);

    case 'xai':
      return callOpenAICompatible('https://api.x.ai/v1', apiKey!, model, provider, req);

    case 'nvidia-router': {
      const routerUrl = process.env.NVIDIA_ROUTER_URL || 'http://localhost:8001/v1';
      return callOpenAICompatible(routerUrl, apiKey!, model, provider, req);
    }

    case 'google':
      return callGemini(apiKey!, model, req);

    case 'ollama':
      return callOpenAICompatible('http://localhost:11434/v1', 'ollama', model, provider, req);

    default:
      throw new Error(`Unknown provider "${provider}". Supported: anthropic, openai, deepseek, xai, google, ollama, nvidia-router`);
  }
}
