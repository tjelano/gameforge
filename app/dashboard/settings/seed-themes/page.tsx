'use client';

import { useState } from 'react';

export default function SeedThemesSettingsPage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleImport() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/settings/seed-themes/import', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setResult(body.error ?? 'Import failed.');
        return;
      }
      const { imported, skipped, errors } = body.data;
      let message = `Imported ${imported} theme${imported === 1 ? '' : 's'}, skipped ${skipped} already present.`;
      if (errors.length > 0) {
        message += ` Errors: ${errors.join('; ')}`;
      }
      setResult(message);
    } catch {
      setResult('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Seed Themes</h1>
      <p className="page-subtitle">
        Populate your Style Bibles with ~58 ready-made themes pulled from DaisyUI and Bootswatch — real,
        open-source, human-designed color and typography combinations, at zero generation cost. Safe to
        run again later: themes already imported are skipped, never duplicated.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import Seed Themes</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 16 }}>
          Fetches both sources and creates a Style Bible + theme asset for each one that isn&apos;t already
          in your library.
        </p>
        <button className="btn btn-primary" onClick={handleImport} disabled={running} aria-busy={running}>
          {running ? 'Importing…' : 'Import Seed Themes'}
        </button>
        {result && <p aria-live="polite" style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-dim)' }}>{result}</p>}
      </div>
    </>
  );
}
