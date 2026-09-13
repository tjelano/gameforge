'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { usePolling } from '@/lib/hooks/usePolling';
import { useOllamaModels } from '@/lib/hooks/useOllamaModels';
import { useJobStore } from '@/lib/store/useJobStore';
import { JobCard } from '@/app/components/JobCard';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

const COMPONENT_TYPES = ['Button', 'Card', 'Nav Bar', 'Form', 'Other'] as const;

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024; // 5MB raw file - keeps the base64 payload comfortably under the server's 10MB base64-string ceiling

export default function ComponentsPage() {
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
  const jobs = useJobStore(s => s.jobs).filter(j => j.output_kind === 'component');
  const refreshActive = useJobStore(s => s.refreshActive);
  const jobsError = useJobStore(s => s.error);
  usePolling(refreshActive, 2000);

  const [styleId, setStyleId] = useState('');
  const [componentType, setComponentType] = useState<typeof COMPONENT_TYPES[number]>('Button');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<{ base64: string; mediaType: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const { models: ollamaModels, host: ollamaHost } = useOllamaModels();
  const [provider, setProvider] = useState<'claude' | string>('claude');

  const activeStyleId = styleId || styles[0]?.id || '';

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setReferenceImage(null);
      setImageError(null);
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setImageError('Only PNG, JPEG, or WebP images are supported.');
      e.target.value = '';
      setReferenceImage(null);
      return;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      setImageError('Image must be under 5MB.');
      e.target.value = '';
      setReferenceImage(null);
      return;
    }
    setImageError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      setReferenceImage({ base64, mediaType: file.type });
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeStyleId || !prompt.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          styleId: activeStyleId,
          assetType: 'component',
          prompt: `${componentType}: ${prompt.trim()}`,
          outputKind: 'component',
          ...(referenceImage ? { referenceImage } : {}),
          ...(provider !== 'claude' && !referenceImage
            ? { provider: 'ollama', model: provider, ollamaHost: ollamaHost }
            : {}),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Generation failed to queue.');
      } else {
        setPrompt('');
        setReferenceImage(null);
        refreshActive();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Components</h1>
      <p className="page-subtitle">
        Generate a real HTML+CSS website component (button, card, nav bar) styled to a Style Bible. Same
        review-and-promote flow as themes and images.
      </p>

      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}

      {!stylesLoading && !stylesError && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 32 }}>
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before generating a component.
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 32, maxWidth: 480 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />

          <div className="field">
            <label htmlFor="componentType">Component type</label>
            <select
              id="componentType"
              value={componentType}
              onChange={e => setComponentType(e.target.value as typeof COMPONENT_TYPES[number])}
            >
              {COMPONENT_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="prompt">Description</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="a primary call-to-action button, rounded corners"
            />
          </div>

          <div className="field">
            <label htmlFor="referenceImage">Reference image (optional)</label>
            <input id="referenceImage" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFileChange} />
            {imageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 4 }}>{imageError}</p>}
            {referenceImage && !imageError && <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 4 }}>Image attached.</p>}
          </div>

          <div className="field">
            <label htmlFor="provider">Model</label>
            <select
              id="provider"
              value={referenceImage ? 'claude' : provider}
              disabled={!!referenceImage}
              onChange={e => setProvider(e.target.value)}
            >
              <option value="claude">Claude</option>
              {ollamaModels.map(m => <option key={m} value={m}>{m} (local)</option>)}
            </select>
            {referenceImage && <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 4 }}>Ollama isn't available with a reference image attached.</p>}
          </div>

          {error && (
            <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -8, marginBottom: 16 }}>{error}</p>
          )}

          <button className="btn btn-primary" type="submit" disabled={submitting || !prompt.trim()}>
            {submitting ? 'Queuing…' : 'Queue generation'}
          </button>
        </form>
      )}

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>
        Live queue
      </h2>
      {jobsError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{jobsError}</p>}
      {!jobsError && jobs.length === 0 ? (
        <div className="empty-state">Nothing in flight. Queue a generation above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.map(job => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </>
  );
}
