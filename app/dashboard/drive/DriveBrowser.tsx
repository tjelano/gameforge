// app/dashboard/drive/DriveBrowser.tsx
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
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

export function DriveBrowser({
  onFolderChange,
  selectMode,
  onSelectFolder,
  selectBusy,
  selectLabel,
}: {
  onFolderChange?: (folderId: string) => void;
  selectMode?: boolean;
  onSelectFolder?: (folderId: string, folderName: string) => void;
  selectBusy?: boolean;
  selectLabel?: string;
}) {
  const [currentFolderId, setCurrentFolderId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [items, setItems] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderForm, setShowNewFolderForm] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [movingItem, setMovingItem] = useState<DriveFile | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function handleUploadChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('parentFolderId', currentFolderId);
      const res = await fetch('/api/drive/files', { method: 'POST', body: formData });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Upload failed.');
      } else {
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setUploading(false);
    }
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!newFolderName.trim() || creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const res = await fetch('/api/drive/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim(), parentFolderId: currentFolderId }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not create folder.');
      } else {
        setNewFolderName('');
        setShowNewFolderForm(false);
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleRename(itemId: string) {
    if (!renameValue.trim() || busyItemId) return;
    setBusyItemId(itemId);
    setError(null);
    try {
      const res = await fetch(`/api/drive/files/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Rename failed.');
      } else {
        setRenamingId(null);
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleTrash(itemId: string) {
    if (!window.confirm(`Move "${items.find(i => i.id === itemId)?.name ?? 'this item'}" to trash?`)) return;
    if (busyItemId) return;
    setBusyItemId(itemId);
    setError(null);
    try {
      const res = await fetch(`/api/drive/files/${itemId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not move to trash.');
      } else {
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleMoveHere(destinationFolderId: string) {
    if (!movingItem || busyItemId) return;
    if (destinationFolderId === currentFolderId) {
      setMovingItem(null);
      return;
    }
    if (movingItem.id === destinationFolderId) {
      setError('Cannot move a folder into itself.');
      return;
    }
    const item = movingItem;
    setBusyItemId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/drive/files/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newParentId: destinationFolderId, oldParentId: currentFolderId }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Move failed.');
      } else {
        setMovingItem(null);
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyItemId(null);
    }
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
        {selectMode && (
          <button
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
            onClick={() => onSelectFolder?.(currentFolderId, breadcrumb[breadcrumb.length - 1].name)}
            disabled={selectBusy ?? false}
          >
            {(selectBusy ?? false) ? 'Working…' : selectLabel ?? 'Move here'}
          </button>
        )}
      </div>

      {!selectMode && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input ref={fileInputRef} type="file" onChange={handleUploadChosen} style={{ display: 'none' }} />
          <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <button className="btn" onClick={() => setShowNewFolderForm(!showNewFolderForm)}>
            New folder
          </button>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search this folder…"
            style={{ width: 220 }}
          />
        </div>
      )}

      {showNewFolderForm && (
        <form onSubmit={handleCreateFolder} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="Folder name" autoFocus />
          <button className="btn btn-primary" type="submit" disabled={creatingFolder || !newFolderName.trim()}>
            {creatingFolder ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {loading && items.length === 0 ? (
        <p className="page-subtitle">Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {items.map(item => {
            const isFolder = item.mimeType === FOLDER_MIME;
            const isBusy = busyItemId === item.id;
            return (
              <div key={item.id} className="card" style={{ padding: 10, cursor: isFolder ? 'pointer' : 'default', opacity: isBusy ? 0.5 : 1 }} onClick={() => isFolder && openFolder(item)}>
                {!isFolder && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/drive/files/${item.id}/thumbnail`}
                    alt=""
                    style={{ width: '100%', height: 80, objectFit: 'cover', marginBottom: 6, borderRadius: 'var(--radius)' }}
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                {renamingId === item.id ? (
                  <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
                    <input value={renameValue} onChange={e => setRenameValue(e.target.value)} style={{ fontSize: 12, width: '100%' }} autoFocus />
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => handleRename(item.id)} disabled={isBusy}>OK</button>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{isFolder ? '📁 ' : ''}{item.name}</div>
                )}
                {!selectMode && renamingId !== item.id && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                    {!isFolder && item.webViewLink && (
                      <a href={item.webViewLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>Open</a>
                    )}
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px' }} disabled={isBusy} onClick={() => { setRenamingId(item.id); setRenameValue(item.name); }}>
                      Rename
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px' }} disabled={isBusy} onClick={() => setMovingItem(item)}>
                      Move
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px', color: 'var(--reject)' }} disabled={isBusy} onClick={() => handleTrash(item.id)}>
                      {isBusy ? '…' : 'Trash'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {movingItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Move &quot;{movingItem.name}&quot;</strong>
              <button className="btn" onClick={() => setMovingItem(null)}>Cancel</button>
            </div>
            <DriveBrowser selectMode onSelectFolder={handleMoveHere} selectBusy={busyItemId !== null} />
          </div>
        </div>
      )}
    </div>
  );
}
