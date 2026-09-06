'use client';

import { useEffect, useState, use as usePromise } from 'react';
import type { Asset } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

export default function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [margins, setMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [nineSliceEnabled, setNineSliceEnabled] = useState(false);
  const [states, setStates] = useState<string[]>([]);
  const [newState, setNewState] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [editFailed, setEditFailed] = useState(false);

  useEffect(() => {
    // Same ignore-flag shape as useStyles.ts / the split page's mount effect:
    // Strict Mode double-invokes this effect in dev (this app's only runtime
    // — see README, there's no production deploy target), and without a
    // guard the second run's setState calls would race the first's.
    let ignore = false;
    (async () => {
      const res = await fetch(`/api/assets/${id}`);
      const body = await res.json();
      if (ignore || !body.success) return;
      setAsset(body.data);
      if (body.data.nine_slice_margins) {
        setMargins(JSON.parse(body.data.nine_slice_margins));
        setNineSliceEnabled(true);
      }
      setStates(JSON.parse(body.data.states));
    })();
    return () => {
      ignore = true;
    };
  }, [id]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/assets/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nineSliceMargins: nineSliceEnabled ? margins : null,
          states,
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Save failed.');
      } else {
        setAsset(body.data);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit() {
    setEditing(true);
    setEditStatus(null);
    setEditFailed(false);
    try {
      const res = await fetch(`/api/assets/${id}/edit`, { method: 'POST' });
      const body = await res.json();
      setEditStatus(body.success ? 'Opened in Aseprite.' : (body.error ?? 'Could not launch Aseprite.'));
      setEditFailed(!body.success);
    } catch {
      setEditStatus('Could not reach the server.');
      setEditFailed(true);
    } finally {
      setEditing(false);
    }
  }

  function addState() {
    const trimmed = newState.trim();
    if (!trimmed || states.includes(trimmed)) return;
    setStates([...states, trimmed]);
    setNewState('');
  }

  if (!asset) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">{asset.prompt}</h1>
      <p className="page-subtitle">{asset.asset_type}</p>

      {asset.output_kind === 'theme' && asset.image_path && (
        <>
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12 }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <a className="btn" href={`/api/assets/${id}/export?format=tailwind`} download>
              Export as Tailwind CSS
            </a>
            <a className="btn" href={`/api/assets/${id}/export?format=w3c`} download>
              Export as W3C Tokens
            </a>
          </div>
        </>
      )}

      {asset.output_kind !== 'theme' && asset.image_path && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/images/${asset.image_path}`}
            alt={asset.prompt}
            style={{ maxWidth: 256, imageRendering: 'pixelated', marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
          />
          <div style={{ marginBottom: 24 }}>
            <button className="btn" onClick={handleEdit} disabled={editing}>
              {editing ? 'Opening…' : 'Edit in Aseprite'}
            </button>
            {editStatus && (
              <p style={{ marginTop: 8, fontSize: 13, color: editFailed ? 'var(--reject)' : 'var(--ink-dim)' }}>
                {editStatus}
              </p>
            )}
          </div>
        </>
      )}

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 600 }}>
          <input type="checkbox" checked={nineSliceEnabled} onChange={e => setNineSliceEnabled(e.target.checked)} />
          9-slice margins
        </label>
        {nineSliceEnabled && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {(['top', 'right', 'bottom', 'left'] as const).map(side => (
              <div className="field" key={side}>
                <label htmlFor={side}>{side}</label>
                <input
                  id={side}
                  type="number"
                  value={margins[side]}
                  onChange={e => setMargins({ ...margins, [side]: Number(e.target.value) })}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>States</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {states.map(s => (
            <span key={s} className="badge" style={{ cursor: 'pointer' }} onClick={() => setStates(states.filter(x => x !== s))}>
              {s} x
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newState} onChange={e => setNewState(e.target.value)} placeholder="hover" onKeyDown={e => e.key === 'Enter' && addState()} />
          <button className="btn" onClick={addState}>Add</button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
}
