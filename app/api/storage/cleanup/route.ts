import { NextResponse } from 'next/server';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const removedImages = await assetService.cleanupOrphanedImages();
    const removedThemes = await assetService.cleanupOrphanedThemes();
    return NextResponse.json({ success: true, data: { removed: removedImages + removedThemes } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
