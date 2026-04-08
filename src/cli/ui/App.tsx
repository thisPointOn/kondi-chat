/**
 * Main App component — the root of the Ink TUI.
 *
 * Two modes:
 *   - Chat mode: scrollable messages + input bar at bottom
 *   - Detail mode (tools/stats): full-screen view of a message's
 *     tool calls or token stats. Escape returns to chat.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { ChatView } from './ChatView.js';
import { DetailView } from './DetailView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import type { ChatMessage, AppState, ViewMode } from './types.js';

export interface AppProps {
  onSubmit: (input: string) => Promise<void>;
  initialStatus: string;
  aliases: string[];
}

export function App({ onSubmit, initialStatus, aliases }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows || 24;

  const [state, setState] = useState<AppState>({
    messages: [],
    isProcessing: false,
    viewMode: 'chat',
    statusText: initialStatus,
  });

  const [inputValue, setInputValue] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  /** Scroll offset within detail view */
  const [detailScroll, setDetailScroll] = useState(0);

  // Find the last assistant message (for detail views)
  const lastAssistantMsg = [...state.messages].reverse().find(m => m.role === 'assistant');

  useInput((input, key) => {
    // Ctrl+C to exit
    if (input === 'c' && key.ctrl) {
      exit();
      return;
    }

    // Escape — return to chat from detail view, or clear input in chat
    if (key.escape) {
      if (state.viewMode !== 'chat') {
        setState(s => ({ ...s, viewMode: 'chat' }));
        setDetailScroll(0);
        return;
      }
      // In chat mode, escape clears input (handled by InputBar)
      return;
    }

    // Ctrl+O — open/close tools detail view
    if (input === 'o' && key.ctrl) {
      if (state.viewMode === 'tools') {
        setState(s => ({ ...s, viewMode: 'chat' }));
        setDetailScroll(0);
      } else {
        setState(s => ({ ...s, viewMode: 'tools' }));
        setDetailScroll(0);
      }
      return;
    }

    // Ctrl+T — open/close stats detail view
    if (input === 't' && key.ctrl) {
      if (state.viewMode === 'stats') {
        setState(s => ({ ...s, viewMode: 'chat' }));
        setDetailScroll(0);
      } else {
        setState(s => ({ ...s, viewMode: 'stats' }));
        setDetailScroll(0);
      }
      return;
    }

    // Arrow keys — scroll
    if (key.upArrow || (input === 'u' && key.ctrl)) {
      if (state.viewMode !== 'chat') {
        setDetailScroll(s => s + 3);
      } else {
        setScrollOffset(s => Math.min(s + 3, Math.max(state.messages.length - 1, 0)));
      }
      return;
    }
    if (key.downArrow || (input === 'd' && key.ctrl)) {
      if (state.viewMode !== 'chat') {
        setDetailScroll(s => Math.max(s - 3, 0));
      } else {
        setScrollOffset(s => Math.max(s - 3, 0));
      }
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
      viewMode: 'chat',
      statusText: 'thinking...',
    }));
    setInputValue('');
    setScrollOffset(0);

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

  const addMessage = useCallback((msg: ChatMessage) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
    setScrollOffset(0);
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

  useEffect(() => {
    (globalThis as any).__kondiUI = {
      addMessage,
      setStatus,
      updateLastAssistant,
      getState: () => state,
    };
  }, [addMessage, setStatus, updateLastAssistant, state]);

  const chatHeight = Math.max(rows - 6, 5);

  // Detail view — full screen overlay
  if (state.viewMode !== 'chat') {
    return (
      <Box flexDirection="column" height={rows}>
        <DetailView
          messages={state.messages}
          mode={state.viewMode}
          maxHeight={rows - 2}
          scrollOffset={detailScroll}
        />
        <Box paddingX={1}>
          <Text dimColor>
            Esc:back to chat ↑↓:scroll {state.viewMode === 'tools' ? '^T:switch to stats' : '^O:switch to tools'}
          </Text>
        </Box>
      </Box>
    );
  }

  // Chat view — normal mode
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexGrow={1} height={chatHeight}>
        <ChatView
          messages={state.messages}
          maxHeight={chatHeight}
          scrollOffset={scrollOffset}
        />
      </Box>
      <StatusBar
        status={state.statusText}
        isProcessing={state.isProcessing}
      />
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
