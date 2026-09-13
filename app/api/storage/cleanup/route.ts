import { NextRequest, NextResponse } from 'next/server';
import { assetService } from '@/lib/services/AssetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const removedImages = await assetService.cleanupOrphanedImages();
    const removedThemes = await assetService.cleanupOrphanedThemes();
    return NextResponse.json({ success: true, data: { removed: removedImages + removedThemes } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
