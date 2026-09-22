'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProjectContextSummary } from '@/lib/services/projectContext';
import type { ActivityItem } from '@/lib/services/recentActivity';

export default function OverviewPage() {
  const [context, setContext] = useState<ProjectContextSummary | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [contextResult, activityResult, workerResult] = await Promise.allSettled([
          fetch('/api/context').then(r => r.json()),
          fetch('/api/dashboard/activity').then(r => r.json()),
          fetch('/api/dashboard/worker-status').then(r => r.json()),
        ]);
        if (!ignore) {
          if (contextResult.status === 'fulfilled' && contextResult.value.success) {
            setContext(contextResult.value.data);
          }
          if (activityResult.status === 'fulfilled' && activityResult.value.success) {
            setActivity(activityResult.value.data);
          }
          if (workerResult.status === 'fulfilled' && workerResult.value.success) {
            setWorkerAlive(workerResult.value.data.alive);
          }
        }
      } catch {
        // Non-fatal -- the page just shows zeros/an empty activity list.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);

  return (
    <>
      <h1 className="page-title">Overview</h1>
      <p className="page-subtitle">Studio operations at a glance.</p>

      <div className="stat-cards">
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Active styles</div>
          <div className="stat-card-value">{loading ? '—' : context?.styles.length ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Total assets</div>
          <div className="stat-card-value">{loading ? '—' : context?.totalActiveAssets ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Jobs in flight</div>
          <div className="stat-card-value">{loading ? '—' : context?.inFlightJobs ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Worker</div>
          <div className="stat-card-value" style={{ fontSize: 15 }}>
            {loading || workerAlive === null
              ? '—'
              : workerAlive
                ? <span style={{ color: '#3fb950' }}>● running</span>
                : <span style={{ color: 'var(--reject)' }}>○ not detected</span>}
          </div>
        </div>
      </div>

      <h2 className="frame-label" style={{ marginBottom: 12 }}>Quick actions</h2>
      <div style={{ display: 'flex', gap: 10, marginBottom: 32, flexWrap: 'wrap' }}>
        <Link href="/dashboard/generate" className="btn btn-primary">Generate a sprite</Link>
        <Link href="/dashboard/styles" className="btn">New Style Bible</Link>
        <Link href="/dashboard/settings/ollama" className="btn">Ollama settings</Link>
      </div>

      <h2 className="frame-label" style={{ marginBottom: 12 }}>Recent activity</h2>
      {loading ? (
        <p className="page-subtitle">Loading…</p>
      ) : activity.length === 0 ? (
        <div className="empty-state">No recent activity yet. Generate something to see it here.</div>
      ) : (
        <div>
          {activity.map(item => (
            <Link
              key={item.id}
              href={item.kind === 'job' ? '/dashboard/jobs' : `/dashboard/styles/${item.id}`}
              className="activity-row"
            >
              <div>{item.label}</div>
              <div className="activity-row-meta">{new Date(item.timestamp).toLocaleString()}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
