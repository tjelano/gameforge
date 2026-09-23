'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

export default function ExportPage() {
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
  const [selectedStyleId, setSelectedStyleId] = useState('');
  const styleId = selectedStyleId || styles[0]?.id || '';
  const [subdir, setSubdir] = useState('godot');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ exported: number; skipped: number; targetDir: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    if (running || !styleId || !subdir.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleId, subdir: subdir.trim() }),
      });
      const body = await res.json();
      if (body.success) {
        setResult(body.data);
      } else {
        setError(body.error ?? 'Export failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Export</h1>
      <p className="page-subtitle">
        Copy one Style Bible&apos;s active asset images into <code>storage/exports/</code> for your Godot
        project (2D only for V1).
      </p>

      {stylesLoading ? (
        <p className="page-subtitle">Loading…</p>
      ) : !stylesError && styles.length === 0 ? (
        <div className="empty-state">
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before exporting.
        </div>
      ) : (
        <form className="card" onSubmit={handleExport} style={{ maxWidth: 420 }}>
          <StyleBiblePicker styles={styles} value={styleId} onChange={setSelectedStyleId} />

          {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 14 }}>{stylesError}</p>}

          <div className="field">
            <label htmlFor="subdir">Export folder name</label>
            <input id="subdir" value={subdir} onChange={e => setSubdir(e.target.value)} placeholder="godot" />
          </div>

          <button className="btn btn-primary" type="submit" disabled={running || !styleId || !subdir.trim() || stylesLoading}>
            {running ? 'Exporting…' : 'Export to Godot'}
          </button>

          {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 14 }}>{error}</p>}

          {result && (
            <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 14 }}>
              Exported {result.exported} asset{result.exported === 1 ? '' : 's'}
              {result.skipped > 0 ? ` (${result.skipped} skipped)` : ''} to <code>{result.targetDir}</code>.
            </p>
          )}
        </form>
      )}
    </>
  );
}
