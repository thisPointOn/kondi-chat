/**
 * InputBar — text input at the bottom of the screen.
 *
 * Enter sends the message. Ctrl+N adds a newline for multi-line input.
 * Escape clears. Tab is ignored.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';

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

    // Enter sends the message
    if (key.return) {
      if (value.trim()) {
        onSubmit(value);
      }
      return;
    }

    // Ctrl+N adds a newline (for multi-line input)
    if (input === 'n' && key.ctrl) {
      onChange(value + '\n');
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    // Tab — ignore
    if (key.tab) return;

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

  return (
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
  );
}
