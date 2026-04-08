/**
 * ChatView — scrollable message display.
 *
 * Renders messages bottom-up: always shows the most recent messages
 * that fit in the viewport. When stats/tools expand, older messages
 * scroll off the top rather than clipping the bottom.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './types.js';

interface ChatViewProps {
  messages: ChatMessage[];
  showToolOutput: boolean;
  showTokenStats: boolean;
  maxHeight: number;
  /** 0 = bottom (newest), positive = scrolled up by N messages */
  scrollOffset: number;
}

/** Estimate how many terminal lines a message will take */
function estimateMessageHeight(
  msg: ChatMessage,
  showToolOutput: boolean,
  showTokenStats: boolean,
  termWidth: number,
): number {
  let lines = 0;

  if (msg.role === 'user') {
    // Bold blue text — estimate wrap
    lines += Math.ceil(msg.content.length / Math.max(termWidth - 4, 40));
    lines += 1; // spacing
    return lines;
  }

  if (msg.role === 'system') {
    lines += Math.ceil(msg.content.length / Math.max(termWidth - 4, 40));
    lines += 1;
    return lines;
  }

  // Assistant: label + content + optional tool calls + optional stats
  lines += 1; // [model]:
  const contentLines = msg.content.split('\n');
  for (const cl of contentLines) {
    lines += Math.max(1, Math.ceil(cl.length / Math.max(termWidth - 6, 40)));
  }

  if (showToolOutput && msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      lines += 1; // tool name
      if (tc.result) lines += 1; // result preview
    }
  }

  if (showTokenStats && msg.stats) {
    lines += 1;
  }

  lines += 1; // spacing
  return lines;
}

export function ChatView({ messages, showToolOutput, showTokenStats, maxHeight, scrollOffset }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No messages yet. Type a message and press Enter to send.</Text>
        <Text dimColor>^O: toggle tool output | ^T: toggle token stats | arrows: scroll</Text>
      </Box>
    );
  }

  // Pick which messages to show — work backwards from the scroll position
  const termWidth = process.stdout.columns || 80;
  const visibleMessages = useMemo(() => {
    const result: ChatMessage[] = [];
    let usedHeight = 0;

    // Start from the end minus the scroll offset
    const endIdx = Math.max(messages.length - scrollOffset, 1);

    for (let i = endIdx - 1; i >= 0; i--) {
      const h = estimateMessageHeight(messages[i], showToolOutput, showTokenStats, termWidth);
      if (usedHeight + h > maxHeight && result.length > 0) break;
      result.unshift(messages[i]);
      usedHeight += h;
    }

    return result;
  }, [messages, showToolOutput, showTokenStats, maxHeight, termWidth, scrollOffset]);

  const firstVisibleIdx = messages.indexOf(visibleMessages[0]);
  const lastVisibleIdx = messages.indexOf(visibleMessages[visibleMessages.length - 1]);
  const hasEarlier = firstVisibleIdx > 0;
  const hasLater = lastVisibleIdx < messages.length - 1;

  return (
    <Box flexDirection="column" paddingX={1}>
      {hasEarlier && (
        <Text dimColor>--- {firstVisibleIdx} earlier messages (arrow up to scroll) ---</Text>
      )}
      {visibleMessages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          showToolOutput={showToolOutput}
          showTokenStats={showTokenStats}
        />
      ))}
      {hasLater && (
        <Text dimColor>--- {messages.length - 1 - lastVisibleIdx} newer messages (arrow down to scroll) ---</Text>
      )}
    </Box>
  );
}

function MessageBubble({
  message,
  showToolOutput,
  showTokenStats,
}: {
  message: ChatMessage;
  showToolOutput: boolean;
  showTokenStats: boolean;
}) {
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

  // Assistant message
  const label = message.modelLabel || 'assistant';

  return (
    <Box marginY={0} flexDirection="column">
      <Text bold color="green">[{label}]: </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text wrap="wrap">{message.content}</Text>

        {/* Tool calls — collapsible */}
        {showToolOutput && message.toolCalls && message.toolCalls.length > 0 && (
          <Box flexDirection="column" marginLeft={1}>
            {message.toolCalls.map((tc, i) => (
              <Box key={i} flexDirection="column">
                <Text dimColor>  {tc.isError ? '!' : '>'} {tc.name}({tc.args})</Text>
                {tc.result && (
                  <Text dimColor>    {tc.result.slice(0, 200)}{tc.result.length > 200 ? '...' : ''}</Text>
                )}
              </Box>
            ))}
          </Box>
        )}

        {/* Token stats — collapsible */}
        {showTokenStats && message.stats && (
          <Box>
            <Text dimColor>
              [{message.stats.models.join(', ')}] {message.stats.inputTokens.toLocaleString()}in/{message.stats.outputTokens.toLocaleString()}out ${message.stats.costUsd.toFixed(4)}{message.stats.iterations > 1 ? ` (${message.stats.iterations} iters)` : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
