import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { assetService } from '@/lib/services/AssetService';
import { applyElementPatch, type PatchError } from '@/lib/services/componentPatchService';

export const dynamic = 'force-dynamic';

const PatchElementSchema = z.object({
  dataGfId: z.string().min(1),
  documentHash: z.string().min(1),
  instruction: z.string().min(1),
});

function statusForError(error: PatchError): number {
  switch (error.code) {
    case 'COMPONENT_NOT_FOUND': return 404;
    case 'ELEMENT_NOT_FOUND': return 404;
    case 'ELEMENT_CHANGED': return 409;
    case 'CONFLICT': return 409;
    case 'SANITIZE_REJECTED': return 400;
    case 'WRITE_FAILED': return 500;
    default: return 500; // defense-in-depth if PatchError ever grows a case without this switch being updated
  }
}

function messageForError(error: PatchError): string {
  return 'message' in error ? error.message : error.code;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    if (asset.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can edit this asset.' }, { status: 403 });
    }
    if (asset.edited_externally === 1) {
      return NextResponse.json({ success: false, error: 'Hand-edited components cannot be patched — use full regeneration instead.' }, { status: 400 });
    }
    if (!asset.image_path || asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 500 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const input = PatchElementSchema.parse(body);

    const result = await applyElementPatch({
      filename: asset.image_path,
      assetId: id,
      requestingUserId: user.id,
      isAdmin: !!user.is_admin,
      dataGfId: input.dataGfId,
      documentHash: input.documentHash,
      instruction: input.instruction,
      styleId: asset.style_id,
    });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: messageForError(result.error) }, { status: statusForError(result.error) });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Unexpected error in asset component patch-element route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
