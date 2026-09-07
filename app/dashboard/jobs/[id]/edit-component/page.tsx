'use client';

import { useEffect, useRef, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Job } from '@/lib/database/schema';
import { parseComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';

const DEBOUNCE_MS = 400;

export default function EditComponentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [tokens, setTokens] = useState<ComponentTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const res = await fetch(`/api/jobs/${id}`);
      const body = await res.json();
      if (ignore) return;
      if (!body.success) {
        setError(body.error ?? 'Could not load this job.');
        return;
      }
      setJob(body.data);
      try {
        const document = await (await fetch(`/api/components/${body.data.result_path}`)).text();
        if (ignore) return;
        setTokens(parseComponentHtml(document));
      } catch {
        if (!ignore) setError('Could not read this component\'s current values.');
      }
    })();
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function handleFieldChange(key: keyof ComponentTokens, value: string) {
    if (!tokens) return;
    const next = { ...tokens, [key]: value };
    setTokens(next);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => savePatch(next), DEBOUNCE_MS);
  }

  async function savePatch(next: ComponentTokens) {
    try {
      const res = await fetch(`/api/jobs/${id}/component`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not save that change.');
      } else {
        setTokens(body.data);
        setPreviewVersion(v => v + 1);
      }
    } catch {
      setError('Could not reach the server.');
    }
  }

  async function handleReset() {
    if (resetting) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setResetting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}/component/reset`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not reset this component.');
      } else {
        setTokens(body.data);
        setPreviewVersion(v => v + 1);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setResetting(false);
    }
  }

  if (error && !tokens) {
    return <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>;
  }
  if (!job || !tokens) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Edit component</h1>
      <p className="page-subtitle">
        Changes save automatically. Use Reset to original if a tweak doesn&apos;t work out.
      </p>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <iframe
          src={`/api/components/${job.result_path}?v=${previewVersion}`}
          title={`Component preview: ${job.prompt}`}
          sandbox=""
          style={{ width: 480, height: 340, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />

        <div className="card" style={{ flex: 1, minWidth: 280 }}>
          <div className="field">
            <label htmlFor="html">HTML</label>
            <textarea
              id="html"
              value={tokens.html}
              onChange={e => handleFieldChange('html', e.target.value)}
              rows={8}
            />
          </div>
          <div className="field">
            <label htmlFor="css">CSS</label>
            <textarea
              id="css"
              value={tokens.css}
              onChange={e => handleFieldChange('css', e.target.value)}
              rows={8}
            />
          </div>

          {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={handleReset} disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset to original'}
            </button>
            <button className="btn btn-primary" onClick={() => router.push('/dashboard/jobs')}>
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
