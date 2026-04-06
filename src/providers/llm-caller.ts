/**
 * Multi-provider LLM caller — direct HTTP, no SDKs.
 *
 * Based on kondi-council's llm-caller.ts with additions:
 * - Separate input/output token tracking
 * - NVIDIA router support
 * - Anthropic prompt caching support
 * - Configurable max_tokens per call
 */

import type { ProviderId, LLMRequest, LLMResponse } from '../types.ts';

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
// Provider implementations
// ---------------------------------------------------------------------------

async function callAnthropic(
  apiKey: string,
  model: string,
  req: LLMRequest,
): Promise<LLMResponse> {
  const start = Date.now();

  const systemContent: Array<{ type: string; text: string; cache_control?: { type: string } }> = [];

  // If there's a cacheable prefix, send it as a separate system block with cache_control
  if (req.cacheablePrefix) {
    systemContent.push({
      type: 'text',
      text: req.cacheablePrefix,
      cache_control: { type: 'ephemeral' },
    });
  }
  systemContent.push({ type: 'text', text: req.systemPrompt });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxOutputTokens ?? 8192,
      system: systemContent,
      messages: [{ role: 'user', content: req.userMessage }],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.content
    ?.filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n') || '';
  const usage = data.usage || {};

  return {
    content,
    model,
    provider: 'anthropic',
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    latencyMs: Date.now() - start,
    cached: (usage.cache_read_input_tokens || 0) > 0,
  };
}

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

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: req.userMessage },
      ],
      max_tokens: req.maxOutputTokens ?? 8192,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${provider} API ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};
  const actualModel = data.model || model;

  return {
    content,
    model: actualModel,
    provider,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    latencyMs: Date.now() - start,
  };
}

async function callGemini(
  apiKey: string,
  model: string,
  req: LLMRequest,
): Promise<LLMResponse> {
  const start = Date.now();

  const systemText = req.cacheablePrefix
    ? `${req.cacheablePrefix}\n\n${req.systemPrompt}`
    : req.systemPrompt;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: req.userMessage }] }],
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens ?? 8192,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.candidates?.[0]?.content?.parts
    ?.map((p: any) => p.text)
    .join('\n') || '';
  const usage = data.usageMetadata || {};

  return {
    content,
    model,
    provider: 'google',
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    latencyMs: Date.now() - start,
  };
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
