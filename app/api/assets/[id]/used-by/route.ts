// app/api/assets/[id]/used-by/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { assetService } from '@/lib/services/AssetService';
import { pageService } from '@/lib/services/PageService';

export const dynamic = 'force-dynamic';

// No auth/session check, matching the sibling read-only /contrast route's convention — this is a
// local-first, single-instance app where reads (unlike ownership-checked mutations) aren't scoped
// per user anywhere in PageService either.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    // Only component assets can be referenced by a Page's component_asset_ids — an empty list,
    // not an error, since the client shouldn't need its own output_kind check to call this safely.
    if (asset.output_kind !== 'component') {
      return NextResponse.json({ success: true, data: [] });
    }
    const pages = await pageService.findPagesReferencingAsset(id);
    return NextResponse.json({ success: true, data: pages.map(p => ({ id: p.id, name: p.name })) });
  } catch (error: any) {
    console.error('Failed to look up pages referencing asset:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
