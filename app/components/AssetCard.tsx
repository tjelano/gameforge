// app/components/AssetCard.tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Asset } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

export function AssetCard({ asset }: { asset: Asset }) {
  const states: string[] = (() => {
    try {
      return JSON.parse(asset.states);
    } catch {
      return [];
    }
  })();

  const [contrast, setContrast] = useState<{ ratio: number; meetsAA: boolean } | null>(null);

  useEffect(() => {
    if (asset.output_kind !== 'theme') return;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets/${asset.id}/contrast`);
        const body = await res.json();
        if (!ignore && body.success) setContrast(body.data);
      } catch {
        // Purely informational — a failed fetch just means no badge shows.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [asset.id, asset.output_kind]);

  return (
    <Link href={`/dashboard/assets/${asset.id}`} className="card" style={{ padding: 0, overflow: 'hidden', display: 'block' }}>
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
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 320, height: 320, border: 'none', transform: 'scale(0.5)', transformOrigin: 'top left' }}
          />
        ) : asset.output_kind === 'component' && asset.image_path ? (
          <iframe
            src={`/api/components/${asset.image_path}?styleId=${asset.style_id}`}
            title={`Component preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 320, height: 320, border: 'none', transform: 'scale(0.5)', transformOrigin: 'top left' }}
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
  );
}
