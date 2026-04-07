/**
 * StatusBar — shows current state and keyboard shortcut hints.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  status: string;
  isProcessing: boolean;
  showToolOutput: boolean;
  showTokenStats: boolean;
}

export function StatusBar({ status, isProcessing, showToolOutput, showTokenStats }: StatusBarProps) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        {isProcessing ? (
          <Text color="yellow">{status || 'thinking...'}</Text>
        ) : status ? (
          <Text dimColor>{status}</Text>
        ) : null}
      </Box>
      <Box gap={2}>
        <Text dimColor>
          ^O:tools{showToolOutput ? '(on)' : ''} ^T:stats{showTokenStats ? '(on)' : ''} ^Enter:send ^C:exit
        </Text>
      </Box>
    </Box>
  );
}
