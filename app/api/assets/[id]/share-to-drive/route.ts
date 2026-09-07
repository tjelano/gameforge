import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { storageDirFor } from '@/lib/services/shared/assetSafety';

export const dynamic = 'force-dynamic';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css',
  '.html': 'text/html',
};

const ShareSchema = z.object({ parentFolderId: z.string().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    if (!asset.image_path) {
      return NextResponse.json({ success: false, error: 'This asset has no stored file to share.' }, { status: 400 });
    }

    const { parentFolderId } = ShareSchema.parse(await req.json());
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(asset.output_kind), asset.image_path);

    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(physicalPath);
    } catch (e) {
      console.error(`Failed to open asset file for Drive share: ${physicalPath}`, e);
      return NextResponse.json({ success: false, error: 'Could not read this asset\'s file.' }, { status: 500 });
    }

    const extension = path.extname(asset.image_path).toLowerCase();
    const uploaded = await driveService.uploadFile({
      name: asset.image_path,
      mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
      stream,
      parentFolderId,
    });
    return NextResponse.json({ success: true, data: uploaded });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Failed to share asset to Drive:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
