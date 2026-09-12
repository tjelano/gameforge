import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const thumbnail = await driveService.getThumbnail(id);
    if (!thumbnail) {
      return NextResponse.json({ success: false, error: 'No thumbnail available' }, { status: 404 });
    }

    return new NextResponse(Readable.toWeb(thumbnail.stream) as any, {
      headers: { 'Content-Type': thumbnail.mimeType },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
