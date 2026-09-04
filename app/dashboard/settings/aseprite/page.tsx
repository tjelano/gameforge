'use client';

import { useEffect, useState } from 'react';

export default function AsepriteSettingsPage() {
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/aseprite-path');
        const body = await res.json();
        if (ignore) return;
        if (body.success) setPath(body.data.path);
      } catch {
        if (!ignore) setResult('Could not reach the server.');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch('/api/settings/aseprite-path', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const body = await res.json();
      setResult(body.success ? 'Saved.' : (body.error ?? 'Save failed.'));
    } catch {
      setResult('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Aseprite</h1>
      <p className="page-subtitle">
        Set the path to your Aseprite executable so the &quot;Edit in Aseprite&quot; button on asset
        pages can launch it. This is machine-specific — it is never synced to git.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div className="field">
          <label htmlFor="aseprite-path">Aseprite executable path</label>
          <input
            id="aseprite-path"
            value={path}
            onChange={e => setPath(e.target.value)}
            placeholder="C:\Program Files\Aseprite\Aseprite.exe"
          />
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ marginTop: 12 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {result && <p style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-dim)' }}>{result}</p>}
      </div>
    </>
  );
}
