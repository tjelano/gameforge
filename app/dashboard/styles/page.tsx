'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useStyles } from '@/lib/hooks/useStyles';

export default function StylesPage() {
  const { styles, loading, error: stylesError, refresh } = useStyles();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

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

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setImportFile(e.target.files?.[0] ?? null);
    setImportError(null);
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importName.trim() || !importFile || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const tokensJson = await importFile.text();
      const res = await fetch('/api/styles/import-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: importName.trim(), tokensJson }),
      });
      const body = await res.json();
      if (!body.success) {
        setImportError(body.error ?? 'Import failed.');
        return;
      }
      setImportName('');
      setImportFile(null);
      await refresh();
    } catch {
      setImportError('Could not reach the server.');
    } finally {
      setImporting(false);
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

      <form className="card" onSubmit={handleImport} style={{ marginBottom: 32, maxWidth: 420 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import from design tokens</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Upload a W3C Design Tokens JSON file (the format most Figma-to-code plugins export) to seed a new
          Style Bible from an existing design system.
        </p>
        <div className="field">
          <label htmlFor="importName">New Style Bible name</label>
          <input id="importName" value={importName} onChange={e => setImportName(e.target.value)} placeholder="Imported design" />
        </div>
        <div className="field">
          <label htmlFor="importFile">Tokens JSON file</label>
          <input id="importFile" type="file" accept="application/json,.json" onChange={handleImportFileChange} />
        </div>
        {importError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{importError}</p>}
        <button className="btn btn-primary" type="submit" disabled={importing || !importName.trim() || !importFile}>
          {importing ? 'Importing…' : 'Import'}
        </button>
      </form>

      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}

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
                <div style={{ display: 'flex', gap: 8, marginTop: style.forked_from ? 0 : 12 }}>
                  <Link className="btn" href={`/dashboard/styles/${style.id}`}>
                    View
                  </Link>
                  <button
                    className="btn"
                    disabled={forkingId === style.id}
                    onClick={() => handleFork(style.id)}
                  >
                    {forkingId === style.id ? 'Forking…' : 'Fork'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
