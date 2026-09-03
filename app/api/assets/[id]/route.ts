import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { NineSliceMarginsSchema } from '@/lib/database/schema';

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

const UpdateAssetSchema = z.object({
  prompt: z.string().min(1).optional(),
  assetType: z.string().min(1).optional(),
  nineSliceMargins: NineSliceMarginsSchema.nullable().optional(),
  states: z.array(z.string()).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const patch = UpdateAssetSchema.parse(await req.json());
    const updated = await assetService.update(id, patch);
    if (!updated) return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: updated });
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

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await assetService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    await assetService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
