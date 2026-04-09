/**
 * ChatView — scrollable message display (chat mode).
 *
 * Renders messages bottom-aligned inside a container with overflow="hidden".
 * The parent Box constrains the height; this component just renders content.
 * Long messages are truncated with a hint to press Ctrl+M for the full text.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './types.js';

/** Max lines per message in chat view before truncation */
const MAX_MESSAGE_LINES = 15;

interface ChatViewProps {
  messages: ChatMessage[];
  scrollOffset: number;
}

function truncateContent(content: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return { text: content, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

export function ChatView({ messages, scrollOffset }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No messages yet. Type a message and press Enter to send.</Text>
        <Text dimColor>^O: tools | ^T: stats | ^M: full message | ↑↓: scroll</Text>
      </Box>
    );
  }

  // Determine which messages to show based on scroll offset.
  // scrollOffset=0 means "show the latest messages" (bottom of history).
  // We render from the end backwards, skipping `scrollOffset` messages.
  const endIdx = Math.max(messages.length - scrollOffset, 1);
  const visibleMessages = messages.slice(0, endIdx);
  const skippedAbove = 0; // We render all from start to endIdx; container clips the top
  const skippedBelow = messages.length - endIdx;

  return (
    <Box flexDirection="column" paddingX={1} justifyContent="flex-end" flexGrow={1}>
      {visibleMessages.length < messages.length - skippedBelow && (
        <Text dimColor>--- earlier messages (scroll up) ---</Text>
      )}
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
    const { text, truncated } = truncateContent(message.content, MAX_MESSAGE_LINES);
    return (
      <Box marginY={0} flexDirection="column">
        <Text bold color="blue">{text}</Text>
        {truncated && <Text dimColor>... (message truncated)</Text>}
      </Box>
    );
  }

  if (message.role === 'system') {
    const { text, truncated } = truncateContent(message.content, MAX_MESSAGE_LINES);
    return (
      <Box marginY={0} flexDirection="column">
        <Text color="yellow">{text}</Text>
        {truncated && <Text dimColor>... (^M to see full output)</Text>}
      </Box>
    );
  }

  const label = message.modelLabel || 'assistant';
  const { text, truncated } = truncateContent(message.content, MAX_MESSAGE_LINES);

  const indicators: string[] = [];
  if (message.toolCalls && message.toolCalls.length > 0) {
    indicators.push(`${message.toolCalls.length} tools`);
  }
  if (message.stats) {
    indicators.push(`$${message.stats.costUsd.toFixed(4)}`);
  }

  return (
    <Box marginY={0} flexDirection="column">
      <Box>
        <Text bold color="green">[{label}]</Text>
        {indicators.length > 0 && (
          <Text dimColor> ({indicators.join(' | ')})</Text>
        )}
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text wrap="wrap">{text}</Text>
        {truncated && <Text dimColor>... (^M to read full response)</Text>}
      </Box>
    </Box>
  );
}
