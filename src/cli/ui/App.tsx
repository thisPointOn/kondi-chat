/**
 * Main App component — the root of the Ink TUI.
 *
 * Rendering strategy (borrowed from Claude Code):
 * - Committed messages use Ink's Static — written once to stdout,
 *   live in terminal's native scrollback, never re-rendered
 * - Active streaming message is in the dynamic area, truncated
 * - Input bar is always at the bottom
 * - Detail views (tools/stats/message) take over the full screen
 *
 * The terminal's native scroll (Shift+PageUp/Down) handles scrollback.
 * Our scroll keys handle detail views.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, Static, Newline, useInput, useApp, useStdout } from 'ink';
import { DetailView } from './DetailView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import type { ChatMessage, AppState, ViewMode, ActivityEntry } from './types.js';

export interface AppProps {
  onSubmit: (input: string) => Promise<void>;
  initialStatus: string;
  aliases: string[];
}

const MAX_ACTIVE_LINES = 25;

function truncateBottom(text: string, maxLines: number): { display: string; linesAbove: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { display: text, linesAbove: 0 };
  return {
    display: lines.slice(-maxLines).join('\n'),
    linesAbove: lines.length - maxLines,
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
  const [committed, setCommitted] = useState<ChatMessage[]>([]);
  const [activeMessage, setActiveMessage] = useState<ChatMessage | null>(null);

  // --- Keyboard shortcuts ---
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

    if (state.viewMode !== 'chat') {
      if (key.upArrow) { setDetailScroll(s => s + 3); return; }
      if (key.downArrow) { setDetailScroll(s => Math.max(s - 3, 0)); return; }
    }
  });

  // --- Submit handler ---
  const handleSubmit = useCallback(async (text: string) => {
    if (!text.trim() || state.isProcessing) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: text.trim(),
      timestamp: new Date().toISOString(),
    };

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
        id: `msg-err-${Date.now()}`,
        role: 'system',
        content: `Error: ${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      };
      setCommitted(c => [...c, errMsg]);
      setState(s => ({ ...s, messages: [...s.messages, errMsg] }));
    }

    setState(s => ({ ...s, isProcessing: false, statusText: '' }));
  }, [state.isProcessing, onSubmit]);

  // --- UI bridge methods (called by agent loop) ---
  const addMessage = useCallback((msg: ChatMessage) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
    if (msg.role === 'assistant') {
      setActiveMessage(msg);
    } else {
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

  // Commit active message when done
  useEffect(() => {
    if (!state.isProcessing && activeMessage) {
      setCommitted(c => [...c, activeMessage]);
      setActiveMessage(null);
    }
  }, [state.isProcessing, activeMessage]);

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
  const showActivity = state.showActivity
    ? Math.min(activityCount, 10)
    : (state.isProcessing && activityCount > 0 ? 1 : 0);

  const activeDisplay = activeMessage
    ? truncateBottom(activeMessage.content, MAX_ACTIVE_LINES)
    : null;

  return (
    <Box flexDirection="column">
      {/* Committed messages — Ink Static: written once, terminal handles scroll */}
      <Static items={committed}>
        {(msg) => <CommittedMessage key={msg.id} message={msg} />}
      </Static>

      {/* Active streaming message */}
      {activeMessage && (
        <Box paddingX={1} flexDirection="column">
          <Box>
            <Text bold color="green">[{activeMessage.modelLabel || '...'}]</Text>
            {state.isProcessing && <Text color="yellow"> ...</Text>}
            {activeMessage.stats && (
              <Text dimColor> (${activeMessage.stats.costUsd.toFixed(4)})</Text>
            )}
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {activeDisplay && activeDisplay.linesAbove > 0 && (
              <Text dimColor>... {activeDisplay.linesAbove} lines above (^M for full)</Text>
            )}
            <Text wrap="wrap">{activeDisplay?.display || ''}</Text>
          </Box>
        </Box>
      )}

      {/* Activity log */}
      {showActivity > 0 && (
        <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
          {state.showActivity ? (
            state.activity.slice(-10).map((entry, i) => (
              <Text
                key={i}
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

      {/* Status + Input (always at bottom) */}
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

// --- Committed message rendering (used by Static) ---

function CommittedMessage({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <Box paddingX={1}>
        <Text bold color="blue">{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'system') {
    return (
      <Box paddingX={1}>
        <Text color="yellow">{message.content}</Text>
      </Box>
    );
  }

  // Assistant
  const indicators: string[] = [];
  if (message.toolCalls && message.toolCalls.length > 0) {
    indicators.push(`${message.toolCalls.length} tools`);
  }
  if (message.stats) {
    indicators.push(`$${message.stats.costUsd.toFixed(4)}`);
    if (message.stats.iterations > 1) {
      indicators.push(`${message.stats.iterations} iters`);
    }
  }

  return (
    <Box paddingX={1} flexDirection="column">
      <Box>
        <Text bold color="green">[{message.modelLabel || 'assistant'}]</Text>
        {indicators.length > 0 && (
          <Text dimColor> ({indicators.join(' | ')})</Text>
        )}
      </Box>
      <Box marginLeft={2}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
      <Text>{''}</Text>
    </Box>
  );
}
