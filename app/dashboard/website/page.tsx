'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Page, AssetWithContrast } from '@/lib/database/schema';
import { useStyles } from '@/lib/hooks/useStyles';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';
import { PageEditor } from '@/app/components/PageEditor';
import { PreviewFrame } from '@/app/components/PreviewFrame';

export default function WebsiteWorkbenchPage() {
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
  const [styleId, setStyleId] = useState('');
  const activeStyleId = styleId || styles[0]?.id || '';

  const [pages, setPages] = useState<Page[]>([]);
  const [components, setComponents] = useState<AssetWithContrast[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);

  // Reset the page selection when the active Style Bible changes. Done as a conditional
  // render-phase update (React's documented "adjusting state when a prop changes" pattern —
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // rather than an unconditional setState call in the effect body below: the react-hooks
  // set-state-in-effect lint rule flags the latter (see AGENTS.md's note on this exact rule
  // breaking CI twice already), and this way the reset lands before paint instead of after an
  // extra render.
  const [prevStyleId, setPrevStyleId] = useState(activeStyleId);
  if (activeStyleId !== prevStyleId) {
    setPrevStyleId(activeStyleId);
    setSelectedPageId(null);
    setCreatingNew(false);
  }

  useEffect(() => {
    if (!activeStyleId) return;
    let ignore = false;
    (async () => {
      const [pagesRes, assetsRes] = await Promise.all([
        fetch(`/api/styles/${activeStyleId}/pages`),
        fetch(`/api/styles/${activeStyleId}/assets`),
      ]);
      const pagesBody = await pagesRes.json();
      const assetsBody = await assetsRes.json();
      if (ignore) return;
      if (pagesBody.success) setPages(pagesBody.data);
      if (assetsBody.success) setComponents((assetsBody.data as AssetWithContrast[]).filter(a => a.output_kind === 'component'));
    })();
    return () => { ignore = true; };
  }, [activeStyleId]);

  async function refreshPages() {
    const res = await fetch(`/api/styles/${activeStyleId}/pages`);
    const body = await res.json();
    if (body.success) setPages(body.data);
  }

  async function refreshComponents() {
    const res = await fetch(`/api/styles/${activeStyleId}/assets`);
    const body = await res.json();
    if (body.success) setComponents((body.data as AssetWithContrast[]).filter(a => a.output_kind === 'component'));
  }

  function handleNewPage() {
    setSelectedPageId(null);
    setCreatingNew(true);
    setPageError(null);
  }

  function handleSelectPage(id: string) {
    setSelectedPageId(id);
    setCreatingNew(false);
    setPageError(null);
  }

  async function handleCreatePage(value: { name: string; componentAssetIds: string[] }) {
    setPageError(null);
    try {
      const res = await fetch(`/api/styles/${activeStyleId}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name }),
      });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not create page.');
        return;
      }
      const newPageId = body.data.id;
      if (value.componentAssetIds.length > 0) {
        const orderRes = await fetch(`/api/pages/${newPageId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ componentAssetIds: value.componentAssetIds }),
        });
        const orderBody = await orderRes.json();
        if (!orderBody.success) {
          setPageError(orderBody.error ?? 'Page was created, but could not save component order.');
        }
      }
      setCreatingNew(false);
      setSelectedPageId(newPageId);
      setPreviewVersion(v => v + 1);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }

  async function handleUpdatePage(pageId: string, value: { name: string; componentAssetIds: string[] }) {
    setPageError(null);
    try {
      const res = await fetch(`/api/pages/${pageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name, componentAssetIds: value.componentAssetIds }),
      });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not save page.');
        return;
      }
      setPreviewVersion(v => v + 1);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }

  async function handleDeletePage(pageId: string) {
    if (deletingPageId) return;
    if (!window.confirm("Delete this page? This can't be undone from the UI.")) return;
    setPageError(null);
    setDeletingPageId(pageId);
    try {
      const res = await fetch(`/api/pages/${pageId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not delete page.');
        return;
      }
      if (selectedPageId === pageId) setSelectedPageId(null);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    } finally {
      setDeletingPageId(null);
    }
  }

  const selectedPage = pages.find(p => p.id === selectedPageId) ?? null;

  return (
    <>
      <h1 className="page-title">Website</h1>
      <p className="page-subtitle">
        Pick a Style Bible, build a page from its components, and click any element in the live
        preview to change it.
      </p>

      {!stylesLoading && !stylesError && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 24 }}>
          No Style Bibles yet. <Link href="/dashboard/styles">Create one</Link> before building a page.
        </div>
      ) : (
        <div style={{ maxWidth: 320, marginBottom: 24 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />
        </div>
      )}
      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}

      {activeStyleId && (
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 420px', minWidth: 320 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>Pages</div>
              <button className="btn" onClick={handleNewPage}>New Page</button>
            </div>
            {pageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 8 }}>{pageError}</p>}
            {pages.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 16 }}>No pages yet for this Style Bible.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {pages.map(p => (
                  <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      className={selectedPageId === p.id && !creatingNew ? 'btn btn-primary' : 'btn'}
                      style={{ flex: 1, textAlign: 'left' }}
                      onClick={() => handleSelectPage(p.id)}
                    >
                      {p.name}
                    </button>
                    <button type="button" className="btn" onClick={() => handleDeletePage(p.id)} disabled={deletingPageId === p.id}>
                      {deletingPageId === p.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {(creatingNew || selectedPage) && (
              // Keyed on the page identity (or 'new') so PageEditor fully remounts -- and resets its
              // own internal name/componentAssetIds state -- whenever the user switches which page
              // they're editing. Same "remount to reset state on identity change" pattern as
              // ElementPatchPanel's own key (app/components/ElementPatchPanel.tsx).
              <PageEditor
                key={selectedPageId ?? 'new'}
                styleId={activeStyleId}
                availableComponents={components}
                initialName={selectedPage?.name}
                initialComponentAssetIds={selectedPage ? JSON.parse(selectedPage.component_asset_ids) : undefined}
                onSubmit={creatingNew ? handleCreatePage : (value) => handleUpdatePage(selectedPage!.id, value)}
                submitLabel={creatingNew ? 'Create Page' : 'Save Changes'}
              />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 320 }}>
            {creatingNew || !selectedPage ? (
              <div className="empty-state">Save the page to see a live preview.</div>
            ) : (
              // Keyed on the page id so switching pages fully remounts the iframe/select-mode state
              // instead of carrying over a selection from a different page's DOM.
              <PreviewFrame
                key={selectedPage.id}
                title={`Live preview: ${selectedPage.name}`}
                src={`/api/pages/${selectedPage.id}/render?editable=1&v=${previewVersion}`}
                width="100%"
                height={640}
                border
                kind="page"
                patchEndpoint={(info) => (info.componentAssetId ? `/api/assets/${info.componentAssetId}/component/patch-element` : '')}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
