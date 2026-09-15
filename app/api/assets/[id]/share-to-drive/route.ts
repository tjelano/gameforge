import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { Readable } from 'stream';
import path from 'path';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { storageDirFor } from '@/lib/services/shared/assetSafety';
import { parseComponentHtml, combineComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { stripElementIds } from '@/lib/services/componentElementTree';

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
    // Same guard as app/api/assets/[id]/export/route.ts and the public
    // /api/images, /api/themes, /api/components routes — image_path is
    // DB-sourced, not user-typed, but can still arrive via
    // GitService.importFromJson() (a git-synced import from another
    // machine, or a bad merge) with no shape validation, so it gets the
    // same defense-in-depth treatment as every filename this app serves
    // off disk.
    if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid image path' }, { status: 400 });
    }

    const { parentFolderId } = ShareSchema.parse(await req.json());
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(asset.output_kind), asset.image_path);

    // fs.createReadStream() never throws synchronously for a missing file
    // — it returns a stream immediately and only emits an async 'error'
    // event once the underlying open fails. Use an awaitable existence
    // check first so a stale image_path (file deleted/moved outside this
    // app) produces a clean, catchable 500 instead of an unhandled stream
    // error.
    try {
      await fsPromises.access(physicalPath);
    } catch (e) {
      console.error(`Failed to open asset file for Drive share: ${physicalPath}`, e);
      return NextResponse.json({ success: false, error: 'Could not read this asset\'s file.' }, { status: 500 });
    }
    let stream: Readable;
    if (asset.output_kind === 'component') {
      // Same re-sanitization rule as GET /api/components/[filename] and
      // GET /api/assets/[id]/export's component branch — this file could
      // have landed on disk some other way (git pull from another
      // machine, an older less-hardened version of this code), so it
      // gets re-checked before ever leaving this machine, including via
      // Drive. An asset marked `edited_externally` already had its trust
      // decision made at WRITE time (PATCH .../component with
      // trustAsEdited) — skip only the sanitize calls for that case.
      let document: string;
      try {
        document = await fsPromises.readFile(physicalPath, 'utf-8');
      } catch (e) {
        console.error(`Failed to read component file for Drive share (asset ${id}):`, e);
        return NextResponse.json({ success: false, error: 'Could not read this asset\'s file.' }, { status: 500 });
      }
      let safeDocument: string;
      try {
        const tokens = parseComponentHtml(document);
        const trusted = asset.edited_externally === 1;
        safeDocument = combineComponentHtml({
          html: stripElementIds(trusted ? tokens.html : sanitizeComponentHtml(tokens.html)),
          css: trusted ? tokens.css : sanitizeComponentCss(tokens.css),
        });
      } catch (e) {
        console.error(`Component ${asset.image_path} failed re-sanitization for Drive share:`, e);
        return NextResponse.json({ success: false, error: 'Component file failed validation' }, { status: 500 });
      }
      stream = Readable.from(safeDocument);
    } else {
      stream = fs.createReadStream(physicalPath);
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
