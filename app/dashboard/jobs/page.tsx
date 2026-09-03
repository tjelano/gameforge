'use client';

import { useState } from 'react';
import { usePolling } from '@/lib/hooks/usePolling';
import { useJobStore } from '@/lib/store/useJobStore';
import { JobCard } from '@/app/components/JobCard';

export default function JobsPage() {
  const jobs = useJobStore(s => s.jobs);
  const refreshActive = useJobStore(s => s.refreshActive);
  usePolling(refreshActive, 2000);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function withBusy(jobId: string, run: () => Promise<Response>) {
    setBusyId(jobId);
    setError(null);
    try {
      const res = await run();
      const body = await res.json();
      if (!body.success) setError(body.error ?? 'That action failed.');
      await refreshActive();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyId(null);
    }
  }

  const handlePromote = (jobId: string) =>
    withBusy(jobId, () =>
      fetch('/api/assets/from-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      })
    );

  const handleDiscard = (jobId: string) =>
    withBusy(jobId, () => fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }));

  const handleRetry = (jobId: string) =>
    withBusy(jobId, () =>
      fetch('/api/jobs/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      })
    );

  return (
    <>
      <h1 className="page-title">Jobs</h1>
      <p className="page-subtitle">
        Review what came back. Promote a keeper to an asset, discard a reject, or retry a failed generation.
      </p>

      {error && (
        <p className="card" style={{ borderColor: 'var(--reject-dim)', color: 'var(--reject)', marginBottom: 16 }}>
          {error}
        </p>
      )}

      {jobs.length === 0 ? (
        <div className="empty-state">No recent jobs. Generate something first.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onPromote={handlePromote}
              onDiscard={handleDiscard}
              onRetry={handleRetry}
              busy={busyId === job.id}
            />
          ))}
        </div>
      )}
    </>
  );
}
