import { NextResponse } from 'next/server';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';

export const dynamic = 'force-dynamic';

/**
 * Modular context summary for AI assistants (AGENTS.md/CLAUDE.md-facing).
 * The blueprint names this endpoint but never specifies its shape — this
 * is an inferred minimal design: current styles, asset counts per style,
 * and in-flight job counts, so an assistant can orient without querying
 * the DB directly. Extend as concrete AI-assistant use cases emerge.
 */
export async function GET() {
  try {
    const [styles, assets, activeJobs] = await Promise.all([
      styleService.getActiveStyles(),
      assetService.getActiveAssets(),
      jobService.getActive(),
    ]);

    const assetCountByStyle = new Map<string, number>();
    for (const asset of assets) {
      assetCountByStyle.set(asset.style_id, (assetCountByStyle.get(asset.style_id) ?? 0) + 1);
    }

    return NextResponse.json({
      success: true,
      data: {
        styles: styles.map(style => ({
          id: style.id,
          name: style.name,
          assetCount: assetCountByStyle.get(style.id) ?? 0,
        })),
        totalActiveAssets: assets.length,
        inFlightJobs: activeJobs.filter(j => j.status === 'pending' || j.status === 'processing').length,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
