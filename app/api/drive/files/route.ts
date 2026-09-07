import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';
import { Readable } from 'stream';

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

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const parentFolderId = formData.get('parentFolderId');

    if (!(file instanceof Blob) || typeof parentFolderId !== 'string' || !parentFolderId) {
      return NextResponse.json({ success: false, error: 'A file and parentFolderId are required.' }, { status: 400 });
    }

    const name = file instanceof File ? file.name : 'upload';
    const stream = Readable.fromWeb(file.stream() as any);
    const uploaded = await driveService.uploadFile({
      name,
      mimeType: file.type || 'application/octet-stream',
      stream,
      parentFolderId,
    });
    return NextResponse.json({ success: true, data: uploaded });
  } catch (error: any) {
    console.error('Failed to upload file to Drive:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
