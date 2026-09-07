'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';

export default function StylesPage() {
  const { styles, loading, refresh } = useStyles();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [forkingId, setForkingId] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await fetch('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function handleFork(styleId: string) {
    setForkingId(styleId);
    try {
      await fetch(`/api/styles/${styleId}/fork`, { method: 'POST' });
      await refresh();
    } finally {
      setForkingId(null);
    }
  }

  return (
    <>
      <h1 className="page-title">Style Bibles</h1>
      <p className="page-subtitle">
        A Style Bible is the visual language every generation in it shares. Only its creator can edit one —
        anyone else forks it into their own independent copy.
      </p>

      <form className="card" onSubmit={handleCreate} style={{ marginBottom: 32, maxWidth: 420, display: 'flex', gap: 10 }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="New Style Bible name"
          style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
        />
        <button className="btn btn-primary" type="submit" disabled={creating || !name.trim()}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>

      {!loading && styles.length === 0 ? (
        <div className="empty-state">No Style Bibles yet. Create the first one above.</div>
      ) : (
        <div className="grid">
          {styles.map(style => {
            const parent = style.forked_from ? styles.find(s => s.id === style.forked_from) : null;
            return (
              <div key={style.id} className="card">
                <div className="frame-label" style={{ marginBottom: 8 }}>
                  {style.id.slice(0, 8)}
                </div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{style.name}</div>
                {style.forked_from && (
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 12 }}>
                    forked from {parent ? parent.name : style.forked_from.slice(0, 8)}
                  </div>
                )}
                <button
                  className="btn"
                  disabled={forkingId === style.id}
                  onClick={() => handleFork(style.id)}
                  style={{ marginTop: style.forked_from ? 0 : 12 }}
                >
                  {forkingId === style.id ? 'Forking…' : 'Fork'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
