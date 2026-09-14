'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';
import { useOllamaModels } from '@/lib/hooks/useOllamaModels';

interface PanelMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolCall?: { name: string; input: { path: string } };
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export function CopilotPanel() {
  const { user } = useCurrentUser();
  const router = useRouter();
  const { models: ollamaModels, host: ollamaHost } = useOllamaModels(!!user);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'chat' | 'history'>('chat');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<'claude' | string>('claude');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  if (!user) return null;

  async function handleOpenHistory() {
    setMode('history');
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/copilot/conversations');
      const body = await res.json();
      if (body.success) setHistory(body.data);
    } catch {
      // Non-fatal -- history just stays empty.
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleSelectConversation(id: string) {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/copilot/conversations/${id}`);
      const body = await res.json();
      if (body.success) {
        setConversationId(body.data.id);
        setMessages(body.data.messages);
        setMode('chat');
      }
    } catch {
      setError('Could not load that conversation.');
    } finally {
      setHistoryLoading(false);
    }
  }

  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setMode('chat');
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');

    try {
      const res = await fetch('/api/copilot/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          text,
          ...(provider !== 'claude' ? { provider: 'ollama', model: provider, ollamaHost } : {}),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'The copilot could not reply.');
        return;
      }
      setConversationId(body.data.conversationId);
      setMessages(prev => [...prev, { role: 'assistant', content: body.data.reply.text, toolCall: body.data.reply.toolCall }]);
      if (body.data.reply.toolCall?.name === 'navigate_to_page') {
        router.push(body.data.reply.toolCall.input.path);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button className="copilot-toggle" onClick={() => setOpen(o => !o)} aria-label="Toggle GameForge copilot">
        {open ? '×' : '?'}
      </button>
      {open && (
        <div className="copilot-panel">
          <div className="copilot-panel-header">
            <strong>GameForge Copilot</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={handleNewChat}>New chat</button>
              <button className="btn" onClick={handleOpenHistory}>History</button>
            </div>
          </div>

          {mode === 'history' ? (
            <div className="copilot-history">
              {historyLoading && <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>Loading…</p>}
              {!historyLoading && history.length === 0 && (
                <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>No previous conversations yet.</p>
              )}
              {history.map(c => (
                <button key={c.id} className="copilot-history-item" onClick={() => handleSelectConversation(c.id)}>
                  <div>{c.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{new Date(c.updatedAt).toLocaleString()}</div>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="copilot-messages">
                {messages.length === 0 && (
                  <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
                    Ask about any GameForge feature, setting, or what to try next on your current project.
                  </p>
                )}
                {messages.map((m, i) => (
                  <div key={m.id ?? i} className={`copilot-message copilot-message-${m.role}`}>
                    {m.content}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {error && <p style={{ color: 'var(--reject)', fontSize: 13, padding: '0 12px' }}>{error}</p>}

              <form className="copilot-input-row" onSubmit={handleSend}>
                <select value={provider} onChange={e => setProvider(e.target.value)} disabled={sending}>
                  <option value="claude">Claude</option>
                  {ollamaModels.map(m => <option key={m} value={m}>{m} (local)</option>)}
                </select>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Ask the copilot…"
                  disabled={sending}
                />
                <button className="btn btn-primary" type="submit" disabled={sending || !input.trim()}>
                  {sending ? '…' : 'Send'}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}
