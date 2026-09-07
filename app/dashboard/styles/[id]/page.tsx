'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Asset, Style, OutputKind } from '@/lib/database/schema';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';
import { AssetCard } from '@/app/components/AssetCard';
import { PresetForm, type PresetFormValue } from '@/app/components/PresetForm';

const SECTIONS: { kind: OutputKind; label: string }[] = [
  { kind: 'theme', label: 'Themes' },
  { kind: 'component', label: 'Components' },
  { kind: 'image', label: 'Images' },
];

export default function StyleHubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const { user } = useCurrentUser();

  const [style, setStyle] = useState<Style | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showSavePreset, setShowSavePreset] = useState(false);
  const [savePresetStatus, setSavePresetStatus] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [styleRes, assetsRes] = await Promise.all([
          fetch(`/api/styles/${id}`),
          fetch(`/api/styles/${id}/assets`),
        ]);
        const styleBody = await styleRes.json();
        const assetsBody = await assetsRes.json();
        if (ignore) return;
        if (styleBody.success) {
          setStyle(styleBody.data);
          setNameDraft(styleBody.data.name);
        }
        if (assetsBody.success) setAssets(assetsBody.data);
      } catch {
        // Falls through to "Style Bible not found." below since style stays null.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [id]);

  const isOwner = !!user && !!style && (style.created_by === user.id || user.isAdmin);

  async function handleSaveName() {
    if (!nameDraft.trim() || savingName) return;
    setSavingName(true);
    setError(null);
    try {
      const res = await fetch(`/api/styles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameDraft.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Rename failed.');
        return;
      }
      setStyle(body.data);
      setRenaming(false);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSavingName(false);
    }
  }

  async function handleDeleteStyle() {
    if (deleting) return;
    if (!window.confirm('Delete this Style Bible? Its assets will stay active but this can\'t be undone from the UI.')) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/styles/${id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Delete failed.');
        setDeleting(false);
        return;
      }
      router.push('/dashboard/styles');
    } catch {
      setError('Could not reach the server.');
      setDeleting(false);
    }
  }

  function buildPresetPrefill(): Partial<PresetFormValue> {
    const themeAssets = assets.filter(a => a.output_kind === 'theme');
    const componentAssets = assets.filter(a => a.output_kind === 'component');
    const mostRecentTheme = themeAssets[0]; // assets are ordered newest-first by the API
    return {
      name: `${style?.name ?? 'Untitled'} preset`,
      themePrompt: mostRecentTheme?.prompt ?? '',
      components: componentAssets.map(a => ({ assetType: a.asset_type, prompt: a.prompt })),
    };
  }

  async function handleSavePreset(value: PresetFormValue) {
    setSavePresetStatus(null);
    try {
      const res = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: value.name,
          prompt: value.prompt,
          techStackTags: value.techStackTags.split(',').map(t => t.trim()).filter(Boolean),
          themePrompt: value.themePrompt.trim() || null,
          components: value.components,
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setSavePresetStatus(body.error ?? 'Could not save preset.');
        return;
      }
      setShowSavePreset(false);
      setSavePresetStatus('Saved as a new preset.');
    } catch {
      setSavePresetStatus('Could not reach the server.');
    }
  }

  if (loading) return <p className="page-subtitle">Loading…</p>;
  if (!style) return <p className="page-subtitle">Style Bible not found.</p>;

  return (
    <>
      {renaming ? (
        <div style={{ display: 'flex', gap: 10, marginBottom: 4, maxWidth: 420 }}>
          <input
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px', fontSize: 22, fontWeight: 600 }}
          />
          <button className="btn btn-primary" onClick={handleSaveName} disabled={savingName || !nameDraft.trim()}>
            {savingName ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" onClick={() => { setRenaming(false); setNameDraft(style.name); }}>
            Cancel
          </button>
        </div>
      ) : (
        <h1 className="page-title">{style.name}</h1>
      )}
      <p className="page-subtitle">
        {assets.length} asset{assets.length === 1 ? '' : 's'} in this Style Bible.
      </p>

      {isOwner && !renaming && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          <button className="btn" onClick={() => setRenaming(true)}>Rename</button>
          <button className="btn" onClick={handleDeleteStyle} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete Style Bible'}
          </button>
        </div>
      )}
      {isOwner && (
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: -14, marginBottom: 24 }}>
          Deleting a Style Bible does not delete its assets — they stay active and remain visible in the
          global Assets list.
        </p>
      )}

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {SECTIONS.map(section => {
        const sectionAssets = assets.filter(a => a.output_kind === section.kind);
        return (
          <div key={section.kind} style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>{section.label}</h2>
            {sectionAssets.length === 0 ? (
              <div className="empty-state">None yet.</div>
            ) : (
              <div className="grid">
                {sectionAssets.map(asset => (
                  <AssetCard key={asset.id} asset={asset} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={() => setShowSavePreset(true)}>Save as preset</button>
        {!showSavePreset && savePresetStatus && (
          <p style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-dim)' }}>{savePresetStatus}</p>
        )}
      </div>

      {showSavePreset && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 560, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Save as preset</strong>
              <button className="btn" onClick={() => setShowSavePreset(false)}>Cancel</button>
            </div>
            {savePresetStatus && <p style={{ marginBottom: 12, fontSize: 13, color: 'var(--ink-dim)' }}>{savePresetStatus}</p>}
            <PresetForm initial={buildPresetPrefill()} onSubmit={handleSavePreset} submitLabel="Save Preset" />
          </div>
        </div>
      )}
    </>
  );
}
