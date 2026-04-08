/**
 * InputBar — text input at the bottom of the screen.
 *
 * Enter sends the message. Ctrl+N adds a newline for multi-line input.
 * Escape clears. Tab autocompletes from the suggestion list.
 *
 * Shows command suggestions when input starts with /
 * Shows @mention suggestions when input starts with @
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

const COMMANDS = [
  // Slash commands (you run these)
  { cmd: '/switch', desc: '<provider> [model] — switch provider' },
  { cmd: '/models', desc: 'list models and aliases' },
  { cmd: '/models enable', desc: '<id> — enable a model' },
  { cmd: '/models disable', desc: '<id> — disable a model' },
  { cmd: '/models add', desc: '<id> <provider> <caps> <in> <out> [alias]' },
  { cmd: '/health', desc: 'check model availability' },
  { cmd: '/routing', desc: 'routing stats and training data' },
  { cmd: '/status', desc: 'session stats and cost' },
  { cmd: '/tasks', desc: 'list task cards' },
  { cmd: '/ledger', desc: '[phase] — audit ledger' },
  { cmd: '/cost', desc: 'cost breakdown by phase and model' },
  { cmd: '/export', desc: 'export session to JSON' },
  { cmd: '/help', desc: 'show all commands' },
  { cmd: '/quit', desc: 'exit' },
  // Mode & Loop
  { cmd: '/mode', desc: 'show/set cost mode (quality, balanced, cheap)' },
  { cmd: '/mode quality', desc: 'frontier models, thorough review' },
  { cmd: '/mode balanced', desc: 'default — good cost/quality tradeoff' },
  { cmd: '/mode cheap', desc: 'cheapest models, tight limits' },
  { cmd: '/loop', desc: '[mode] <task> — autonomous loop with cost guards' },
  // MCP
  { cmd: '/mcp', desc: 'list MCP servers and tools' },
  { cmd: '/mcp add', desc: '<name> <cmd> [args] — add local server' },
  { cmd: '/mcp add', desc: '<name> http <url> — add remote server' },
  { cmd: '/mcp remove', desc: '<name> — remove a server' },
  { cmd: '/mcp reconnect', desc: 'reconnect all servers' },
  // Agent tools (the LLM uses these automatically)
  { cmd: '/tools', desc: '— list agent tools below' },
];

const AGENT_TOOL_LIST = [
  { cmd: 'read_file', desc: 'read a file from the project' },
  { cmd: 'write_file', desc: 'create or overwrite a file' },
  { cmd: 'edit_file', desc: 'search/replace edit in a file' },
  { cmd: 'list_files', desc: 'list directory contents' },
  { cmd: 'search_code', desc: 'grep for patterns in code' },
  { cmd: 'run_command', desc: 'run a shell command' },
  { cmd: 'create_task', desc: 'dispatch a coding task (execute → verify → reflect)' },
  { cmd: 'update_plan', desc: 'update session goal, plan, decisions' },
];

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isProcessing: boolean;
  aliases: string[];
}

export function InputBar({ value, onChange, onSubmit, isProcessing, aliases }: InputBarProps) {
  useInput((input, key) => {
    if (isProcessing) return;

    // Tab — autocomplete from suggestions
    if (key.tab) {
      const suggestions = getSuggestions(value, aliases);
      if (suggestions.length === 1) {
        onChange(suggestions[0].value + ' ');
      }
      return;
    }

    // Enter sends the message
    if (key.return) {
      if (value.trim()) {
        onSubmit(value);
      }
      return;
    }

    // Ctrl+N adds a newline
    if (input === 'n' && key.ctrl) {
      onChange(value + '\n');
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    // Arrow keys — ignore for now
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;

    // Escape — clear input
    if (key.escape) {
      onChange('');
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  const lines = value.split('\n');
  const displayLines = lines.length > 3 ? lines.slice(-3) : lines;
  const hasMore = lines.length > 3;
  const suggestions = getSuggestions(value, aliases);

  return (
    <Box flexDirection="column">
      {/* Suggestions dropdown — appears above the input */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.map((s, i) => (
            <Text key={i} dimColor>
              {s.value}  <Text color="gray">{s.desc}</Text>
            </Text>
          ))}
        </Box>
      )}

      {/* Input box */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={isProcessing ? 'gray' : 'blue'}
        paddingX={1}
      >
        {isProcessing ? (
          <Text dimColor>Processing...</Text>
        ) : (
          <>
            {hasMore && <Text dimColor>... ({lines.length - 3} more lines)</Text>}
            {displayLines.map((line, i) => (
              <Text key={i}>
                {i === 0 && !hasMore ? '> ' : '  '}
                {line}
                {i === displayLines.length - 1 ? <Text color="blue">|</Text> : ''}
              </Text>
            ))}
            {value === '' && (
              <Text dimColor>{'> Type a message... (Enter to send, ^N for newline)'}</Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Suggestion logic
// ---------------------------------------------------------------------------

interface Suggestion {
  value: string;
  desc: string;
}

function getSuggestions(input: string, aliases: string[]): Suggestion[] {
  // Only show suggestions on the first line
  const firstLine = input.split('\n')[0];
  if (!firstLine) return [];

  // /tools — show agent tools
  if (firstLine.toLowerCase() === '/tools') {
    return AGENT_TOOL_LIST.map(t => ({ value: t.cmd, desc: t.desc }));
  }

  // / commands
  if (firstLine.startsWith('/')) {
    const typed = firstLine.toLowerCase();
    return COMMANDS
      .filter(c => c.cmd.toLowerCase().startsWith(typed))
      .slice(0, 16)
      .map(c => ({ value: c.cmd, desc: c.desc }));
  }

  // @ mentions
  if (firstLine.startsWith('@') && !firstLine.includes(' ')) {
    const typed = firstLine.slice(1).toLowerCase();
    return aliases
      .filter(a => a.toLowerCase().startsWith(typed))
      .slice(0, 8)
      .map(a => ({ value: `@${a}`, desc: 'send to this model' }));
  }

  return [];
}
