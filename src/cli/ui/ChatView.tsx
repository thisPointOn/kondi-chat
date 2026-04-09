/**
 * ChatView — message display with inline tool activity.
 *
 * Messages show full text (no truncation). Tool calls show inline.
 * Stats appear as a dim line at the bottom of each assistant message.
 * A 7-line activity window shows tool progress during processing.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './types.js';

interface ChatViewProps {
  messages: ChatMessage[];
  scrollOffset: number;
}

export function ChatView({ messages, scrollOffset }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Type a message and press Enter to send.</Text>
      </Box>
    );
  }

  const endIdx = Math.max(messages.length - scrollOffset, 1);
  const visibleMessages = messages.slice(0, endIdx);
  const skippedBelow = messages.length - endIdx;

  return (
    <Box flexDirection="column" paddingX={1} justifyContent="flex-end" flexGrow={1}>
      {visibleMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {skippedBelow > 0 && (
        <Text dimColor>--- {skippedBelow} newer messages (scroll down) ---</Text>
      )}
    </Box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="blue">{'❯ '}{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'system') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">{message.content}</Text>
      </Box>
    );
  }

  // Assistant message
  const label = message.modelLabel || 'assistant';
  const hasTools = message.toolCalls && message.toolCalls.length > 0;
  const content = message.content || '';
  const hasContent = content.trim() && content !== '(max tool iterations reached)';

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Model name */}
      <Box>
        <Text bold color="green">{'● '}{label}</Text>
      </Box>

      {/* Tool calls — show what the agent did, max 7 visible, scrolls */}
      {hasTools && (
        <Box marginLeft={2} flexDirection="column">
          {message.toolCalls!.slice(-7).map((tc, i) => (
            <Box key={`tc-${i}`}>
              <Text color="cyan">{'⎿ '}{tc.name}</Text>
              <Text dimColor>({tc.args})</Text>
              {tc.isError && <Text color="red"> ✗</Text>}
            </Box>
          ))}
          {message.toolCalls!.length > 7 && (
            <Text dimColor>  ... {message.toolCalls!.length - 7} more tools (^O to view all)</Text>
          )}
        </Box>
      )}

      {/* Response text — FULL, never truncated */}
      {hasContent && (
        <Box marginLeft={2} flexDirection="column">
          <Text wrap="wrap">{content}</Text>
        </Box>
      )}

      {/* No text content but tools ran */}
      {!hasContent && hasTools && (
        <Box marginLeft={2}>
          <Text dimColor>Done ({message.toolCalls!.length} tool calls)</Text>
        </Box>
      )}

      {/* Stats line */}
      {message.stats && (
        <Box marginLeft={2}>
          <Text dimColor>
            {'▸ '}{message.stats.inputTokens.toLocaleString()}in / {message.stats.outputTokens.toLocaleString()}out · ${message.stats.costUsd.toFixed(4)} · {message.stats.models.join(', ')}{message.stats.iterations > 1 ? ` · ${message.stats.iterations} steps` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
