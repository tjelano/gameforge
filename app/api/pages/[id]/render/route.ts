import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { stripElementIds, hashDocument } from '@/lib/services/componentElementTree';
import { composePageHtml, composeEditablePageHtml, type EditablePageComponentTokens } from '@/lib/services/pageDocument';

export const dynamic = 'force-dynamic';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const page = await pageService.getById(id);
    if (!page) {
      return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
    }

    // download always wins if both are somehow present: it's this route's other existing purpose,
    // "a clean, final export document" (see this file's own header comment) -- workbench callers
    // (Task 6) never pass download=1, and the existing Download HTML link (Style Hub) never passes
    // editable=1, so this only matters for a hand-crafted URL, but a downloaded file should never
    // carry data-gf-id/data-gf-component-asset-id regardless.
    const editable = req.nextUrl.searchParams.get('editable') === '1' && req.nextUrl.searchParams.get('download') !== '1';

    const componentAssetIds = JSON.parse(page.component_asset_ids) as string[];
    const items: EditablePageComponentTokens[] = [];
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
        const tokens = parseComponentHtml(document);
        // An asset marked `edited_externally` already had its trust decision
        // made at WRITE time (PATCH .../component with trustAsEdited) — skip
        // only the sanitize calls for that case, same as the component-serve
        // and export routes. composePageHtml/composeEditablePageHtml still
        // scope and reassemble this content unconditionally either way.
        const trusted = asset.edited_externally === 1;
        const html = trusted ? tokens.html : sanitizeComponentHtml(tokens.html);
        items.push({
          // Editable mode (the workbench's live click-to-edit preview) needs data-gf-id intact to
          // resolve a click to an element; the export/download path (editable=false) strips it, as
          // before.
          html: editable ? html : stripElementIds(html),
          css: trusted ? tokens.css : sanitizeComponentCss(tokens.css),
          assetId,
          // Hashes the exact raw file bytes applyElementPatch's readVerifiedTokens() compares
          // against (lib/services/componentPatchService.ts) — this is what lets a click in the
          // composed page's iframe carry a documentHash the existing patch-element endpoint
          // accepts as still-current.
          revisionHash: hashDocument(document),
        });
      } catch (e) {
        console.error(`Failed to load component asset ${assetId} for page ${id}, skipping:`, e);
      }
    }

    const themeCss = await assetService.loadThemeCssForStyle(page.style_id);
    const html = editable
      ? composeEditablePageHtml(items, themeCss ?? undefined)
      : composePageHtml(items, themeCss ?? undefined);

    const headers: Record<string, string> = {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
    };
    if (req.nextUrl.searchParams.get('download') === '1') {
      const baseName = slugify(page.name) || 'page';
      headers['Content-Disposition'] = `attachment; filename="${baseName}.html"`;
    }

    return new NextResponse(html, { headers });
  } catch (error) {
    console.error('Failed to render page:', error);
    return NextResponse.json({ success: false, error: 'Failed to render page' }, { status: 500 });
  }
}
