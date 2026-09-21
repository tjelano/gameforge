'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Asset, Style, OutputKind, Page } from '@/lib/database/schema';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';
import { AssetCard } from '@/app/components/AssetCard';
import { PresetForm, type PresetFormValue } from '@/app/components/PresetForm';
import { PageEditor } from '@/app/components/PageEditor';
import { PreviewFrame } from '@/app/components/PreviewFrame';

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

  const [pages, setPages] = useState<Page[]>([]);
  const [creatingPage, setCreatingPage] = useState(false);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const [exportSubdir, setExportSubdir] = useState('my-site');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ pagesExported: number; componentsExported: number; targetDir: string; skippedComponents: string[]; skippedPages: string[] } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [syncSubdir, setSyncSubdir] = useState('my-site');
  const [syncing, setSyncing] = useState(false);
  const [syncDiff, setSyncDiff] = useState<{
    newPages: { slug: string; name: string; componentAssetIds: string[] }[];
    deletedPageIds: string[];
    pageOrderChanges: { pageId: string; newComponentAssetIds: string[] }[];
    handEditedComponentAssetIds: string[];
    droppedDeletedAssetIds: string[];
    conflictedPageIds: string[];
    notImportableFolders: string[];
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [applyingSync, setApplyingSync] = useState(false);

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingGrounding, setSavingGrounding] = useState(false);

  const [showSavePreset, setShowSavePreset] = useState(false);
  const [savePresetStatus, setSavePresetStatus] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [styleRes, assetsRes, pagesRes] = await Promise.all([
          fetch(`/api/styles/${id}`),
          fetch(`/api/styles/${id}/assets`),
          fetch(`/api/styles/${id}/pages`),
        ]);
        const styleBody = await styleRes.json();
        const assetsBody = await assetsRes.json();
        const pagesBody = await pagesRes.json();
        if (ignore) return;
        if (styleBody.success) {
          setStyle(styleBody.data);
          setNameDraft(styleBody.data.name);
        }
        if (assetsBody.success) setAssets(assetsBody.data);
        if (pagesBody.success) setPages(pagesBody.data);
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

  async function handleToggleGrounding() {
    if (!style || savingGrounding) return;
    setSavingGrounding(true);
    setError(null);
    try {
      const res = await fetch(`/api/styles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groundWithInspo: !style.ground_with_inspo }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not update grounding setting.');
        return;
      }
      setStyle(body.data);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSavingGrounding(false);
    }
  }

  async function refreshPages() {
    const res = await fetch(`/api/styles/${id}/pages`);
    const body = await res.json();
    if (body.success) setPages(body.data);
  }

  async function handleCreatePage(value: { name: string; componentAssetIds: string[] }) {
    setPageError(null);
    try {
      const res = await fetch(`/api/styles/${id}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name }),
      });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not create page.');
        return;
      }
      // Component order is set in a second call, since POST only accepts a name.
      if (value.componentAssetIds.length > 0) {
        const orderRes = await fetch(`/api/pages/${body.data.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ componentAssetIds: value.componentAssetIds }),
        });
        const orderBody = await orderRes.json();
        if (!orderBody.success) {
          setPageError(orderBody.error ?? 'Page was created, but could not save component order.');
          await refreshPages();
          return;
        }
      }
      setCreatingPage(false);
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
      setEditingPageId(null);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }

  async function handleDeletePage(pageId: string) {
    if (deletingPageId) return;
    if (!window.confirm('Delete this page? This can\'t be undone from the UI.')) return;
    setPageError(null);
    setDeletingPageId(pageId);
    try {
      const res = await fetch(`/api/pages/${pageId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not delete page.');
        return;
      }
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    } finally {
      setDeletingPageId(null);
    }
  }

  async function handleExportSite(e: React.FormEvent) {
    e.preventDefault();
    if (exporting || !exportSubdir.trim()) return;
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      const res = await fetch(`/api/styles/${id}/site-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: exportSubdir.trim() }),
      });
      const body = await res.json();
      if (body.success) {
        setExportResult(body.data);
      } else {
        setExportError(body.error ?? 'Export failed.');
      }
    } catch {
      setExportError('Could not reach the server.');
    } finally {
      setExporting(false);
    }
  }

  async function handlePreviewSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncDiff(null);
    try {
      const res = await fetch(`/api/styles/${id}/export-sync/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: syncSubdir }),
      });
      const body = await res.json();
      if (!body.success) {
        setSyncError(body.error ?? 'Could not compute changes.');
        return;
      }
      setSyncDiff(body.data);
    } catch {
      setSyncError('Could not reach the server.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleApplySync() {
    if (applyingSync) return;
    setApplyingSync(true);
    setSyncError(null);
    try {
      const res = await fetch(`/api/styles/${id}/export-sync/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: syncSubdir }),
      });
      const body = await res.json();
      if (!body.success) {
        setSyncError(body.error ?? 'Could not apply changes.');
        return;
      }
      setSyncDiff(null);
      await refreshPages();
    } catch {
      setSyncError('Could not reach the server.');
    } finally {
      setApplyingSync(false);
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
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={!!style.ground_with_inspo}
              onChange={handleToggleGrounding}
              disabled={savingGrounding}
            />
            Use real-site references when generating components
          </label>
        </div>
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

      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Pages</h2>
        {pageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{pageError}</p>}

        {!creatingPage ? (
          <button className="btn" style={{ marginBottom: 16 }} onClick={() => { setEditingPageId(null); setCreatingPage(true); }}>
            New Page
          </button>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <PageEditor
              styleId={id}
              availableComponents={assets.filter(a => a.output_kind === 'component')}
              onSubmit={handleCreatePage}
              submitLabel="Create Page"
            />
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setCreatingPage(false)}>Cancel</button>
          </div>
        )}

        {pages.length === 0 ? (
          <div className="empty-state">None yet.</div>
        ) : (
          <div className="grid">
            {pages.map(p => {
              if (editingPageId === p.id) {
                return (
                  <div key={p.id} style={{ gridColumn: '1 / -1' }}>
                    <PageEditor
                      styleId={id}
                      availableComponents={assets.filter(a => a.output_kind === 'component')}
                      initialName={p.name}
                      initialComponentAssetIds={JSON.parse(p.component_asset_ids)}
                      onSubmit={value => handleUpdatePage(p.id, value)}
                      submitLabel="Save Changes"
                      downloadHref={`/api/pages/${p.id}/render?download=1`}
                    />
                    <button className="btn" style={{ marginTop: 8 }} onClick={() => setEditingPageId(null)}>Cancel</button>
                  </div>
                );
              }
              return (
                <div key={p.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <PreviewFrame
                    src={`/api/pages/${p.id}/render`}
                    title={`Page preview: ${p.name}`}
                    width="100%"
                    height={240}
                  />
                  <div style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.name}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={() => { setCreatingPage(false); setEditingPageId(p.id); }}>Edit</button>
                      <button className="btn" onClick={() => handleDeletePage(p.id)} disabled={deletingPageId === p.id}>
                        {deletingPageId === p.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Export site</h2>
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 12 }}>
          Writes a real Next.js + Tailwind project to <code>storage/exports/</code> containing every
          Page in this Style Bible, ready for <code>npm install &amp;&amp; npm run dev</code>.
        </p>
        <form onSubmit={handleExportSite} style={{ display: 'flex', gap: 10 }}>
          <input
            value={exportSubdir}
            onChange={e => setExportSubdir(e.target.value)}
            placeholder="my-site"
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
          />
          <button className="btn btn-primary" type="submit" disabled={exporting || !exportSubdir.trim()}>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </form>
        {exportError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 10 }}>{exportError}</p>}
        {exportResult && (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 10 }}>
            Exported {exportResult.pagesExported} page{exportResult.pagesExported === 1 ? '' : 's'} and{' '}
            {exportResult.componentsExported} component{exportResult.componentsExported === 1 ? '' : 's'} to{' '}
            <code>{exportResult.targetDir}</code>.
            {exportResult.skippedComponents.length > 0 && (
              <> {exportResult.skippedComponents.length} component{exportResult.skippedComponents.length === 1 ? '' : 's'} left untouched on disk
              because {exportResult.skippedComponents.length === 1 ? 'it has' : 'they have'} been hand-edited: <code>{exportResult.skippedComponents.join(', ')}</code>.</>
            )}
            {exportResult.skippedPages.length > 0 && (
              <> {exportResult.skippedPages.length} page{exportResult.skippedPages.length === 1 ? '' : 's'} left untouched on disk
              because {exportResult.skippedPages.length === 1 ? 'it has' : 'they have'} been hand-edited.</>
            )}
          </p>
        )}
      </div>

      <div className="card" style={{ maxWidth: 560, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Sync from export</h2>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Check an exported project for hand-made changes (new pages, reordered or edited components)
          and bring the structural ones back into this Style Bible.
        </p>
        <div className="field">
          <label htmlFor="sync-subdir">Export folder name</label>
          <input id="sync-subdir" value={syncSubdir} onChange={e => setSyncSubdir(e.target.value)} />
        </div>
        <button className="btn" onClick={handlePreviewSync} disabled={syncing || applyingSync}>
          {syncing ? 'Checking…' : 'Check for changes'}
        </button>
        {syncError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{syncError}</p>}

        {syncDiff && (
          <div style={{ marginTop: 16 }}>
            {syncDiff.newPages.length === 0 && syncDiff.deletedPageIds.length === 0 &&
             syncDiff.pageOrderChanges.length === 0 && syncDiff.handEditedComponentAssetIds.length === 0 &&
             syncDiff.droppedDeletedAssetIds.length === 0 && syncDiff.conflictedPageIds.length === 0 &&
             syncDiff.notImportableFolders.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>No changes found.</p>
            ) : (
              <>
                {syncDiff.newPages.map(p => (
                  <p key={p.slug} style={{ fontSize: 13 }}>New page: <strong>{p.name}</strong> ({p.componentAssetIds.length} component{p.componentAssetIds.length === 1 ? '' : 's'})</p>
                ))}
                {syncDiff.deletedPageIds.map(pid => (
                  <p key={pid} style={{ fontSize: 13 }}>Page removed on disk, will be deleted here too.</p>
                ))}
                {syncDiff.pageOrderChanges.map(c => (
                  <p key={c.pageId} style={{ fontSize: 13 }}>Component order changed on a page.</p>
                ))}
                {syncDiff.conflictedPageIds.map(pid => (
                  <p key={pid} style={{ fontSize: 13, color: 'var(--reject)' }}>
                    Component order for a page changed both in the dashboard and in the export — resolve manually before applying.
                  </p>
                ))}
                {syncDiff.handEditedComponentAssetIds.map(aid => (
                  <p key={aid} style={{ fontSize: 13 }}>
                    A component looks hand-edited — <a href={`/dashboard/assets/${aid}`}>open it</a> to paste the new markup in.
                  </p>
                ))}
                {syncDiff.droppedDeletedAssetIds.length > 0 && (
                  <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
                    {syncDiff.droppedDeletedAssetIds.length} reference{syncDiff.droppedDeletedAssetIds.length === 1 ? '' : 's'} to an already-deleted component will be dropped.
                  </p>
                )}
                {syncDiff.notImportableFolders.map(slug => (
                  <p key={slug} style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
                    {`Folder "${slug}" doesn't match GameForge's naming convention and can't be imported as a page.`}
                  </p>
                ))}
                <button className="btn btn-primary" onClick={handleApplySync} disabled={applyingSync} style={{ marginTop: 8 }}>
                  {applyingSync ? 'Applying…' : 'Apply structural changes'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

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
