// app/api/assets/[id]/contrast/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { assetService } from '@/lib/services/AssetService';
import { getContrastRatio, meetsWcagAA } from '@/lib/services/contrastChecker';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const asset = await assetService.getById(id);
  if (!asset) {
    return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
  }
  if (asset.output_kind !== 'theme' || !asset.image_path) {
    return NextResponse.json({ success: false, error: 'Only theme assets have a contrast check' }, { status: 400 });
  }
  // Same guard as app/api/assets/[id]/export/route.ts — image_path comes
  // from the database, never user-typed paths, but is defense-in-depth
  // against a corrupted/hostile git-synced import setting it to something
  // unexpected.
  if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid image path' }, { status: 400 });
  }

  let tokens;
  try {
    tokens = await assetService.readThemeTokens(id, asset.image_path);
  } catch {
    return NextResponse.json({ success: false, error: 'Could not read or parse the theme file' }, { status: 500 });
  }

  let ratio: number;
  try {
    ratio = getContrastRatio(tokens.colorBackground, tokens.colorForeground);
  } catch (e: any) {
    console.error(`Failed to compute contrast ratio for asset ${id}:`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 422 });
  }
  return NextResponse.json({ success: true, data: { ratio, meetsAA: meetsWcagAA(ratio) } });
}
