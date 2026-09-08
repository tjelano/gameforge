'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Asset } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { DriveBrowser } from '@/app/dashboard/drive/DriveBrowser';

export default function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
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
  const [contrast, setContrast] = useState<{ ratio: number; meetsAA: boolean } | null>(null);
  const [sharingToDrive, setSharingToDrive] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

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

  useEffect(() => {
    if (asset?.output_kind !== 'theme') return;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets/${id}/contrast`);
        const body = await res.json();
        if (!ignore && body.success) setContrast(body.data);
      } catch {
        // Purely informational — a failed fetch just means nothing shows.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [id, asset?.output_kind]);

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

  async function handleShareToDrive(parentFolderId: string) {
    if (sharingToDrive) return;
    setSharingToDrive(true);
    setShareStatus(null);
    try {
      const res = await fetch(`/api/assets/${id}/share-to-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentFolderId }),
      });
      const body = await res.json();
      if (body.success) {
        setShareStatus(`Shared to Drive as "${body.data.name}".`);
        setShowDrivePicker(false);
      } else {
        setShareStatus(body.error ?? 'Could not share to Drive.');
      }
    } catch {
      setShareStatus('Could not reach the server.');
    } finally {
      setSharingToDrive(false);
    }
  }

  function addState() {
    const trimmed = newState.trim();
    if (!trimmed || states.includes(trimmed)) return;
    setStates([...states, trimmed]);
    setNewState('');
  }

  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [regenerateNote, setRegenerateNote] = useState('');
  const [regenerateImage, setRegenerateImage] = useState<{ base64: string; mediaType: string } | null>(null);
  const [regenerateImageError, setRegenerateImageError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateStatus, setRegenerateStatus] = useState<string | null>(null);

  const REGEN_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const REGEN_MAX_FILE_BYTES = 5 * 1024 * 1024;

  function handleRegenerateFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setRegenerateImage(null);
      setRegenerateImageError(null);
      return;
    }
    if (!REGEN_ALLOWED_TYPES.includes(file.type)) {
      setRegenerateImageError('Only PNG, JPEG, or WebP images are supported.');
      e.target.value = '';
      setRegenerateImage(null);
      return;
    }
    if (file.size > REGEN_MAX_FILE_BYTES) {
      setRegenerateImageError('Image must be under 5MB.');
      e.target.value = '';
      setRegenerateImage(null);
      return;
    }
    setRegenerateImageError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      setRegenerateImage({ base64, mediaType: file.type });
    };
    reader.readAsDataURL(file);
  }

  async function handleRegenerate() {
    if (!asset || regenerating || !regenerateNote.trim()) return;
    setRegenerating(true);
    setRegenerateStatus(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          styleId: asset.style_id,
          assetType: asset.asset_type,
          prompt: regenerateNote.trim(),
          outputKind: asset.output_kind,
          basedOnAssetId: asset.id,
          ...(regenerateImage ? { referenceImage: regenerateImage } : {}),
        }),
      });
      const body = await res.json();
      if (body.success) {
        setRegenerateStatus('Queued — check the Generate page\'s live queue.');
        setRegenerateNote('');
        setRegenerateImage(null);
      } else {
        setRegenerateStatus(body.error ?? 'Could not queue regeneration.');
      }
    } catch {
      setRegenerateStatus('Could not reach the server.');
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCopy(part: 'html' | 'css') {
    if (!asset?.image_path) return;
    setCopyStatus(null);
    try {
      // No ?styleId= — the pure stored file, same content the "Download
      // HTML" button and the export route serve, never the preview-only
      // theme-CSS-injected version.
      const res = await fetch(`/api/components/${asset.image_path}`);
      const document = await res.text();
      const tokens = parseComponentHtml(document);
      await navigator.clipboard.writeText(part === 'html' ? tokens.html : tokens.css);
      setCopyStatus(`${part.toUpperCase()} copied.`);
    } catch {
      setCopyStatus('Could not copy — try Download instead.');
    }
  }

  async function handleDelete() {
    if (deleting || !asset) return;
    if (!window.confirm('Delete this asset? This can\'t be undone from the UI.')) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/assets/${id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Delete failed.');
        setDeleting(false);
        return;
      }
      router.push(`/dashboard/styles/${asset.style_id}`);
    } catch {
      setError('Could not reach the server.');
      setDeleting(false);
    }
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
          {contrast && (
            <p style={{ fontSize: 13, color: contrast.meetsAA ? 'var(--keeper)' : 'var(--reject)', marginBottom: 12 }}>
              Contrast: {contrast.ratio.toFixed(2)}:1 — {contrast.meetsAA ? 'passes' : 'fails'} WCAG AA
            </p>
          )}
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

      {asset.output_kind === 'component' && asset.image_path && (
        <>
          <iframe
            src={`/api/components/${asset.image_path}?styleId=${asset.style_id}`}
            title={`Component preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12 }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <a className="btn" href={`/api/assets/${id}/export?format=html`} download>
              Download HTML
            </a>
            <button className="btn" onClick={() => handleCopy('html')}>Copy HTML</button>
            <button className="btn" onClick={() => handleCopy('css')}>Copy CSS</button>
          </div>
          <p style={{ marginBottom: 24, fontSize: 13, color: 'var(--ink-dim)', minHeight: 18 }}>{copyStatus}</p>
        </>
      )}

      {asset.output_kind !== 'theme' && asset.output_kind !== 'component' && asset.image_path && (
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

      {asset.output_kind === 'image' && (
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
      )}

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={() => setShowDrivePicker(true)} disabled={sharingToDrive}>
          {sharingToDrive ? 'Sharing…' : 'Share to Drive'}
        </button>
        {/* Renders here too so the success confirmation is still visible after the modal below
            closes (handleShareToDrive sets shareStatus and closes the modal in the same batched
            update, so a copy that only lived inside the modal would never actually be seen). */}
        {!showDrivePicker && shareStatus && <p style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-dim)' }}>{shareStatus}</p>}
      </div>

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={() => setShowRegenerateModal(true)}>
          Regenerate with changes
        </button>
      </div>

      {showRegenerateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Regenerate with changes</strong>
              <button className="btn" onClick={() => setShowRegenerateModal(false)}>Cancel</button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 12 }}>
              Creates a new job based on this asset — the original is never changed.
            </p>
            <div className="field">
              <label htmlFor="regenerateNote">What do you want changed?</label>
              <textarea
                id="regenerateNote"
                value={regenerateNote}
                onChange={e => setRegenerateNote(e.target.value)}
                placeholder="make the accent color brighter"
              />
            </div>
            <div className="field">
              <label htmlFor="regenerateImage">Reference image (optional)</label>
              <input id="regenerateImage" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleRegenerateFileChange} />
              {regenerateImageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 4 }}>{regenerateImageError}</p>}
            </div>
            {regenerateStatus && <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 12 }}>{regenerateStatus}</p>}
            <button className="btn btn-primary" onClick={handleRegenerate} disabled={regenerating || !regenerateNote.trim()}>
              {regenerating ? 'Queuing…' : 'Queue regeneration'}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={handleDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete asset'}
        </button>
      </div>

      {showDrivePicker && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Choose a destination folder</strong>
              <button className="btn" onClick={() => setShowDrivePicker(false)}>Cancel</button>
            </div>
            {shareStatus && <p style={{ marginBottom: 12, fontSize: 13, color: 'var(--ink-dim)' }}>{shareStatus}</p>}
            <DriveBrowser selectMode onSelectFolder={handleShareToDrive} selectBusy={sharingToDrive} selectLabel="Share here" />
          </div>
        </div>
      )}

      {asset.output_kind === 'image' && (
        <>
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
      )}

      {asset.output_kind !== 'image' && error && (
        <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>
      )}
    </>
  );
}
