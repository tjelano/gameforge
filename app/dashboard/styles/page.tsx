'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useStyles } from '@/lib/hooks/useStyles';

export default function StylesPage() {
  const { styles, loading, error: stylesError, refresh } = useStyles();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [inspoQuery, setInspoQuery] = useState('');
  const [inspoResults, setInspoResults] = useState<{ slug: string; title?: string; host?: string }[]>([]);
  const [inspoSearching, setInspoSearching] = useState(false);
  const [inspoSearchError, setInspoSearchError] = useState<string | null>(null);
  const [inspoSelectedSlug, setInspoSelectedSlug] = useState<string | null>(null);
  const [inspoPreview, setInspoPreview] = useState<{ tokens: Record<string, string>; provenance: Record<string, string>; lowConfidence: boolean } | null>(null);
  const [inspoPreviewLoading, setInspoPreviewLoading] = useState(false);
  const [inspoPreviewError, setInspoPreviewError] = useState<string | null>(null);
  const [inspoImportName, setInspoImportName] = useState('');
  const [inspoImporting, setInspoImporting] = useState(false);
  const [inspoImportError, setInspoImportError] = useState<string | null>(null);
  // Guard against out-of-order preview responses. A monotonic id per request, not the slug
  // value: comparing by slug alone lets a stale response win when the SAME slug is clicked
  // twice in a row (double-click / click-away-and-back) and the first request resolves last.
  const requestIdRef = useRef(0);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setCreateError(body.error ?? 'Could not create Style Bible.');
        return;
      }
      setName('');
      await refresh();
    } catch {
      setCreateError('Could not reach the server.');
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
    setForkError(null);
    try {
      const res = await fetch(`/api/styles/${styleId}/fork`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setForkError(body.error ?? 'Could not fork this Style Bible.');
        return;
      }
      await refresh();
    } catch {
      setForkError('Could not reach the server.');
    } finally {
      setForkingId(null);
    }
  }

  async function handleInspoSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoQuery.trim() || inspoSearching) return;
    setInspoSearching(true);
    setInspoSearchError(null);
    setInspoResults([]);
    try {
      const res = await fetch('/api/inspo/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'search', query: inspoQuery.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoSearchError(body.error ?? 'Search failed.');
        return;
      }
      setInspoResults(body.data.results ?? []);
    } catch {
      setInspoSearchError('Could not reach the server.');
    } finally {
      setInspoSearching(false);
    }
  }

  async function handleInspoPreview(slug: string) {
    const myRequestId = ++requestIdRef.current;
    setInspoSelectedSlug(slug);
    setInspoPreview(null);
    setInspoPreviewError(null);
    setInspoPreviewLoading(true);
    try {
      const res = await fetch('/api/inspo/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoPreviewError(body.error ?? 'Preview failed.');
        return;
      }
      // Guard against out-of-order responses: only apply if this is still the most recent
      // request. Comparing by request id (not slug) also catches a same-slug double-click —
      // the slug alone wouldn't change between the two requests, but the id does.
      if (myRequestId === requestIdRef.current) {
        setInspoPreview(body.data);
        setInspoImportName(slug);
      }
    } catch {
      // Same out-of-order guard as the success path: an older, slower
      // request's failure shouldn't show an error for the current selection.
      if (myRequestId === requestIdRef.current) {
        setInspoPreviewError('Could not reach the server.');
      }
    } finally {
      // Same guard: don't let a stale request clear the loading flag while a
      // newer request is still genuinely pending.
      if (myRequestId === requestIdRef.current) {
        setInspoPreviewLoading(false);
      }
    }
  }

  async function handleInspoImport(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoImportName.trim() || !inspoPreview || !inspoSelectedSlug || inspoImporting) return;
    setInspoImporting(true);
    setInspoImportError(null);
    try {
      const res = await fetch('/api/styles/import-inspo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: inspoImportName.trim(),
          slug: inspoSelectedSlug,
          tokens: inspoPreview.tokens,
          provenance: inspoPreview.provenance,
          lowConfidence: inspoPreview.lowConfidence,
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoImportError(body.error ?? 'Import failed.');
        return;
      }
      setInspoPreview(null);
      setInspoSelectedSlug(null);
      setInspoResults([]);
      setInspoQuery('');
      setInspoImportName('');
      await refresh();
    } catch {
      setInspoImportError('Could not reach the server.');
    } finally {
      setInspoImporting(false);
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
      {createError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -16, marginBottom: 16 }}>{createError}</p>}

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

      <div className="card" style={{ marginBottom: 32, maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import from Inspo</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Search 832 real production sites and seed a new Style Bible from one of their extracted
          design tokens.
        </p>
        <form onSubmit={handleInspoSearch} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <input
            value={inspoQuery}
            onChange={e => setInspoQuery(e.target.value)}
            placeholder="e.g. warm editorial SaaS"
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
          />
          <button className="btn btn-primary" type="submit" disabled={inspoSearching || !inspoQuery.trim()}>
            {inspoSearching ? 'Searching…' : 'Search'}
          </button>
        </form>
        {inspoSearchError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoSearchError}</p>}

        {inspoResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {inspoResults.map(r => (
              <button
                key={r.slug}
                type="button"
                className="btn"
                onClick={() => handleInspoPreview(r.slug)}
                style={{ textAlign: 'left' }}
              >
                {r.title ?? r.slug} {r.host ? `(${r.host})` : ''}
              </button>
            ))}
          </div>
        )}

        {inspoPreviewLoading && <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>Loading preview…</p>}
        {inspoPreviewError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoPreviewError}</p>}

        {inspoPreview && (
          <div style={{ marginTop: 8 }}>
            {inspoPreview.lowConfidence && (
              <p style={{ color: 'var(--reject)', fontSize: 12, marginBottom: 8 }}>
                Low-confidence import — most fields fell back to defaults. Check the swatches below.
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {Object.entries(inspoPreview.tokens).map(([field, value]) => (
                <div key={field} style={{ fontSize: 11 }}>
                  <div
                    style={{
                      width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)',
                      background: field.startsWith('color') ? value : 'var(--bg)',
                    }}
                    title={`${field}: ${value} (${inspoPreview.provenance[field] ?? 'unknown'})`}
                  />
                  <div style={{ color: 'var(--ink-faint)' }}>{field}</div>
                </div>
              ))}
            </div>
            <form onSubmit={handleInspoImport} style={{ display: 'flex', gap: 10 }}>
              <input
                value={inspoImportName}
                onChange={e => setInspoImportName(e.target.value)}
                placeholder="New Style Bible name"
                style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
              />
              <button className="btn btn-primary" type="submit" disabled={inspoImporting || !inspoImportName.trim()}>
                {inspoImporting ? 'Importing…' : 'Confirm Import'}
              </button>
            </form>
            {inspoImportError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{inspoImportError}</p>}
          </div>
        )}
      </div>

      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}
      {forkError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{forkError}</p>}

      {!loading && !stylesError && styles.length === 0 ? (
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
