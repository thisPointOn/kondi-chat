/**
 * Shared Output Parsers
 *
 * Parsing functions for Claude CLI stream-json and Codex CLI JSONL output.
 * Used by both the GUI caller (Tauri invoke) and CLI caller (Node.js spawn).
 */

export interface ParsedOutput {
  text: string;
  tokensUsed: number;
  sessionId?: string;
}

/**
 * Check if a model ID corresponds to an OpenAI model (routes to Codex CLI).
 */
export function isOpenAIModel(model: string): boolean {
  return /^(gpt-|o[1-9]|codex|davinci|chatgpt)/.test(model);
}

/**
 * Parse raw stream-json output from Claude CLI.
 * Handles the `--output-format stream-json` JSONL stream.
 */
export function parseStreamJsonOutput(rawOutput: string): ParsedOutput {
  if (!rawOutput.includes('{"type":')) {
    return { text: rawOutput, tokensUsed: 0 };
  }

  const lines = rawOutput.split('\n').filter(l => l.trim());
  let resultText = '';
  let isErrorResult = false;
  const textChunks: string[] = [];
  const errorChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      // Extract session_id from init event or result
      if (json.session_id && !sessionId) {
        sessionId = json.session_id;
      }

      if (json.type === 'result' && json.result) {
        resultText = typeof json.result === 'string' ? json.result : JSON.stringify(json.result);
        if (json.is_error) isErrorResult = true;
        if (json.session_id) sessionId = json.session_id;
      }

      if (json.type === 'error') {
        const errText = json.error || json.body || JSON.stringify(json);
        errorChunks.push(typeof errText === 'string' ? errText : JSON.stringify(errText));
      }

      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) {
            textChunks.push(block.text);
          }
        }
        if (json.message?.usage) {
          inputTokens += json.message.usage.input_tokens || 0;
          outputTokens += json.message.usage.output_tokens || 0;
        }
      }

      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
        textChunks.push(json.delta.text);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  const parts: string[] = [];
  if (textChunks.length > 0) parts.push(textChunks.join(''));
  if (resultText) {
    const combined = parts.join('');
    if (!combined.endsWith(resultText)) {
      parts.push(isErrorResult ? '\n\nError: ' + resultText : '\n\n' + resultText);
    }
  }
  if (errorChunks.length > 0) {
    const errText = errorChunks.join('; ');
    if (!parts.some(p => p.includes(errText))) {
      parts.push('\n\nError: ' + errText);
    }
  }

  const text = parts.length > 0 ? parts.join('').trim() : rawOutput;
  return { text, tokensUsed: inputTokens + outputTokens, sessionId };
}

/**
 * Parse JSONL output from `codex exec --json`.
 *
 * Event types:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"...","type":"reasoning","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
 */
export function parseCodexJsonOutput(rawOutput: string): ParsedOutput {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const textChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      if (json.type === 'thread.started' && json.thread_id) {
        sessionId = json.thread_id;
      }

      if (json.type === 'item.completed' && json.item) {
        if (json.item.type === 'agent_message' && json.item.text) {
          textChunks.push(json.item.text);
        }
        // Skip reasoning items — they're internal thought, not output
      }

      if (json.type === 'turn.completed' && json.usage) {
        inputTokens += json.usage.input_tokens || 0;
        outputTokens += json.usage.output_tokens || 0;
      }

      if (json.type === 'error') {
        const errText = json.message || json.error || JSON.stringify(json);
        textChunks.push(`\n\nError: ${errText}`);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  const text = textChunks.join('\n').trim() || rawOutput;
  return { text, tokensUsed: inputTokens + outputTokens, sessionId };
}
