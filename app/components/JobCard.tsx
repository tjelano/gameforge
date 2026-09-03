import Link from 'next/link';
import type { Job } from '@/lib/database/schema';

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
      return Array.isArray(JSON.parse(job.options).pieces) && JSON.parse(job.options).pieces.length > 0;
    } catch {
      return false;
    }
  })();

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
        {job.result_path ? (
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
