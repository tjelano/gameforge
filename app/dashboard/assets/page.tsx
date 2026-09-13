'use client';

import { useEffect, useState } from 'react';
import type { Asset } from '@/lib/database/schema';
import { AssetCard } from '@/app/components/AssetCard';

const PAGE_SIZE = 50;

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets?limit=${PAGE_SIZE}&offset=0`);
        const body = await res.json();
        if (ignore) return;
        if (body.success) {
          setAssets(body.data);
          setHasMore(body.data.length === PAGE_SIZE);
          setError(null);
        } else {
          setError(body.error ?? 'Request failed.');
        }
      } catch {
        if (!ignore) setError('Could not reach the server.');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/assets?limit=${PAGE_SIZE}&offset=${assets.length}`);
      const body = await res.json();
      if (body.success) {
        setAssets(prev => [...prev, ...body.data]);
        setHasMore(body.data.length === PAGE_SIZE);
        setError(null);
      } else {
        setError(body.error ?? 'Request failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Assets</h1>
      <p className="page-subtitle">Everything you&apos;ve promoted, ready to export to Godot.</p>

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {!loading && !error && assets.length === 0 ? (
        <div className="empty-state">
          Nothing promoted yet. Review completed jobs on the <strong>Jobs</strong> page.
        </div>
      ) : (
        <>
          <div className="grid">
            {assets.map(asset => (
              <AssetCard key={asset.id} asset={asset} />
            ))}
          </div>
          {hasMore && (
            <button className="btn" onClick={loadMore} disabled={loadingMore} style={{ marginTop: 20 }}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </>
  );
}
