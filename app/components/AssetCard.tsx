import Link from 'next/link';
import type { Asset } from '@/lib/database/schema';

export function AssetCard({ asset }: { asset: Asset }) {
  const states: string[] = (() => {
    try {
      return JSON.parse(asset.states);
    } catch {
      return [];
    }
  })();

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
        }}
      >
        {asset.image_path ? (
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
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.4, marginBottom: asset.nine_slice_margins || states.length ? 6 : 0 }}>
          {asset.prompt}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {asset.nine_slice_margins && <span className="badge">9-sliced</span>}
          {states.length > 0 && <span className="badge">{states.length} state{states.length === 1 ? '' : 's'}</span>}
        </div>
      </div>
    </Link>
  );
}
