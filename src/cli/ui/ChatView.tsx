/**
 * ChatView — scrollable message display (chat mode).
 *
 * Shows messages in a clean chat format. Tool output and stats
 * are viewed in separate full-screen detail views (Ctrl+O / Ctrl+T).
 *
 * Small inline indicators show when a message has tools/stats available.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './types.js';

interface ChatViewProps {
  messages: ChatMessage[];
  maxHeight: number;
  scrollOffset: number;
}

function estimateMessageHeight(msg: ChatMessage, termWidth: number): number {
  let lines = 0;

  if (msg.role === 'user') {
    lines += Math.ceil(msg.content.length / Math.max(termWidth - 4, 40));
    lines += 1;
    return Math.max(lines, 1);
  }

  if (msg.role === 'system') {
    lines += Math.ceil(msg.content.length / Math.max(termWidth - 4, 40));
    lines += 1;
    return Math.max(lines, 1);
  }

  // Assistant: label line + content lines + indicator line
  lines += 1; // [model]:
  const contentLines = msg.content.split('\n');
  for (const cl of contentLines) {
    lines += Math.max(1, Math.ceil((cl.length + 4) / Math.max(termWidth - 4, 40)));
  }
  if (msg.toolCalls || msg.stats) lines += 1; // indicator line
  lines += 1; // spacing
  return lines;
}

export function ChatView({ messages, maxHeight, scrollOffset }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No messages yet. Type a message and press Enter to send.</Text>
        <Text dimColor>^O: view tool calls | ^T: view stats | ↑↓: scroll</Text>
      </Box>
    );
  }

  const termWidth = process.stdout.columns || 80;
  const visibleMessages = useMemo(() => {
    const result: ChatMessage[] = [];
    let usedHeight = 0;
    const endIdx = Math.max(messages.length - scrollOffset, 1);

    for (let i = endIdx - 1; i >= 0; i--) {
      const h = estimateMessageHeight(messages[i], termWidth);
      if (usedHeight + h > maxHeight && result.length > 0) break;
      result.unshift(messages[i]);
      usedHeight += h;
    }
    return result;
  }, [messages, maxHeight, termWidth, scrollOffset]);

  const firstVisibleIdx = messages.indexOf(visibleMessages[0]);
  const lastVisibleIdx = messages.indexOf(visibleMessages[visibleMessages.length - 1]);
  const hasEarlier = firstVisibleIdx > 0;
  const hasLater = lastVisibleIdx < messages.length - 1;

  return (
    <Box flexDirection="column" paddingX={1}>
      {hasEarlier && (
        <Text dimColor>--- {firstVisibleIdx} earlier messages ---</Text>
      )}
      {visibleMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {hasLater && (
        <Text dimColor>--- {messages.length - 1 - lastVisibleIdx} newer messages ---</Text>
      )}
    </Box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <Box marginY={0}>
        <Text bold color="blue">{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'system') {
    return (
      <Box marginY={0}>
        <Text color="yellow">{message.content}</Text>
      </Box>
    );
  }

  const label = message.modelLabel || 'assistant';

  // Build small inline indicators
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
      <Box marginLeft={2}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    </Box>
  );
}
