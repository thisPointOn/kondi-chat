/**
 * ChatView — scrollable message display (chat mode).
 *
 * Messages are truncated to fit the viewport. Long responses show
 * a preview with a hint to press Ctrl+M to read the full message.
 * Tool output and stats are in separate detail views (Ctrl+O / Ctrl+T).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './types.js';

/** Max lines per message in chat view before truncation */
const MAX_MESSAGE_LINES = 15;

interface ChatViewProps {
  messages: ChatMessage[];
  maxHeight: number;
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

function estimateMessageHeight(msg: ChatMessage, termWidth: number): number {
  const maxW = Math.max(termWidth - 6, 40);

  if (msg.role === 'user') {
    const lines = msg.content.split('\n');
    let h = 0;
    for (const l of lines) h += Math.max(1, Math.ceil(l.length / maxW));
    return Math.min(h, MAX_MESSAGE_LINES) + 1;
  }

  if (msg.role === 'system') {
    const lines = msg.content.split('\n');
    let h = 0;
    for (const l of lines) h += Math.max(1, Math.ceil(l.length / maxW));
    return Math.min(h, MAX_MESSAGE_LINES) + 1;
  }

  // Assistant: label + truncated content + optional indicator
  let h = 1; // label line
  const { text } = truncateContent(msg.content, MAX_MESSAGE_LINES);
  const lines = text.split('\n');
  for (const l of lines) h += Math.max(1, Math.ceil(l.length / maxW));
  if (msg.toolCalls || msg.stats) h += 1; // indicator
  h += 1; // spacing
  return h;
}

export function ChatView({ messages, maxHeight, scrollOffset }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No messages yet. Type a message and press Enter to send.</Text>
        <Text dimColor>^O: tools | ^T: stats | ^M: full message | ↑↓: scroll</Text>
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

  return (
    <Box flexDirection="column" paddingX={1}>
      {firstVisibleIdx > 0 && (
        <Text dimColor>--- {firstVisibleIdx} earlier messages ---</Text>
      )}
      {visibleMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {lastVisibleIdx < messages.length - 1 && (
        <Text dimColor>--- {messages.length - 1 - lastVisibleIdx} newer messages ---</Text>
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
