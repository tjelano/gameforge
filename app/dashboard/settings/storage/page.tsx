'use client';

import { useState } from 'react';

export default function StorageSettingsPage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleCleanup() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/storage/cleanup', { method: 'POST' });
      const body = await res.json();
      setResult(
        body.success
          ? `Removed ${body.data.removed} orphaned file${body.data.removed === 1 ? '' : 's'}.`
          : (body.error ?? 'Cleanup failed.')
      );
    } catch {
      setResult('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Storage</h1>
      <p className="page-subtitle">
        Generated files that no longer belong to any asset or in-flight job pile up in{' '}
        <code>storage/images/</code> and <code>storage/themes/</code>. Clean them up on demand — nothing
        runs automatically here.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Clean up orphaned files</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 16 }}>
          Safe to run any time — active assets, soft-deleted assets, and pending/processing/complete jobs
          are never touched, in either directory.
        </p>
        <button className="btn btn-primary" onClick={handleCleanup} disabled={running}>
          {running ? 'Cleaning…' : 'Clean Up Orphaned Files'}
        </button>
        {result && <p style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-dim)' }}>{result}</p>}
      </div>
    </>
  );
}
