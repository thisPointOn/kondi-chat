/**
 * Main App component.
 *
 * Uses Ink's Static for completed messages — they go to terminal scrollback
 * and are scrollable with Shift+PageUp/PageDown (terminal native scroll).
 *
 * Only the current working message + input are in the dynamic area.
 * This means full messages are always visible — no clipping, no truncation.
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
  const [queuedInputs, setQueuedInputs] = useState<string[]>([]);

  // Committed messages (rendered via Static — terminal scrollback)
  const [committed, setCommitted] = useState<ChatMessage[]>([]);
  // Current working message (dynamic, updates during processing)
  const [working, setWorking] = useState<ChatMessage | null>(null);

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
    if (input === 'e' && key.ctrl || input === 'm' && key.ctrl) {
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

  const runTurn = useCallback(async (text: string) => {
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    // Commit user message immediately (goes to scrollback)
    setCommitted(c => [...c, userMsg]);
    setState(s => ({
      ...s,
      messages: [...s.messages, userMsg],
      isProcessing: true,
      viewMode: 'chat',
      statusText: 'thinking...',
      activity: [],
      showActivity: false,
    }));
    setWorking(null);

    try {
      await onSubmit(text);
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

    // Commit the working message and clear it
    setWorking(prev => {
      if (prev) setCommitted(c => [...c, prev]);
      return null;
    });
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
  }, [state.isProcessing, runTurn]);

  useEffect(() => {
    if (!state.isProcessing && queuedInputs.length > 0) {
      const [next, ...rest] = queuedInputs;
      setQueuedInputs(rest);
      void runTurn(next);
    }
  }, [state.isProcessing, queuedInputs, runTurn]);

  // UI bridge
  const addMessage = useCallback((msg: ChatMessage) => {
    setState(s => ({ ...s, messages: [...s.messages, msg] }));
    if (msg.role === 'assistant') {
      setWorking(msg);
    } else {
      setCommitted(c => [...c, msg]);
    }
  }, []);

  const setStatus = useCallback((text: string) => {
    setState(s => ({ ...s, statusText: text }));
  }, []);

  const updateLastAssistant = useCallback((update: Partial<ChatMessage>) => {
    setWorking(prev => prev ? { ...prev, ...update } : prev);
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

  const updateMessage = useCallback((id: string, update: Partial<ChatMessage>) => {
    setWorking(prev => prev && prev.id === id ? { ...prev, ...update } : prev);
    setState(s => ({
      ...s,
      messages: s.messages.map(m => m.id === id ? { ...m, ...update } : m),
    }));
  }, []);

  const addActivity = useCallback((entry: ActivityEntry) => {
    setState(s => ({ ...s, activity: [...s.activity, entry] }));
  }, []);

  const clearActivity = useCallback(() => {
    setState(s => ({ ...s, activity: [] }));
  }, []);

  useEffect(() => {
    (globalThis as any).__kondiUI = {
      addMessage, setStatus, updateLastAssistant, updateMessage,
      addActivity, clearActivity,
      getState: () => state,
    };
  }, [addMessage, setStatus, updateLastAssistant, updateMessage, addActivity, clearActivity, state]);

  const lastModelUsed = [...state.messages].reverse().find(m => m.role === 'assistant' && m.modelLabel)?.modelLabel || 'auto';

  // Detail views
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
            {state.viewMode !== 'message' && ' ^E:message'}
          </Text>
        </Box>
      </Box>
    );
  }

  // Chat view
  return (
    <Box flexDirection="column">
      {/* Committed messages — terminal scrollback, Shift+PageUp to scroll */}
      <Static items={committed}>
        {(msg) => <CommittedMessage key={msg.id} message={msg} />}
      </Static>

      {/* Working message — updates live during processing */}
      {working && <WorkingMessage message={working} />}

      {/* Bottom area */}
      <StatusBar status={state.statusText} isProcessing={state.isProcessing} queued={queuedInputs.length} />
      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isProcessing={state.isProcessing}
        aliases={aliases}
        queuedCount={queuedInputs.length}
      />
      <Box paddingX={2}>
        <Text dimColor>model: {lastModelUsed}</Text>
      </Box>
    </Box>
  );
}

// --- Committed message (written once to scrollback via Static) ---
function CommittedMessage({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text bold color="blue">{'❯ '}{message.content}</Text>
      </Box>
    );
  }

  if (message.role === 'system') {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color="yellow">{message.content}</Text>
      </Box>
    );
  }

  // Assistant — full message with tools and stats
  const label = message.modelLabel || 'assistant';
  const hasTools = message.toolCalls && message.toolCalls.length > 0;
  const content = message.content || '';
  const hasContent = content.trim() && content !== '(max tool iterations reached)';

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column">
      <Text bold color="green">{'● '}{label}</Text>
      {hasTools && (
        <Box marginLeft={2} flexDirection="column">
          {message.toolCalls!.map((tc, i) => (
            <Text key={`tc-${i}`} dimColor>
              {'⎿ '}{tc.name}({tc.args}){tc.isError ? ' ✗' : ''}
            </Text>
          ))}
        </Box>
      )}
      {hasContent && (
        <Box marginLeft={2}>
          <Text wrap="wrap">{content}</Text>
        </Box>
      )}
      {!hasContent && hasTools && (
        <Box marginLeft={2}>
          <Text dimColor>Done ({message.toolCalls!.length} tool calls)</Text>
        </Box>
      )}
      {message.stats && (
        <Box marginLeft={2}>
          <Text dimColor>
            {'▸ '}{message.stats.inputTokens.toLocaleString()}in / {message.stats.outputTokens.toLocaleString()}out · ${message.stats.costUsd.toFixed(4)} · {message.stats.models.join(', ')}{message.stats.iterations > 1 ? ` · ${message.stats.iterations} steps` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// --- Working message (live updates during processing) ---
function WorkingMessage({ message }: { message: ChatMessage }) {
  const label = message.modelLabel || '...';
  const hasTools = message.toolCalls && message.toolCalls.length > 0;
  const content = message.content || '';
  const hasContent = content.trim() && content !== '(max tool iterations reached)';

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column">
      <Text bold color="green">{'● '}{label}</Text>
      {hasTools && (
        <Box marginLeft={2} flexDirection="column">
          {message.toolCalls!.slice(-7).map((tc, i) => (
            <Text key={`wtc-${i}`} color="cyan">
              {'⎿ '}{tc.name}({tc.args}){tc.isError ? ' ✗' : ''}
            </Text>
          ))}
          {message.toolCalls!.length > 7 && (
            <Text dimColor>  ... {message.toolCalls!.length - 7} more</Text>
          )}
        </Box>
      )}
      {hasContent && (
        <Box marginLeft={2}>
          <Text wrap="wrap">{content}</Text>
        </Box>
      )}
    </Box>
  );
}
