'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
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

// Conversations are genuinely persisted server-side (CopilotConversationService/
// CopilotMessageService), but this panel's own React state was not -- a full
// page reload silently started a brand-new empty chat every time, with no way
// to tell the last conversation still existed short of manually opening
// History. Remembering the active conversation id here (not the messages
// themselves, which are re-fetched fresh) closes that gap.
const ACTIVE_CONVERSATION_KEY = 'gameforge-copilot-active-conversation-id';

export function CopilotPanel() {
  const { user } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const { models: ollamaModels, host: ollamaHost } = useOllamaModels(!!user);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'chat' | 'history'>('chat');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  // null = no explicit pick yet -- falls back to the first available Ollama
  // model (free/local) over Claude/OpenRouter (both paid) via
  // selectedProvider below. A real user pick always wins once made.
  const [pickedProvider, setPickedProvider] = useState<'claude' | 'openrouter' | string | null>(null);
  const selectedProvider = pickedProvider ?? (ollamaModels.length > 0 ? ollamaModels[0] : 'claude');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  // Resume the last active conversation on mount, once we know who's logged
  // in (a stored id from a different user's session on this machine is
  // simply not found by loadConversation below and left alone).
  //
  // Persisting the id is done as an explicit side effect at each place the
  // state actually changes (below), not via a separate useEffect watching
  // conversationId -- a reactive effect on that state would also fire once
  // on this very first mount, while conversationId is still its initial
  // null, and immediately clear whatever was just stored from a *previous*
  // session before this resume effect (gated on the async user fetch
  // resolving) ever got a chance to read it.
  useEffect(() => {
    if (!user) return;
    let storedId: string | null = null;
    try {
      storedId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    } catch {
      // Storage unavailable (private browsing, blocked) -- just start fresh.
    }
    if (storedId) loadConversation(storedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (!user || pathname === '/login') return null;

  function persistActiveConversationId(id: string | null) {
    try {
      if (id) {
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
      } else {
        localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
      }
    } catch {
      // Non-fatal -- just means the next reload won't auto-resume.
    }
  }

  /** Returns whether the conversation loaded successfully -- callers reacting
   * to an explicit user action (picking from History) show an error on
   * false; the silent on-mount auto-resume doesn't. */
  async function loadConversation(id: string): Promise<boolean> {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/copilot/conversations/${id}`);
      const body = await res.json();
      if (body.success) {
        setConversationId(body.data.id);
        setMessages(body.data.messages);
        persistActiveConversationId(body.data.id);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setHistoryLoading(false);
    }
  }

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
    const ok = await loadConversation(id);
    if (ok) {
      setMode('chat');
    } else {
      setError('Could not load that conversation.');
    }
  }

  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setMode('chat');
    persistActiveConversationId(null);
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
          ...(selectedProvider === 'openrouter'
            ? { provider: 'openrouter' }
            : selectedProvider !== 'claude'
              ? { provider: 'ollama', model: selectedProvider, ollamaHost }
              : {}),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'The copilot could not reply.');
        return;
      }
      setConversationId(body.data.conversationId);
      persistActiveConversationId(body.data.conversationId);
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
                <select value={selectedProvider} onChange={e => setPickedProvider(e.target.value)} disabled={sending}>
                  <option value="claude">Claude</option>
                  <option value="openrouter">OpenRouter</option>
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
