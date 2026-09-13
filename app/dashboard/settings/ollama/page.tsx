'use client';

import { useEffect, useState } from 'react';

const RECOMMENDED_MODELS = [
  {
    name: 'llama3-groq-tool-use:8b',
    note: 'Recommended -- the only model in our own testing with real published benchmark evidence for tool-calling reliability.',
  },
] as const;

export default function OllamaSettingsPage() {
  const [host, setHost] = useState('');
  const [savedHost, setSavedHost] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullStatus, setPullStatus] = useState<string>('');
  const [pullError, setPullError] = useState<string | null>(null);

  async function refreshModels() {
    try {
      const res = await fetch('/api/settings/ollama/models');
      const body = await res.json();
      if (body.success) setInstalledModels(body.data.models);
    } catch {
      // Non-fatal -- the installed-models list just stays whatever it last was.
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings/ollama');
        const body = await res.json();
        if (body.success) {
          setHost(body.data.host);
          setSavedHost(body.data.host);
        } else {
          setError(body.error ?? 'Could not load settings.');
        }
      } catch {
        setError('Could not reach the server.');
      } finally {
        setLoading(false);
      }
    })();
    refreshModels();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/ollama', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not save.');
      } else {
        setSavedHost(body.data.host);
        setReachable(null);
        refreshModels();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (testing) return;
    setTesting(true);
    setReachable(null);
    try {
      const res = await fetch('/api/settings/ollama/test-connection', { method: 'POST' });
      const body = await res.json();
      setReachable(body.success ? body.data.reachable : false);
    } catch {
      setReachable(false);
    } finally {
      setTesting(false);
    }
  }

  async function handlePull(model: string) {
    if (pulling) return;
    setPulling(model);
    setPullStatus('Starting…');
    setPullError(null);
    try {
      const res = await fetch('/api/settings/ollama/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Pull failed.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const update = JSON.parse(line) as { status: string; total?: number; completed?: number };
          if (update.status === 'success') {
            setPullStatus('Installed');
          } else if (typeof update.total === 'number' && typeof update.completed === 'number' && update.total > 0) {
            setPullStatus(`${update.status} — ${Math.round((update.completed / update.total) * 100)}%`);
          } else {
            setPullStatus(update.status);
          }
        }
      }
      await refreshModels();
    } catch (e: any) {
      setPullError(e.message ?? 'Pull failed.');
    } finally {
      setPulling(null);
    }
  }

  if (loading) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Ollama</h1>
      <p className="page-subtitle">
        Use a local Ollama model instead of Claude for theme, component, and page-layout generation. Ollama has
        no built-in authentication — pointing this at a non-localhost host is your own trust decision.
      </p>

      <form className="card" onSubmit={handleSave} style={{ marginBottom: 24, maxWidth: 480 }}>
        <div className="field">
          <label htmlFor="host">Host</label>
          <input id="host" value={host} onChange={e => setHost(e.target.value)} placeholder="http://localhost:11434" />
        </div>
        {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" type="submit" disabled={saving || !host.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" type="button" disabled={testing} onClick={handleTestConnection}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {reachable !== null && (
          <p style={{ fontSize: 13, marginTop: 8, color: reachable ? 'var(--ink-dim)' : 'var(--reject)' }}>
            {reachable ? `Reachable at ${savedHost}.` : `Could not reach ${savedHost}.`}
          </p>
        )}
      </form>

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>Installed models</h2>
      {installedModels.length === 0 ? (
        <p className="page-subtitle" style={{ marginBottom: 24 }}>None found — pull a recommended model below, or check your connection above.</p>
      ) : (
        <ul style={{ marginBottom: 24 }}>
          {installedModels.map(m => <li key={m}>{m}</li>)}
        </ul>
      )}

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>Recommended models</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {RECOMMENDED_MODELS.map(({ name, note }) => {
          const installed = installedModels.includes(name);
          return (
            <div key={name} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14 }}>{name}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{note}</div>
              </div>
              {installed ? (
                <span className="badge">Installed</span>
              ) : (
                <button className="btn" disabled={pulling !== null} onClick={() => handlePull(name)}>
                  {pulling === name ? pullStatus : 'Pull this model'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 12 }}>{pullError}</p>}
    </>
  );
}
