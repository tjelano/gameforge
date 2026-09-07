import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { composePageHtml, type PageComponentTokens } from '@/lib/services/pageDocument';

export const dynamic = 'force-dynamic';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const page = await pageService.getById(id);
  if (!page) {
    return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
  }

  const componentAssetIds = JSON.parse(page.component_asset_ids) as string[];
  const items: PageComponentTokens[] = [];
  for (const assetId of componentAssetIds) {
    try {
      const asset = await assetService.getById(assetId);
      if (!asset || asset.is_deleted || asset.output_kind !== 'component' || !asset.image_path) {
        console.error(`Page ${id} references a stale/invalid component asset ${assetId}, skipping`);
        continue;
      }
      const filename = asset.image_path;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        console.error(`Page ${id} references a component asset ${assetId} with an unsafe filename, skipping`);
        continue;
      }
      const document = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', filename), 'utf-8');
      items.push(parseComponentHtml(document));
    } catch (e) {
      console.error(`Failed to load component asset ${assetId} for page ${id}, skipping:`, e);
    }
  }

  const themeCss = await assetService.loadThemeCssForStyle(page.style_id);
  const html = composePageHtml(items, themeCss ?? undefined);

  const headers: Record<string, string> = {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
  };
  if (req.nextUrl.searchParams.get('download')) {
    const baseName = slugify(page.name) || 'page';
    headers['Content-Disposition'] = `attachment; filename="${baseName}.html"`;
  }

  return new NextResponse(html, { headers });
}
