'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Preset, Style } from '@/lib/database/schema';
import { PresetForm, type PresetFormValue } from '@/app/components/PresetForm';

export default function PresetsPage() {
  const router = useRouter();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyMode, setApplyMode] = useState<'new' | 'existing'>('new');
  const [applyNewName, setApplyNewName] = useState('');
  const [applyExistingId, setApplyExistingId] = useState('');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [styles, setStyles] = useState<Style[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/presets');
    const body = await res.json();
    if (body.success) setPresets(body.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [presetsRes, stylesRes] = await Promise.all([
          fetch('/api/presets'),
          fetch('/api/styles'),
        ]);
        const presetsBody = await presetsRes.json();
        const stylesBody = await stylesRes.json();
        if (ignore) return;
        if (presetsBody.success) setPresets(presetsBody.data);
        if (stylesBody.success) setStyles(stylesBody.data);
      } catch {
        // Falls through to the empty-state below.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);

  async function handleCreate(value: PresetFormValue) {
    setError(null);
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
        setError(body.error ?? 'Could not create preset.');
        return;
      }
      setCreating(false);
      await refresh();
    } catch {
      setError('Could not reach the server.');
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(`Delete preset "${presets.find(p => p.id === id)?.name ?? 'this preset'}"? This can't be undone from the UI.`)) return;
    if (deletingId) return;
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/presets/${id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not delete preset.');
        return;
      }
      await refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleUpdate(id: string, value: PresetFormValue) {
    setError(null);
    try {
      const res = await fetch(`/api/presets/${id}`, {
        method: 'PUT',
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
        setError(body.error ?? 'Could not save changes.');
        return;
      }
      setEditingId(null);
      await refresh();
    } catch {
      setError('Could not reach the server.');
    }
  }

  function presetToFormValue(preset: Preset): PresetFormValue {
    return {
      name: preset.name,
      prompt: preset.prompt,
      techStackTags: (JSON.parse(preset.tech_stack_tags) as string[]).join(', '),
      themePrompt: preset.theme_prompt ?? '',
      components: JSON.parse(preset.components),
    };
  }

  function openApply(presetId: string) {
    setApplyingId(presetId);
    setApplyMode('new');
    setApplyNewName('');
    setApplyExistingId('');
    setApplyError(null);
  }

  async function handleApply() {
    if (!applyingId || applyBusy) return;
    setApplyBusy(true);
    setApplyError(null);
    try {
      const body = applyMode === 'new'
        ? { newStyleName: applyNewName.trim() }
        : { existingStyleId: applyExistingId };
      const res = await fetch(`/api/presets/${applyingId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.success) {
        setApplyError(result.error ?? 'Could not apply this preset.');
        return;
      }
      router.push('/dashboard/jobs');
    } catch {
      setApplyError('Could not reach the server.');
    } finally {
      setApplyBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Presets</h1>
      <p className="page-subtitle">
        A reusable recipe — prompt, tech-stack labels, and a starting set of things to generate.
        Applying one queues a theme (if set) and every listed component as one batch.
      </p>

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      {!creating ? (
        <button className="btn btn-primary" style={{ marginBottom: 24 }} onClick={() => setCreating(true)}>
          New Preset
        </button>
      ) : (
        <div style={{ marginBottom: 24 }}>
          <PresetForm onSubmit={handleCreate} submitLabel="Create Preset" />
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {!loading && presets.length === 0 ? (
        <div className="empty-state">No presets yet. Create the first one above.</div>
      ) : (
        <div className="grid">
          {presets.map(preset => {
            if (editingId === preset.id) {
              return (
                <div key={preset.id} style={{ gridColumn: '1 / -1' }}>
                  <PresetForm
                    initial={presetToFormValue(preset)}
                    onSubmit={value => handleUpdate(preset.id, value)}
                    submitLabel="Save Changes"
                  />
                  <button className="btn" style={{ marginTop: 8 }} onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              );
            }
            const tags: string[] = JSON.parse(preset.tech_stack_tags);
            const components: { assetType: string }[] = JSON.parse(preset.components);
            return (
              <div key={preset.id} className="card">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{preset.name}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 8 }}>{preset.prompt}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {tags.map(t => <span key={t} className="badge">{t}</span>)}
                  {preset.theme_prompt && <span className="badge">theme</span>}
                  <span className="badge">{components.length} component{components.length === 1 ? '' : 's'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={() => openApply(preset.id)}>Apply</button>
                  <button className="btn" onClick={() => setEditingId(preset.id)}>Edit</button>
                  <button
                    className="btn"
                    disabled={deletingId === preset.id}
                    onClick={() => handleDelete(preset.id)}
                  >
                    {deletingId === preset.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {applyingId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Apply preset</strong>
              <button className="btn" onClick={() => setApplyingId(null)}>Cancel</button>
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <label>
                <input type="radio" checked={applyMode === 'new'} onChange={() => setApplyMode('new')} /> New Style Bible
              </label>
              <label>
                <input type="radio" checked={applyMode === 'existing'} onChange={() => setApplyMode('existing')} /> Existing Style Bible
              </label>
            </div>
            {applyMode === 'new' ? (
              <input
                value={applyNewName}
                onChange={e => setApplyNewName(e.target.value)}
                placeholder="New Style Bible name"
                style={{ width: '100%', marginBottom: 12 }}
              />
            ) : (
              <select value={applyExistingId} onChange={e => setApplyExistingId(e.target.value)} style={{ width: '100%', marginBottom: 12 }}>
                <option value="">Choose a Style Bible…</option>
                {styles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            {applyError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{applyError}</p>}
            <button
              className="btn btn-primary"
              disabled={applyBusy || (applyMode === 'new' ? !applyNewName.trim() : !applyExistingId)}
              onClick={handleApply}
            >
              {applyBusy ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
