'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { usePolling } from '@/lib/hooks/usePolling';
import { useJobStore } from '@/lib/store/useJobStore';
import { getClientId } from '@/lib/utils/clientId';
import { JobCard } from '@/app/components/JobCard';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

export default function ThemesPage() {
  const { styles, loading: stylesLoading } = useStyles();
  const jobs = useJobStore(s => s.jobs).filter(j => j.output_kind === 'theme');
  const refreshActive = useJobStore(s => s.refreshActive);
  usePolling(refreshActive, 2000);

  const [styleId, setStyleId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [candidateCount, setCandidateCount] = useState<1 | 3 | 5>(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeStyleId = styleId || styles[0]?.id || '';

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
          createdBy: getClientId(),
          assetType: 'theme',
          prompt: prompt.trim(),
          outputKind: 'theme',
          candidateCount,
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Generation failed to queue.');
      } else {
        setPrompt('');
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
      <h1 className="page-title">Themes</h1>
      <p className="page-subtitle">
        Generate a website design token set (colors, typography, spacing) from a Style Bible. GameForge
        keeps every generation until you promote it to an asset or discard it — same as pixel art.
      </p>

      {!stylesLoading && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 32 }}>
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before generating a theme.
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 32, maxWidth: 480 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />

          <div className="field">
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="warm, editorial, generous whitespace"
            />
          </div>

          <div className="field">
            <label htmlFor="candidateCount">Candidates</label>
            <select
              id="candidateCount"
              value={candidateCount}
              onChange={e => setCandidateCount(Number(e.target.value) as 1 | 3 | 5)}
            >
              <option value={1}>1</option>
              <option value={3}>3 (recommended)</option>
              <option value={5}>5</option>
            </select>
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
      {jobs.length === 0 ? (
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
