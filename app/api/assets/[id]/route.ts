import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { NineSliceMarginsSchema } from '@/lib/database/schema';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: asset });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Only the creator (or an admin) may edit — enforced server-side in AssetService.update().
const UpdateAssetSchema = z.object({
  prompt: z.string().min(1).optional(),
  assetType: z.string().min(1).optional(),
  nineSliceMargins: NineSliceMarginsSchema.nullable().optional(),
  states: z.array(z.string()).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const patch = UpdateAssetSchema.parse(await req.json());
    const result = await assetService.update(id, user.id, patch, !!user.is_admin);

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can edit this asset.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const result = await assetService.softDelete(id, user.id, !!user.is_admin);

    if (result && 'error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this asset.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
