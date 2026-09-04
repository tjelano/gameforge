import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Same guard as app/api/images/[filename]/route.ts — filenames come
  // from the database, never user-typed paths, but this is a public
  // route, so reject anything that isn't a bare filename.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'themes', filename);

  try {
    const data = await fsPromises.readFile(physicalPath, 'utf-8');
    return new NextResponse(data, {
      headers: { 'Content-Type': 'text/css' },
    });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Theme not found' }, { status: 404 });
    }
    console.error(`Failed to read theme ${filename}:`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
