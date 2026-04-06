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

  // System content
  const systemContent: Array<{ type: string; text: string; cache_control?: { type: string } }> = [];
  if (req.cacheablePrefix) {
    systemContent.push({
      type: 'text',
      text: req.cacheablePrefix,
      cache_control: { type: 'ephemeral' },
    });
  }
  systemContent.push({ type: 'text', text: req.systemPrompt });

  // Messages — multi-turn or single-turn
  let messages: any[];
  if (req.messages) {
    messages = anthropicMessages(req.messages);
  } else {
    messages = [{ role: 'user', content: req.userMessage || '' }];
  }

  // Tools
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

  const data: any = await resp.json();
  const usage = data.usage || {};

  // Parse response — may contain text and/or tool_use blocks
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
    content,
    model,
    provider: 'anthropic',
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

  const body: any = {
    model,
    messages,
    max_tokens: req.maxOutputTokens ?? 8192,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools ? { tools } : {}),
  };

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

  const data: any = await resp.json();
  const choice = data.choices?.[0]?.message || {};
  const usage = data.usage || {};
  const actualModel = data.model || model;

  // Parse tool calls
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
