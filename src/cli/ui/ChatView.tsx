/**
 * ChatView — scrollable message display.
 *
 * Shows the last N messages that fit in the viewport.
 * User messages are highlighted, assistant messages show the model label.
 * Tool output and token stats are collapsible.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './types.js';

interface ChatViewProps {
  messages: ChatMessage[];
  showToolOutput: boolean;
  showTokenStats: boolean;
  maxHeight: number;
}

export function ChatView({ messages, showToolOutput, showTokenStats, maxHeight }: ChatViewProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No messages yet. Type a message and press Ctrl+Enter to send.</Text>
        <Text dimColor>Ctrl+O: toggle tool output | Ctrl+T: toggle token stats</Text>
      </Box>
    );
  }

  // Render messages from the bottom — show as many as fit
  const rendered = messages.map((msg, i) => (
    <MessageBubble
      key={msg.id}
      message={msg}
      showToolOutput={showToolOutput}
      showTokenStats={showTokenStats}
    />
  ));

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      {rendered}
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
      <Box marginY={0} flexDirection="column">
        <Text bold color="cyan">You: </Text>
        <Box marginLeft={2}>
          <Text>{message.content}</Text>
        </Box>
      </Box>
    );
  }

  if (message.role === 'system') {
    return (
      <Box marginY={0}>
        <Text color="red">{message.content}</Text>
      </Box>
    );
  }

  // Assistant message
  const label = message.modelLabel || 'assistant';

  return (
    <Box marginY={0} flexDirection="column">
      <Text bold color="green">[{label}]: </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>{message.content}</Text>

        {/* Tool calls — collapsible */}
        {showToolOutput && message.toolCalls && message.toolCalls.length > 0 && (
          <Box flexDirection="column" marginTop={0} marginLeft={1}>
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
          <Box marginTop={0}>
            <Text dimColor>
              [{message.stats.models.join(', ')}] {message.stats.inputTokens.toLocaleString()}in/{message.stats.outputTokens.toLocaleString()}out ${message.stats.costUsd.toFixed(4)}{message.stats.iterations > 1 ? ` (${message.stats.iterations} iterations)` : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
