import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { pageService } from '@/lib/services/PageService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const page = await pageService.getById(id);
    if (!page) return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: page });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Only the creator (or an admin) may edit — enforced server-side in PageService.update().
const UpdatePageSchema = z.object({
  name: z.string().min(1).optional(),
  componentAssetIds: z.array(z.string()).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = UpdatePageSchema.parse(await req.json());
    const result = await pageService.update(id, user.id, {
      name: input.name,
      componentAssetIds: input.componentAssetIds !== undefined ? JSON.stringify(input.componentAssetIds) : undefined,
    }, !!user.is_admin);

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can edit this page.',
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
    const result = await pageService.softDelete(id, user.id, !!user.is_admin);

    if (result && 'error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this page.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
