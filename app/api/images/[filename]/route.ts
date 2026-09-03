import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Filenames come from the database (never user-typed paths), but this
  // is a public route — reject anything that isn't a bare filename.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'images', filename);

  try {
    const data = await fsPromises.readFile(physicalPath);
    const ext = path.extname(filename).toLowerCase();
    return new NextResponse(data, {
      headers: { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
    });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
