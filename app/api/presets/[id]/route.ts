import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';
import { PresetComponentSchema } from '@/lib/database/schema';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const preset = await presetService.getById(id);
    if (!preset) return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: preset });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Only the creator (or an admin) may edit — enforced server-side in PresetService.update().
const UpdatePresetSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  techStackTags: z.array(z.string()).optional(),
  themePrompt: z.string().nullable().optional(),
  components: z.array(PresetComponentSchema).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = UpdatePresetSchema.parse(await req.json());
    const result = await presetService.update(id, user.id, {
      name: input.name,
      prompt: input.prompt,
      techStackTags: input.techStackTags !== undefined ? JSON.stringify(input.techStackTags) : undefined,
      themePrompt: input.themePrompt,
      components: input.components !== undefined ? JSON.stringify(input.components) : undefined,
    }, !!user.is_admin);

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can edit this preset.',
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
    const result = await presetService.softDelete(id, user.id, !!user.is_admin);

    if (result && 'error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this preset.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
