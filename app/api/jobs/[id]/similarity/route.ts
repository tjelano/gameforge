import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import { parseThemeCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { getThemeDistance, SIMILARITY_THRESHOLD } from '@/lib/services/oklabDistance';

export const dynamic = 'force-dynamic';

async function readThemeTokens(resultPath: string): Promise<ThemeTokens | null> {
  // Same guard as app/api/assets/[id]/contrast/route.ts and .../export/route.ts
  // — result_path/image_path come from the database, never user-typed paths,
  // but this is defense-in-depth against a corrupted/hostile git-synced
  // import setting one to something unexpected. Applied once here, since
  // every file-path lookup in this route (candidate job, promoted asset,
  // sibling job) funnels through this one helper.
  if (resultPath.includes('/') || resultPath.includes('\\') || resultPath.includes('..')) {
    console.error(`Rejected path-traversal-looking theme path for similarity check: ${resultPath}`);
    return null;
  }
  try {
    const css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', resultPath), 'utf-8');
    return parseThemeCss(css);
  } catch (e) {
    console.error(`Failed to read/parse theme file for similarity check: ${resultPath}`, e);
    return null;
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const job = await jobService.getById(id);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
  }

  // Similarity checking is purely informational — per this feature's spec,
  // it should never surface a hard error to the caller. Any failure past
  // this point (a bad theme file, a getThemeDistance throw on an
  // unsupported color, a DB error) degrades to "not flagged", not a crash.
  try {
    if (job.output_kind !== 'theme' || !job.result_path) {
      return NextResponse.json({ success: true, data: { flagged: false } });
    }

    const candidateTokens = await readThemeTokens(job.result_path);
    if (!candidateTokens) {
      return NextResponse.json({ success: true, data: { flagged: false } });
    }

    const promotedAssets = await assetService.getActiveThemeAssetsForStyle(job.style_id);
    for (const asset of promotedAssets) {
      if (!asset.image_path) continue;
      const tokens = await readThemeTokens(asset.image_path);
      if (!tokens) continue;
      if (getThemeDistance(candidateTokens, tokens) < SIMILARITY_THRESHOLD) {
        return NextResponse.json({ success: true, data: { flagged: true, similarTo: `existing asset "${asset.prompt}"` } });
      }
    }

    if (job.batch_id) {
      const siblings = await jobService.getByBatchId(job.batch_id);
      for (const sibling of siblings) {
        if (sibling.id === job.id || !sibling.result_path || sibling.output_kind !== 'theme') continue;
        const tokens = await readThemeTokens(sibling.result_path);
        if (!tokens) continue;
        if (getThemeDistance(candidateTokens, tokens) < SIMILARITY_THRESHOLD) {
          return NextResponse.json({ success: true, data: { flagged: true, similarTo: 'another candidate in this batch' } });
        }
      }
    }

    return NextResponse.json({ success: true, data: { flagged: false } });
  } catch (e) {
    console.error(`Similarity check failed for job ${id}, degrading to not-flagged:`, e);
    return NextResponse.json({ success: true, data: { flagged: false } });
  }
}
