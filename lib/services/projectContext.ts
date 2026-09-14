import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';

export interface ProjectContextSummary {
  styles: { id: string; name: string; assetCount: number }[];
  totalActiveAssets: number;
  inFlightJobs: number;
}

/**
 * Moved out of app/api/context/route.ts so both that route and the
 * copilot's system-prompt builder (lib/services/copilotSystemPrompt.ts)
 * share one aggregation instead of the copilot re-fetching its own HTTP
 * endpoint over the network.
 */
export async function getProjectContextSummary(): Promise<ProjectContextSummary> {
  const [styles, assets, activeJobs] = await Promise.all([
    styleService.getActiveStyles(),
    assetService.getActiveAssets(),
    jobService.getActive(),
  ]);

  const assetCountByStyle = new Map<string, number>();
  for (const asset of assets) {
    assetCountByStyle.set(asset.style_id, (assetCountByStyle.get(asset.style_id) ?? 0) + 1);
  }

  return {
    styles: styles.map(style => ({
      id: style.id,
      name: style.name,
      assetCount: assetCountByStyle.get(style.id) ?? 0,
    })),
    totalActiveAssets: assets.length,
    inFlightJobs: activeJobs.filter(j => j.status === 'pending' || j.status === 'processing').length,
  };
}
