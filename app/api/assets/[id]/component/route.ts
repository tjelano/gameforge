import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { assetService } from '@/lib/services/AssetService';
import { combineComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  html: z.string(),
  css: z.string(),
  trustAsEdited: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset || asset.is_deleted || asset.output_kind !== 'component') {
      return NextResponse.json({ success: false, error: 'Component asset not found' }, { status: 404 });
    }
    if (!asset.image_path || asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 500 });
    }

    const input = PatchSchema.parse(await req.json());
    const trustAsEdited = input.trustAsEdited === true;

    let tokens: ComponentTokens;
    if (trustAsEdited) {
      // Explicitly trusted, unsanitized paste-back of externally-edited code
      // - the whole point of this path (see the reverse-sync design spec).
      tokens = { html: input.html, css: input.css };
    } else {
      try {
        tokens = {
          html: sanitizeComponentHtml(input.html),
          css: sanitizeComponentCss(input.css),
        };
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
    }

    const filePath = path.join(getProjectRoot(), 'storage', 'components', asset.image_path);
    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write component file on asset edit (${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the component file' }, { status: 500 });
    }

    await assetService.update(id, user.id, { editedExternally: trustAsEdited }, !!user.is_admin);

    return NextResponse.json({ success: true, data: tokens });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Unexpected error in asset component edit route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
