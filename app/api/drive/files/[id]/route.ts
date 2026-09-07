import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  newParentId: z.string().min(1).optional(),
  oldParentId: z.string().min(1).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = PatchSchema.parse(await req.json());

    if (input.name) {
      const result = await driveService.renameFile(id, input.name);
      return NextResponse.json({ success: true, data: result });
    }

    if (input.newParentId && input.oldParentId) {
      const result = await driveService.moveFile(id, input.newParentId, input.oldParentId);
      return NextResponse.json({ success: true, data: result });
    }

    return NextResponse.json({
      success: false,
      error: 'Provide either name (to rename) or both newParentId and oldParentId (to move).',
    }, { status: 400 });
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
    await driveService.trashFile(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
