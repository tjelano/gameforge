// app/components/PageEditor.tsx
'use client';

import { useState } from 'react';
import type { Asset } from '@/lib/database/schema';

export interface PageEditorProps {
  styleId: string; // for the "Suggest layout" AI call
  availableComponents: Asset[]; // active 'component' assets for this Style Bible, already fetched by the caller
  initialName?: string;
  initialComponentAssetIds?: string[];
  onSubmit: (value: { name: string; componentAssetIds: string[] }) => Promise<void>;
  submitLabel: string;
  downloadHref?: string; // only passed once the page has a real id (editing, not creating)
}

export function PageEditor({
  styleId,
  availableComponents,
  initialName,
  initialComponentAssetIds,
  onSubmit,
  submitLabel,
  downloadHref,
}: PageEditorProps) {
  const [name, setName] = useState(initialName ?? '');
  const [componentAssetIds, setComponentAssetIds] = useState<string[]>(initialComponentAssetIds ?? []);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  function toggleComponent(assetId: string) {
    setComponentAssetIds(ids =>
      ids.includes(assetId) ? ids.filter(id => id !== assetId) : [...ids, assetId]
    );
  }

  function moveUp(index: number) {
    if (index === 0) return;
    setComponentAssetIds(ids => {
      const next = [...ids];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  function moveDown(index: number) {
    setComponentAssetIds(ids => {
      if (index === ids.length - 1) return ids;
      const next = [...ids];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), componentAssetIds });
    } finally {
      setSaving(false);
    }
  }

  async function handleSuggestLayout() {
    if (suggesting || !name.trim() || availableComponents.length === 0) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await fetch(`/api/styles/${styleId}/pages/suggest-layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageName: name.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setSuggestError(body.error ?? 'Could not suggest a layout.');
        return;
      }
      setComponentAssetIds(body.data.componentAssetIds);
    } catch {
      setSuggestError('Could not reach the server.');
    } finally {
      setSuggesting(false);
    }
  }

  const componentsById = new Map(availableComponents.map(a => [a.id, a]));

  return (
    <form className="card" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
      <div className="field">
        <label htmlFor="page-name">Name</label>
        <input id="page-name" value={name} onChange={e => setName(e.target.value)} />
      </div>

      <div>
        <button
          type="button"
          className="btn"
          onClick={handleSuggestLayout}
          disabled={suggesting || !name.trim() || availableComponents.length === 0}
        >
          {suggesting ? 'Suggesting…' : 'Suggest layout'}
        </button>
        <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 4 }}>
          Picks and orders components for a page named &ldquo;{name.trim() || '...'}&rdquo;, replacing the current selection below.
        </p>
        {suggestError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 4 }}>{suggestError}</p>}
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Page order</div>
        {componentAssetIds.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>No components added yet.</p>
        ) : (
          componentAssetIds.map((assetId, i) => {
            const asset = componentsById.get(assetId);
            return (
              <div key={assetId} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span className="badge">{asset?.asset_type ?? 'unknown'}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{asset?.prompt ?? assetId}</span>
                <button type="button" className="btn" onClick={() => moveUp(i)} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" className="btn" onClick={() => moveDown(i)} disabled={i === componentAssetIds.length - 1} aria-label="Move down">↓</button>
                <button type="button" className="btn" onClick={() => toggleComponent(assetId)}>Remove</button>
              </div>
            );
          })
        )}
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Available components</div>
        {availableComponents.filter(a => !componentAssetIds.includes(a.id)).length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>All components already added, or none exist yet.</p>
        ) : (
          availableComponents.filter(a => !componentAssetIds.includes(a.id)).map(asset => (
            <div key={asset.id} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <span className="badge">{asset.asset_type}</span>
              <span style={{ flex: 1, fontSize: 13 }}>{asset.prompt}</span>
              <button type="button" className="btn" onClick={() => toggleComponent(asset.id)}>Add</button>
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        {downloadHref && (
          <a className="btn" href={downloadHref} download>
            Download HTML
          </a>
        )}
      </div>
    </form>
  );
}
