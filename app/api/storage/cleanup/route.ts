import { NextResponse } from 'next/server';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const removed = await assetService.cleanupOrphanedImages();
    return NextResponse.json({ success: true, data: { removed } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
