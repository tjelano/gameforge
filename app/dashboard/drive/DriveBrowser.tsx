'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePolling } from '@/lib/hooks/usePolling';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  parents?: string[];
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function DriveBrowser({ onFolderChange }: { onFolderChange?: (folderId: string) => void }) {
  const [currentFolderId, setCurrentFolderId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [items, setItems] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams({ folderId: currentFolderId });
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      const res = await fetch(`/api/drive/files?${params.toString()}`);
      const body = await res.json();
      if (body.success) {
        setItems(body.data);
        setError(null);
      } else {
        setError(body.error ?? 'Could not load this folder.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, searchQuery]);

  usePolling(fetchItems, 4000);

  useEffect(() => {
    onFolderChange?.(currentFolderId);
  }, [currentFolderId, onFolderChange]);

  function openFolder(folder: DriveFile) {
    setCurrentFolderId(folder.id);
    setBreadcrumb([...breadcrumb, { id: folder.id, name: folder.name }]);
    setLoading(true);
  }

  function goToBreadcrumb(index: number) {
    const target = breadcrumb[index];
    setCurrentFolderId(target.id);
    setBreadcrumb(breadcrumb.slice(0, index + 1));
    setLoading(true);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {breadcrumb.map((crumb, i) => (
          <span key={crumb.id}>
            {i > 0 && <span style={{ margin: '0 4px', color: 'var(--ink-dim)' }}>/</span>}
            <button
              className="btn"
              style={{ padding: '2px 8px', fontSize: 13 }}
              onClick={() => goToBreadcrumb(i)}
              disabled={i === breadcrumb.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <input
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        placeholder="Search this folder…"
        style={{ marginBottom: 12, width: '100%', maxWidth: 320 }}
      />

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {loading && items.length === 0 ? (
        <p className="page-subtitle">Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {items.map(item => {
            const isFolder = item.mimeType === FOLDER_MIME;
            return (
              <div key={item.id} className="card" style={{ padding: 10, cursor: isFolder ? 'pointer' : 'default' }} onClick={() => isFolder && openFolder(item)}>
                {!isFolder && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/drive/files/${item.id}/thumbnail`}
                    alt=""
                    style={{ width: '100%', height: 80, objectFit: 'cover', marginBottom: 6, borderRadius: 'var(--radius)' }}
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{isFolder ? '📁 ' : ''}{item.name}</div>
                {!isFolder && item.webViewLink && (
                  <a href={item.webViewLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }} onClick={e => e.stopPropagation()}>
                    Open
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
