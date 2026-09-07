import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const folderId = req.nextUrl.searchParams.get('folderId') ?? undefined;
    const q = req.nextUrl.searchParams.get('q') ?? undefined;
    const files = await driveService.listFiles(folderId, q);
    return NextResponse.json({ success: true, data: files });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
