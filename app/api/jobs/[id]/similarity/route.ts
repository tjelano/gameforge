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
      if (sibling.id === job.id || !sibling.result_path) continue;
      const tokens = await readThemeTokens(sibling.result_path);
      if (!tokens) continue;
      if (getThemeDistance(candidateTokens, tokens) < SIMILARITY_THRESHOLD) {
        return NextResponse.json({ success: true, data: { flagged: true, similarTo: 'another candidate in this batch' } });
      }
    }
  }

  return NextResponse.json({ success: true, data: { flagged: false } });
}
