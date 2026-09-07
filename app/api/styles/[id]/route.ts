import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { styleService } from '@/lib/services/StyleService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const style = await styleService.getById(id);
    if (!style) return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: style });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Only the creator (or an admin) may edit — enforced server-side in StyleService.update().
const UpdateStyleSchema = z.object({
  name: z.string().min(1).optional(),
  parameters: z.string().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const patch = UpdateStyleSchema.parse(await req.json());
    const result = await styleService.update(id, user.id, patch, !!user.is_admin);

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can edit this style. Fork it to make your own changes.',
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
    const existing = await styleService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    if (existing.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this style.',
      }, { status: 403 });
    }

    await styleService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
