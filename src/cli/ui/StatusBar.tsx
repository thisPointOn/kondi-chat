/**
 * StatusBar — shows current state and keyboard shortcut hints.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  status: string;
  isProcessing: boolean;
  queued?: number;
}

export function StatusBar({ status, isProcessing, queued = 0 }: StatusBarProps) {
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
        {queued > 0 && <Text color="cyan">queued:{queued}</Text>}
        <Text dimColor>
          Enter:send ^N:newline ^A:activity ^O:tools ^T:stats ^E:full-msg ↑↓:scroll ^C:exit
        </Text>
      </Box>
    </Box>
  );
}
