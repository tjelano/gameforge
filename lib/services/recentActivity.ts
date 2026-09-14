import { jobService } from '@/lib/services/JobService';
import { styleService } from '@/lib/services/StyleService';

const ACTIVITY_FEED_LIMIT = 8;

export interface ActivityItem {
  id: string;
  kind: 'job' | 'style';
  label: string;
  timestamp: number;
}

function jobLabel(status: string, prompt: string): string {
  if (status === 'promoted') return `Promoted "${prompt}"`;
  if (status === 'discarded') return `Discarded "${prompt}"`;
  return `Generation failed: "${prompt}"`;
}

/**
 * Derived, not logged -- GameForge has no activity-log table and this
 * doesn't add one (see the design spec for why). Merges the most recently
 * resolved jobs with the most recently created styles by timestamp, capped
 * at ACTIVITY_FEED_LIMIT total.
 */
export async function getRecentActivity(): Promise<ActivityItem[]> {
  const [jobs, styles] = await Promise.all([
    jobService.getRecentlyResolved(ACTIVITY_FEED_LIMIT),
    styleService.getActiveStyles(),
  ]);

  const jobItems: ActivityItem[] = jobs.map(job => ({
    id: job.id,
    kind: 'job',
    label: jobLabel(job.status, job.prompt),
    timestamp: job.updated_at,
  }));

  const styleItems: ActivityItem[] = styles.slice(0, ACTIVITY_FEED_LIMIT).map(style => ({
    id: style.id,
    kind: 'style',
    label: `Created Style Bible "${style.name}"`,
    timestamp: style.created_at,
  }));

  return [...jobItems, ...styleItems]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ACTIVITY_FEED_LIMIT);
}
