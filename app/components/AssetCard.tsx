// app/components/AssetCard.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AssetWithContrast } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';
import { DriveBrowser } from '@/app/dashboard/drive/DriveBrowser';
import { PreviewFrame } from '@/app/components/PreviewFrame';

export function AssetCard({ asset }: { asset: AssetWithContrast }) {
  const states: string[] = (() => {
    try {
      return JSON.parse(asset.states);
    } catch {
      return [];
    }
  })();

  // Attached server-side by the list endpoint (see AssetService.withContrastData) --
  // NOT fetched per-card. Fetching this individually per rendered card used to fire
  // one HTTP request per theme asset on the list page, which compounded into
  // multi-second loads as the asset count grew (see docs/knowledge/gotchas/).
  const contrast = asset.contrast;
  const [sharingToDrive, setSharingToDrive] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  async function handleShareToDrive(parentFolderId: string) {
    if (sharingToDrive) return;
    setSharingToDrive(true);
    setShareStatus(null);
    try {
      const res = await fetch(`/api/assets/${asset.id}/share-to-drive`, {
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

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <Link href={`/dashboard/assets/${asset.id}`} style={{ display: 'block' }}>
      <div
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {asset.output_kind === 'theme' && asset.image_path ? (
          <PreviewFrame
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            width={320}
            height={320}
            scale={0.5}
          />
        ) : asset.output_kind === 'component' && asset.image_path ? (
          <PreviewFrame
            src={`/api/components/${asset.image_path}?styleId=${asset.style_id}`}
            title={`Component preview: ${asset.prompt}`}
            width={320}
            height={320}
            scale={0.5}
            kind="component"
            patchEndpoint={`/api/assets/${asset.id}/component/patch-element`}
          />
        ) : asset.image_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${asset.image_path}`}
            alt={asset.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <span className="frame-label">no image</span>
        )}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div className="frame-label" style={{ marginBottom: 4 }}>
          {asset.asset_type}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.4, marginBottom: asset.nine_slice_margins || states.length || contrast ? 6 : 0 }}>
          {asset.prompt}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {asset.nine_slice_margins && <span className="badge">9-sliced</span>}
          {states.length > 0 && <span className="badge">{states.length} state{states.length === 1 ? '' : 's'}</span>}
          {contrast && (
            <span
              className="badge"
              title={contrast.meetsAA ? 'Passes WCAG AA' : 'Fails WCAG AA'}
              style={{ color: contrast.meetsAA ? 'var(--keeper)' : 'var(--reject)' }}
            >
              {contrast.meetsAA ? 'AA ✓' : 'AA ✗'}
            </span>
          )}
        </div>
      </div>
      </Link>
      <div style={{ padding: '0 12px 12px' }}>
        <button
          className="btn"
          style={{ width: '100%' }}
          disabled={sharingToDrive}
          onClick={() => setShowDrivePicker(true)}
        >
          {sharingToDrive ? 'Sharing…' : 'Share to Drive'}
        </button>
        {!showDrivePicker && shareStatus && (
          <p style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-dim)' }}>{shareStatus}</p>
        )}
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
    </div>
  );
}
