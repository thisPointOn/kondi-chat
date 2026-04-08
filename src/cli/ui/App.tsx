/**
 * Main App component — the root of the Ink TUI.
 *
 * Layout:
 *   ┌──────────────────────────────┐
 *   │  Chat messages (scrollable)  │
 *   │  ...                         │
 *   │  [opus]: Here's my plan...   │
 *   ├──────────────────────────────┤
 *   │  Status bar                  │
 *   ├──────────────────────────────┤
 *   │  Input (multi-line)          │
 *   └──────────────────────────────┘
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import type { ChatMessage, AppState, MessageStats, ToolCallDisplay } from './types.js';

export interface AppProps {
  /** Called when user submits a message */
  onSubmit: (input: string) => Promise<void>;
  /** Initial status text */
  initialStatus: string;
  /** Available @mention aliases */
  aliases: string[];
}

export function App({ onSubmit, initialStatus, aliases }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows || 24;

  const [state, setState] = useState<AppState>({
    messages: [],
    isProcessing: false,
    showToolOutput: false,
    showTokenStats: false,
    statusText: initialStatus,
  });

  const [inputValue, setInputValue] = useState('');
  /** Scroll offset: 0 = bottom (newest), positive = scrolled up */
  const [scrollOffset, setScrollOffset] = useState(0);

  // Keyboard shortcuts
  useInput((input, key) => {
    // Ctrl+C to exit
    if (input === 'c' && key.ctrl) {
      exit();
      return;
    }
    // Ctrl+O to toggle tool output
    if (input === 'o' && key.ctrl) {
      setState(s => ({ ...s, showToolOutput: !s.showToolOutput }));
      return;
    }
    // Ctrl+T to toggle token stats
    if (input === 't' && key.ctrl) {
      setState(s => ({ ...s, showTokenStats: !s.showTokenStats }));
      return;
    }
    // Page Up / Arrow Up to scroll up (only when not typing)
    if (key.upArrow || (input === 'u' && key.ctrl)) {
      setScrollOffset(s => Math.min(s + 3, Math.max(state.messages.length - 1, 0)));
      return;
    }
    // Page Down / Arrow Down to scroll down
    if (key.downArrow || (input === 'd' && key.ctrl)) {
      setScrollOffset(s => Math.max(s - 3, 0));
      return;
    }
  });

  const handleSubmit = useCallback(async (text: string) => {
    if (!text.trim() || state.isProcessing) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: text.trim(),
      timestamp: new Date().toISOString(),
    };

    setState(s => ({
      ...s,
      messages: [...s.messages, userMsg],
      isProcessing: true,
      statusText: 'thinking...',
    }));
    setInputValue('');

    try {
      await onSubmit(text.trim());
    } catch (error) {
      addMessage({
        id: `msg-${Date.now()}`,
        role: 'system',
        content: `Error: ${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      });
    }

    setState(s => ({ ...s, isProcessing: false, statusText: '' }));
  }, [state.isProcessing, onSubmit]);

  // Exposed methods for the agent loop to call
  const addMessage = useCallback((msg: ChatMessage) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
    setScrollOffset(0); // Auto-scroll to bottom on new message
  }, []);

  const setStatus = useCallback((text: string) => {
    setState(s => ({ ...s, statusText: text }));
  }, []);

  const updateLastAssistant = useCallback((update: Partial<ChatMessage>) => {
    setState(s => {
      const msgs = [...s.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = { ...msgs[i], ...update };
          break;
        }
      }
      return { ...s, messages: msgs };
    });
  }, []);

  // Expose methods globally for the agent loop to use
  useEffect(() => {
    (globalThis as any).__kondiUI = {
      addMessage,
      setStatus,
      updateLastAssistant,
      getState: () => state,
    };
  }, [addMessage, setStatus, updateLastAssistant, state]);

  // Calculate visible height for chat area
  const chatHeight = Math.max(rows - 6, 5); // Leave room for status + input

  return (
    <Box flexDirection="column" height={rows}>
      {/* Chat area */}
      <Box flexDirection="column" flexGrow={1} height={chatHeight}>
        <ChatView
          messages={state.messages}
          showToolOutput={state.showToolOutput}
          showTokenStats={state.showTokenStats}
          maxHeight={chatHeight}
          scrollOffset={scrollOffset}
        />
      </Box>

      {/* Status bar */}
      <StatusBar
        status={state.statusText}
        isProcessing={state.isProcessing}
        showToolOutput={state.showToolOutput}
        showTokenStats={state.showTokenStats}
      />

      {/* Input bar */}
      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isProcessing={state.isProcessing}
        aliases={aliases}
      />
    </Box>
  );
}
