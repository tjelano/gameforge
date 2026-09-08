// app/components/PageEditor.tsx
'use client';

import { useState } from 'react';
import type { Asset } from '@/lib/database/schema';

export interface PageEditorProps {
  availableComponents: Asset[]; // active 'component' assets for this Style Bible, already fetched by the caller
  initialName?: string;
  initialComponentAssetIds?: string[];
  onSubmit: (value: { name: string; componentAssetIds: string[] }) => Promise<void>;
  submitLabel: string;
  downloadHref?: string; // only passed once the page has a real id (editing, not creating)
}

export function PageEditor({
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

  const componentsById = new Map(availableComponents.map(a => [a.id, a]));

  return (
    <form className="card" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
      <div className="field">
        <label htmlFor="page-name">Name</label>
        <input id="page-name" value={name} onChange={e => setName(e.target.value)} />
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
                <button type="button" className="btn" onClick={() => moveUp(i)} disabled={i === 0}>↑</button>
                <button type="button" className="btn" onClick={() => moveDown(i)} disabled={i === componentAssetIds.length - 1}>↓</button>
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
