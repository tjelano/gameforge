import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export const dynamic = 'force-dynamic';

const CONTENT_TYPE_FOR_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Same guard as app/api/images/[filename]/route.ts and
  // app/api/themes/[filename]/route.ts — neither of those routes has an
  // auth check either (confirmed by reading both directly), this matches
  // that real existing pattern rather than inventing a stricter one.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const ext = filename.split('.').pop() ?? '';
  const contentType = CONTENT_TYPE_FOR_EXTENSION[ext];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Unsupported file type' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'references', filename);

  try {
    const data = await fsPromises.readFile(physicalPath);
    return new NextResponse(data, { headers: { 'Content-Type': contentType } });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Reference image not found' }, { status: 404 });
    }
    console.error(`Failed to read reference image ${filename}:`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
