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

  // / commands
  if (firstLine.startsWith('/')) {
    const typed = firstLine.toLowerCase();
    return COMMANDS
      .filter(c => c.cmd.toLowerCase().startsWith(typed))
      .slice(0, 8)
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
