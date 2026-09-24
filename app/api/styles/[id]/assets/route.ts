import { NextRequest, NextResponse } from 'next/server';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assets = await assetService.getActiveAssetsForStyle(id);
    const withContrast = await assetService.withContrastData(assets);
    return NextResponse.json({ success: true, data: withContrast });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
