/**
 * LLM Router — API Only
 *
 * All providers use direct HTTP calls. No CLI binaries, no sandboxes.
 * Requires API keys set as environment variables or in .env file.
 */

export interface CallerResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  sessionId?: string;
}

interface CallLLMOpts {
  provider: string;
  model?: string;
  systemPrompt: string;
  userMessage: string;
  workingDir?: string;
  skipTools?: boolean;
  timeoutMs?: number;
  /** Stable context that can be cached (Anthropic prompt caching) */
  cacheableContext?: string;
  /** Max output tokens (defaults to 16384) */
  maxOutputTokens?: number;
}

export const DEFAULT_MODELS: Record<string, string> = {
  'anthropic-api': 'claude-sonnet-4-5-20250929',
  'openai-api': 'gpt-4o',
  'deepseek': 'deepseek-chat',
  'google': 'models/gemini-2.5-flash',
  'xai': 'grok-3',
  'ollama': 'llama3.1',
};

function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic-api': return process.env.ANTHROPIC_API_KEY;
    case 'openai-api': return process.env.OPENAI_API_KEY;
    case 'deepseek': return process.env.DEEPSEEK_API_KEY;
    case 'xai': return process.env.XAI_API_KEY;
    case 'google': return process.env.GOOGLE_API_KEY;
    default: return undefined;
  }
}

// ============================================================================
// Provider implementations
// ============================================================================

async function callAnthropicAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  cacheableContext?: string,
  maxOutputTokens = 16384,
): Promise<CallerResult> {
  const start = Date.now();

  // Build system content with optional prompt caching
  const systemContent: Array<{ type: string; text: string; cache_control?: { type: string } }> = [];
  if (cacheableContext) {
    systemContent.push({
      type: 'text',
      text: cacheableContext,
      cache_control: { type: 'ephemeral' },
    });
  }
  systemContent.push({ type: 'text', text: systemPrompt });

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
      max_tokens: maxOutputTokens,
      system: systemContent,
      messages: [{ role: 'user', content: userMessage }],
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
    tokensUsed: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    latencyMs: Date.now() - start,
  };
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxOutputTokens = 16384,
): Promise<CallerResult> {
  const start = Date.now();

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxOutputTokens,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};

  return {
    content,
    tokensUsed: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    latencyMs: Date.now() - start,
  };
}

async function callGeminiAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<CallerResult> {
  const start = Date.now();

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 16384 },
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
    tokensUsed: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
    latencyMs: Date.now() - start,
  };
}

// ============================================================================
// Unified router
// ============================================================================

export async function callLLM(opts: CallLLMOpts): Promise<CallerResult> {
  const provider = opts.provider || 'anthropic-api';
  const model = opts.model || DEFAULT_MODELS[provider] || 'claude-sonnet-4-5-20250929';

  const apiKey = getApiKey(provider);
  if (!apiKey && provider !== 'ollama') {
    const envVar = provider === 'anthropic-api' ? 'ANTHROPIC_API_KEY'
      : provider === 'openai-api' ? 'OPENAI_API_KEY'
      : provider === 'deepseek' ? 'DEEPSEEK_API_KEY'
      : provider === 'xai' ? 'XAI_API_KEY'
      : provider === 'google' ? 'GOOGLE_API_KEY'
      : 'API_KEY';
    throw new Error(`No API key for "${provider}". Set ${envVar} in environment or .env file.`);
  }

  if (provider === 'anthropic-api') {
    return callAnthropicAPI(apiKey!, model, opts.systemPrompt, opts.userMessage, opts.cacheableContext, opts.maxOutputTokens);
  }
  if (provider === 'openai-api') {
    return callOpenAICompatible('https://api.openai.com/v1', apiKey!, model, opts.systemPrompt, opts.userMessage, opts.maxOutputTokens);
  }
  if (provider === 'deepseek') {
    return callOpenAICompatible('https://api.deepseek.com/v1', apiKey!, model, opts.systemPrompt, opts.userMessage, opts.maxOutputTokens);
  }
  if (provider === 'xai') {
    return callOpenAICompatible('https://api.x.ai/v1', apiKey!, model, opts.systemPrompt, opts.userMessage, opts.maxOutputTokens);
  }
  if (provider === 'google') {
    return callGeminiAPI(apiKey!, model, opts.systemPrompt, opts.userMessage);
  }
  if (provider === 'ollama') {
    return callOpenAICompatible('http://localhost:11434/v1', 'ollama', model, opts.systemPrompt, opts.userMessage);
  }

  throw new Error(`Unknown provider "${provider}". Supported: anthropic-api, openai-api, deepseek, xai, google, ollama`);
}
