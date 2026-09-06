'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Job } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

interface JobCardProps {
  job: Job;
  onPromote?: (jobId: string) => void;
  onDiscard?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
  busy?: boolean;
}

export function JobCard({ job, onPromote, onDiscard, onRetry, busy }: JobCardProps) {
  const canAct = job.status === 'complete' || job.status === 'failed';

  const hasPieces = (() => {
    try {
      const pieces = JSON.parse(job.options).pieces;
      return Array.isArray(pieces) && pieces.length > 0;
    } catch {
      return false;
    }
  })();

  const [similarity, setSimilarity] = useState<{ flagged: boolean; similarTo?: string } | null>(null);

  useEffect(() => {
    if (job.output_kind !== 'theme' || job.status !== 'complete') return;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}/similarity`);
        const body = await res.json();
        if (!ignore && body.success) setSimilarity(body.data);
      } catch {
        // Purely informational — a failed fetch just means no badge shows.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [job.id, job.output_kind, job.status]);

  return (
    <div className="card" style={{ display: 'flex', gap: 14 }}>
      <div
        style={{
          width: 72,
          height: 72,
          flexShrink: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {job.output_kind === 'theme' && job.result_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}`)}
            title={`Theme preview: ${job.prompt}`}
            sandbox=""
            style={{ width: 260, height: 180, border: 'none', transform: 'scale(0.28)', transformOrigin: 'top left' }}
          />
        ) : job.result_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${job.result_path}`}
            alt={job.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <span className="frame-label">···</span>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="badge" data-status={job.status}>
            {job.status}
          </span>
          <span className="frame-label">{job.asset_type}</span>
          {similarity?.flagged && (
            <span className="badge" title={similarity.similarTo} style={{ color: 'var(--reject)' }}>
              Similar to {similarity.similarTo}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.prompt}
        </div>

        {(onPromote || onDiscard || onRetry) && (
          <div style={{ display: 'flex', gap: 8 }}>
            {hasPieces && job.result_path && (
              <Link href={`/dashboard/jobs/${job.id}/split`} className="btn">
                Split into elements
              </Link>
            )}
            {onPromote && (
              <button
                className="btn btn-keeper"
                disabled={!canAct || job.status !== 'complete' || busy}
                onClick={() => onPromote(job.id)}
              >
                Promote to Asset
              </button>
            )}
            {onRetry && (
              <button className="btn" disabled={!canAct || busy} onClick={() => onRetry(job.id)}>
                Retry
              </button>
            )}
            {onDiscard && (
              <button className="btn btn-reject" disabled={busy} onClick={() => onDiscard(job.id)}>
                Discard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
