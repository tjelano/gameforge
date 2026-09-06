'use client';

import { useEffect, useRef, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Job } from '@/lib/database/schema';
import { parseThemeCss, type ThemeTokens } from '@/lib/services/themeTokens';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

const FIELDS: { key: keyof ThemeTokens; label: string }[] = [
  { key: 'colorBackground', label: 'Background color' },
  { key: 'colorForeground', label: 'Foreground color' },
  { key: 'colorAccent', label: 'Accent color' },
  { key: 'colorBorder', label: 'Border color' },
  { key: 'fontHeading', label: 'Heading font' },
  { key: 'fontBody', label: 'Body font' },
  { key: 'spaceUnit', label: 'Space unit' },
  { key: 'radiusBase', label: 'Border radius' },
];

const DEBOUNCE_MS = 400;

export default function EditThemePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [tokens, setTokens] = useState<ThemeTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  // Bumped on every successful PATCH/reset so the preview iframe's srcDoc
  // string changes even though job.result_path (the filename) never does —
  // otherwise React reuses the same iframe DOM node and the browser never
  // re-fetches the linked CSS, so edits/resets would only ever show up in
  // the preview after a full page reload.
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
        const css = await (await fetch(`/api/themes/${body.data.result_path}`)).text();
        if (ignore) return;
        setTokens(parseThemeCss(css));
      } catch {
        if (!ignore) setError('Could not read this theme\'s current values.');
      }
    })();
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function handleFieldChange(key: keyof ThemeTokens, value: string) {
    if (!tokens) return;
    const next = { ...tokens, [key]: value };
    setTokens(next);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => savePatch(next), DEBOUNCE_MS);
  }

  async function savePatch(next: ThemeTokens) {
    try {
      const res = await fetch(`/api/jobs/${id}/theme`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const body = await res.json();
      if (!body.success) setError(body.error ?? 'Could not save that change.');
      else setPreviewVersion(v => v + 1);
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
      const res = await fetch(`/api/jobs/${id}/theme/reset`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not reset this theme.');
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

  // tokens is the last thing the load effect sets on success, so any load-time
  // failure (job fetch failing, or the theme file being missing/unparseable
  // after job is already set) leaves tokens null with error set — check that
  // before falling into the loading state, or the error is dead code forever.
  if (error && !tokens) {
    return <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>;
  }
  if (!job || !tokens) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Edit theme</h1>
      <p className="page-subtitle">
        Changes save automatically. Use Reset to original if a tweak doesn&apos;t work out.
      </p>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <iframe
          srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}?v=${previewVersion}`)}
          title={`Theme preview: ${job.prompt}`}
          sandbox=""
          style={{ width: 480, height: 340, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />

        <div className="card" style={{ flex: 1, minWidth: 280 }}>
          {FIELDS.map(({ key, label }) => (
            <div className="field" key={key}>
              <label htmlFor={key}>{label}</label>
              <input
                id={key}
                value={tokens[key]}
                onChange={e => handleFieldChange(key, e.target.value)}
              />
            </div>
          ))}

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
