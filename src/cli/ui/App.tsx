/**
 * Main App component — the root of the Ink TUI.
 *
 * Rendering strategy:
 * - Scrollable chat window stays above a fixed input bar
 * - Streaming updates re-render in place
 * - Detail views (tools/stats/message) take over the full screen
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { DetailView } from './DetailView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import { ChatView } from './ChatView.js';
import type { ChatMessage, AppState, ViewMode, ActivityEntry } from './types.js';

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
    activity: [],
    showActivity: false,
  });

  const [chatScroll, setChatScroll] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [detailScroll, setDetailScroll] = useState(0);
  const [queuedInputs, setQueuedInputs] = useState<string[]>([]);

  // --- Keyboard shortcuts ---
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) { exit(); return; }

    if (key.escape) {
      if (state.viewMode !== 'chat') {
        setState(s => ({ ...s, viewMode: 'chat' }));
        setDetailScroll(0);
      }
      setChatScroll(0);
      return;
    }

    if (input === 'o' && key.ctrl) {
      setState(s => ({ ...s, viewMode: s.viewMode === 'tools' ? 'chat' : 'tools' }));
      setDetailScroll(0);
      return;
    }
    if (input === 'e' && key.ctrl) {
      setState(s => ({ ...s, viewMode: s.viewMode === 'message' ? 'chat' : 'message' }));
      setDetailScroll(0);
      return;
    }
    if (input === 't' && key.ctrl) {
      setState(s => ({ ...s, viewMode: s.viewMode === 'stats' ? 'chat' : 'stats' }));
      setDetailScroll(0);
      return;
    }
    if (input === 'm' && key.ctrl) {
      setState(s => ({ ...s, viewMode: s.viewMode === 'message' ? 'chat' : 'message' }));
      setDetailScroll(0);
      return;
    }
    if (input === 'a' && key.ctrl) {
      setState(s => ({ ...s, showActivity: !s.showActivity }));
      return;
    }

    if (state.viewMode !== 'chat') {
      if (key.upArrow) { setDetailScroll(s => s + 3); return; }
      if (key.downArrow) { setDetailScroll(s => Math.max(s - 3, 0)); return; }
    } else {
      // Scroll chat history while staying in chat mode
      if (key.upArrow) { setChatScroll(s => s + 1); return; }
      if (key.downArrow) { setChatScroll(s => Math.max(s - 1, 0)); return; }
    }
  });

  // --- Submit handler with queue so typing works during streaming ---
  const runTurn = useCallback(async (text: string) => {
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    setState(s => ({
      ...s,
      messages: [...s.messages, userMsg],
      isProcessing: true,
      viewMode: 'chat',
      statusText: 'thinking...',
      activity: [],
      showActivity: false,
    }));
    setChatScroll(0);

    try {
      await onSubmit(text);
    } catch (error) {
      const errMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        role: 'system',
        content: `Error: ${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      };
      setState(s => ({ ...s, messages: [...s.messages, errMsg] }));
    }

    setState(s => ({ ...s, isProcessing: false, statusText: '' }));
  }, [onSubmit]);

  const handleSubmit = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (state.isProcessing) {
      setQueuedInputs(q => {
        const next = [...q, trimmed];
        setState(s => ({ ...s, statusText: `queued (${next.length})` }));
        return next;
      });
      setInputValue('');
      return;
    }

    setInputValue('');
    void runTurn(trimmed);
  }, [state.isProcessing, runTurn, queuedInputs.length]);

  // Auto-run queued messages when the current turn finishes
  useEffect(() => {
    if (!state.isProcessing && queuedInputs.length > 0) {
      const [next, ...rest] = queuedInputs;
      setQueuedInputs(rest);
      void runTurn(next);
    }
  }, [state.isProcessing, queuedInputs, runTurn]);

  // --- UI bridge methods (called by agent loop) ---
  const addMessage = useCallback((msg: ChatMessage) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
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

  const addActivity = useCallback((entry: ActivityEntry) => {
    setState(s => ({ ...s, activity: [...s.activity, entry] }));
  }, []);

  const clearActivity = useCallback(() => {
    setState(s => ({ ...s, activity: [] }));
  }, []);

  // Expose bridge globally
  useEffect(() => {
    (globalThis as any).__kondiUI = {
      addMessage, setStatus, updateLastAssistant,
      addActivity, clearActivity,
      getState: () => state,
    };
  }, [addMessage, setStatus, updateLastAssistant, addActivity, clearActivity, state]);

  // --- Detail views (full screen) ---
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
            Esc:back ↑↓:scroll
            {state.viewMode !== 'tools' && ' ^O:tools'}
            {state.viewMode !== 'stats' && ' ^T:stats'}
            {state.viewMode !== 'message' && ' ^M:message'}
          </Text>
        </Box>
      </Box>
    );
  }

  // --- Chat view ---
  const activityCount = state.activity.length;
  const hasActivity = activityCount > 0;

  return (
    <Box flexDirection="column" height={rows}>
      {/* Zone 1: Scrollable chat — takes all remaining space */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <ChatView messages={state.messages} scrollOffset={chatScroll} />
      </Box>

      {/* Activity log — collapsed 1-line or expanded up to 5 lines, never grows unbounded */}
      {hasActivity && (
        <Box flexDirection="column" flexShrink={0} paddingX={1} borderStyle="single" borderColor="gray">
          {state.showActivity ? (
            state.activity.slice(-5).map((entry, idx) => (
              <Text
                key={`act-${idx}-${entry.type}`}
                color={entry.type === 'error' ? 'red' : entry.type === 'tool' ? 'cyan' : entry.type === 'result' ? undefined : 'yellow'}
                dimColor={entry.type === 'result'}
              >
                {entry.type === 'step' ? '> ' : entry.type === 'tool' ? '  > ' : entry.type === 'result' ? '    ' : '  ! '}{entry.text}
              </Text>
            ))
          ) : (
            <Text dimColor>
              {state.activity[activityCount - 1]?.text || ''}
              {activityCount > 1 ? ` (${activityCount} steps — ^A expand)` : ''}
            </Text>
          )}
        </Box>
      )}

      {/* Zone 2: Bottom area — NEVER pushed off screen */}
      <Box flexDirection="column" flexShrink={0}>
        <StatusBar status={state.statusText} isProcessing={state.isProcessing} queued={queuedInputs.length} />
        <InputBar
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          isProcessing={state.isProcessing}
          aliases={aliases}
          queuedCount={queuedInputs.length}
        />
      </Box>
    </Box>
  );
}
