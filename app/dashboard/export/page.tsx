'use client';

import { useState } from 'react';

export default function ExportPage() {
  const [subdir, setSubdir] = useState('godot');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ exported: number; skipped: number; targetDir: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    if (running || !subdir.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: subdir.trim() }),
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
        Copy every active asset&apos;s image into <code>storage/exports/</code> for your Godot project
        (2D only for V1).
      </p>

      <form className="card" onSubmit={handleExport} style={{ maxWidth: 420 }}>
        <div className="field">
          <label htmlFor="subdir">Export folder name</label>
          <input id="subdir" value={subdir} onChange={e => setSubdir(e.target.value)} placeholder="godot" />
        </div>

        <button className="btn btn-primary" type="submit" disabled={running || !subdir.trim()}>
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
    </>
  );
}
