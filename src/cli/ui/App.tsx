/**
 * Main App component — the root of the Ink TUI.
 *
 * Uses Ink's Static component for committed messages (never re-render)
 * and a dynamic area for the active/streaming message + input.
 * This prevents long chat histories from causing render overflow.
 *
 * Modes:
 *   - chat: scrollable messages + input bar
 *   - tools/stats/message: full-screen detail view, Escape returns
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, Static, useInput, useApp, useStdout } from 'ink';
import { DetailView } from './DetailView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import type { ChatMessage, AppState, ViewMode, ActivityEntry } from './types.js';

export interface AppProps {
  onSubmit: (input: string) => Promise<void>;
  initialStatus: string;
  aliases: string[];
}

/** Max lines for the active streaming message before truncation */
const MAX_ACTIVE_LINES = 20;

function truncate(text: string, maxLines: number): { display: string; full: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { display: text, full: text, truncated: false };
  return {
    display: lines.slice(-maxLines).join('\n'),
    full: text,
    truncated: true,
  };
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

  const [inputValue, setInputValue] = useState('');
  const [detailScroll, setDetailScroll] = useState(0);

  // Committed messages (rendered via Static — never re-render)
  const [committed, setCommitted] = useState<ChatMessage[]>([]);
  // Active message being streamed (rendered dynamically)
  const [activeMessage, setActiveMessage] = useState<ChatMessage | null>(null);

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) { exit(); return; }

    if (key.escape) {
      if (state.viewMode !== 'chat') {
        setState(s => ({ ...s, viewMode: 'chat' }));
        setDetailScroll(0);
      }
      return;
    }

    if (input === 'o' && key.ctrl) {
      setState(s => ({ ...s, viewMode: s.viewMode === 'tools' ? 'chat' : 'tools' }));
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

    // Scroll in detail views
    if (state.viewMode !== 'chat') {
      if (key.upArrow) { setDetailScroll(s => s + 3); return; }
      if (key.downArrow) { setDetailScroll(s => Math.max(s - 3, 0)); return; }
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

    // Commit the user message immediately
    setCommitted(c => [...c, userMsg]);
    setActiveMessage(null);

    setState(s => ({
      ...s,
      messages: [...s.messages, userMsg],
      isProcessing: true,
      viewMode: 'chat',
      statusText: 'thinking...',
      activity: [],
      showActivity: false,
    }));
    setInputValue('');

    try {
      await onSubmit(text.trim());
    } catch (error) {
      const errMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'system',
        content: `Error: ${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      };
      setCommitted(c => [...c, errMsg]);
      setState(s => ({ ...s, messages: [...s.messages, errMsg] }));
    }

    setState(s => ({ ...s, isProcessing: false, statusText: '' }));
  }, [state.isProcessing, onSubmit]);

  // UI bridge methods
  const addMessage = useCallback((msg: ChatMessage) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
    // If it's an assistant message, set it as active (for streaming)
    if (msg.role === 'assistant') {
      setActiveMessage(msg);
    } else {
      // System messages go straight to committed
      setCommitted(c => [...c, msg]);
    }
  }, []);

  const setStatus = useCallback((text: string) => {
    setState(s => ({ ...s, statusText: text }));
  }, []);

  const updateLastAssistant = useCallback((update: Partial<ChatMessage>) => {
    setActiveMessage(prev => prev ? { ...prev, ...update } : prev);
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

  // Commit the active message when processing finishes
  useEffect(() => {
    if (!state.isProcessing && activeMessage) {
      setCommitted(c => [...c, activeMessage]);
      setActiveMessage(null);
    }
  }, [state.isProcessing, activeMessage]);

  useEffect(() => {
    (globalThis as any).__kondiUI = {
      addMessage, setStatus, updateLastAssistant,
      addActivity, clearActivity,
      getState: () => state,
    };
  }, [addMessage, setStatus, updateLastAssistant, addActivity, clearActivity, state]);

  // Detail views — full screen overlay
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
            {state.viewMode === 'tools' ? ' ^T:stats ^M:message' :
             state.viewMode === 'stats' ? ' ^O:tools ^M:message' :
             ' ^O:tools ^T:stats'}
          </Text>
        </Box>
      </Box>
    );
  }

  // Chat view
  const activityLines = state.showActivity
    ? Math.min(state.activity.length, 10)
    : (state.isProcessing && state.activity.length > 0 ? 1 : 0);

  // Active message display (streaming)
  const activeDisplay = activeMessage ? truncate(activeMessage.content, MAX_ACTIVE_LINES) : null;

  return (
    <Box flexDirection="column">
      {/* Committed messages — Static never re-renders these */}
      <Static items={committed}>
        {(msg) => (
          <Box key={msg.id} paddingX={1}>
            {msg.role === 'user' ? (
              <Text bold color="blue">{msg.content}</Text>
            ) : msg.role === 'system' ? (
              <Text color="yellow">{msg.content}</Text>
            ) : (
              <Box flexDirection="column">
                <Box>
                  <Text bold color="green">[{msg.modelLabel || 'assistant'}]</Text>
                  {msg.stats && <Text dimColor> (${msg.stats.costUsd.toFixed(4)})</Text>}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <Text dimColor> ({msg.toolCalls.length} tools)</Text>
                  )}
                </Box>
                <Box marginLeft={2}>
                  <Text wrap="wrap">{msg.content}</Text>
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Static>

      {/* Active streaming message */}
      {activeMessage && activeDisplay && (
        <Box paddingX={1} flexDirection="column">
          <Box>
            <Text bold color="green">[{activeMessage.modelLabel || '...'}]</Text>
            {state.isProcessing && <Text color="yellow"> streaming...</Text>}
          </Box>
          <Box marginLeft={2}>
            {activeDisplay.truncated && (
              <Text dimColor>... ({activeDisplay.full.split('\n').length - MAX_ACTIVE_LINES} lines above — ^M for full)\n</Text>
            )}
            <Text wrap="wrap">{activeDisplay.display}</Text>
          </Box>
        </Box>
      )}

      {/* Activity log */}
      {activityLines > 0 && (
        <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
          {state.showActivity ? (
            state.activity.slice(-10).map((entry, i) => (
              <Text key={i} color={entry.type === 'error' ? 'red' : entry.type === 'tool' ? 'cyan' : entry.type === 'result' ? 'gray' : 'yellow'} dimColor={entry.type === 'result'}>
                {entry.type === 'step' ? '>' : entry.type === 'tool' ? '  >' : entry.type === 'result' ? '    ' : '  !'} {entry.text}
              </Text>
            ))
          ) : (
            <Text color="yellow" dimColor>
              {state.activity[state.activity.length - 1]?.text || ''}
              {state.activity.length > 1 && <Text dimColor> ({state.activity.length} steps — ^A expand)</Text>}
            </Text>
          )}
        </Box>
      )}

      {/* Status + Input */}
      <StatusBar status={state.statusText} isProcessing={state.isProcessing} />
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
