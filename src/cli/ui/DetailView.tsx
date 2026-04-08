/**
 * DetailView — full-screen view of tool calls or token stats.
 *
 * Opened with Ctrl+O (tools) or Ctrl+T (stats). Shows all messages
 * with their details. Scrollable with arrow keys. Escape returns to chat.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage, ViewMode } from './types.js';

interface DetailViewProps {
  messages: ChatMessage[];
  mode: ViewMode;
  maxHeight: number;
  scrollOffset: number;
}

export function DetailView({ messages, mode, maxHeight, scrollOffset }: DetailViewProps) {
  const title = mode === 'tools' ? 'Tool Calls' : 'Token Stats';

  // Build all lines for the detail view
  const allLines = useMemo(() => {
    const lines: { text: string; color?: string; bold?: boolean; dim?: boolean }[] = [];

    lines.push({ text: `═══ ${title} ═══`, bold: true });
    lines.push({ text: '' });

    for (const msg of messages) {
      if (msg.role === 'user') {
        lines.push({ text: msg.content.slice(0, 100), color: 'blue', bold: true });
        lines.push({ text: '' });
        continue;
      }

      if (msg.role === 'system') continue;

      // Assistant message
      const label = msg.modelLabel || 'assistant';
      lines.push({ text: `[${label}]`, color: 'green', bold: true });

      if (mode === 'tools') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            const icon = tc.isError ? '!' : '>';
            lines.push({ text: `  ${icon} ${tc.name}(${tc.args})`, dim: false });
            if (tc.result) {
              // Show full result, split into lines
              const resultLines = tc.result.split('\n');
              for (const rl of resultLines) {
                lines.push({ text: `    ${rl}`, dim: true });
              }
            }
          }
        } else {
          lines.push({ text: '  (no tool calls)', dim: true });
        }
      }

      if (mode === 'stats') {
        if (msg.stats) {
          lines.push({ text: `  Models:     ${msg.stats.models.join(', ')}` });
          lines.push({ text: `  Input:      ${msg.stats.inputTokens.toLocaleString()} tokens` });
          lines.push({ text: `  Output:     ${msg.stats.outputTokens.toLocaleString()} tokens` });
          lines.push({ text: `  Cost:       $${msg.stats.costUsd.toFixed(4)}` });
          if (msg.stats.iterations > 1) {
            lines.push({ text: `  Iterations: ${msg.stats.iterations}` });
          }
        } else {
          lines.push({ text: '  (no stats)', dim: true });
        }
      }

      lines.push({ text: '' });
    }

    // Add running totals for stats view
    if (mode === 'stats') {
      const totals = messages.reduce(
        (acc, m) => {
          if (m.stats) {
            acc.input += m.stats.inputTokens;
            acc.output += m.stats.outputTokens;
            acc.cost += m.stats.costUsd;
            acc.calls++;
          }
          return acc;
        },
        { input: 0, output: 0, cost: 0, calls: 0 },
      );

      if (totals.calls > 0) {
        lines.push({ text: '═══ Session Totals ═══', bold: true });
        lines.push({ text: `  Calls:  ${totals.calls}` });
        lines.push({ text: `  Input:  ${totals.input.toLocaleString()} tokens` });
        lines.push({ text: `  Output: ${totals.output.toLocaleString()} tokens` });
        lines.push({ text: `  Cost:   $${totals.cost.toFixed(4)}` });
      }
    }

    return lines;
  }, [messages, mode]);

  // Apply scroll offset
  const startLine = Math.max(0, allLines.length - maxHeight - scrollOffset);
  const endLine = Math.min(allLines.length, startLine + maxHeight);
  const visibleLines = allLines.slice(startLine, endLine);
  const hasMore = startLine > 0;
  const hasBelow = endLine < allLines.length;

  return (
    <Box flexDirection="column" paddingX={1} height={maxHeight}>
      {hasMore && (
        <Text dimColor>↑ {startLine} more lines above</Text>
      )}
      {visibleLines.map((line, i) => (
        <Text
          key={i}
          bold={line.bold}
          dimColor={line.dim}
          color={line.color as any}
        >
          {line.text}
        </Text>
      ))}
      {hasBelow && (
        <Text dimColor>↓ {allLines.length - endLine} more lines below</Text>
      )}
    </Box>
  );
}
