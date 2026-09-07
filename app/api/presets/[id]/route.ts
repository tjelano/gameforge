import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';

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

const UpdatePresetSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  techStackTags: z.array(z.string()).optional(),
  themePrompt: z.string().nullable().optional(),
  components: z.array(z.object({ assetType: z.string().min(1), prompt: z.string().min(1) })).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = UpdatePresetSchema.parse(await req.json());
    const updated = await presetService.update(id, {
      name: input.name,
      prompt: input.prompt,
      techStackTags: input.techStackTags !== undefined ? JSON.stringify(input.techStackTags) : undefined,
      themePrompt: input.themePrompt,
      components: input.components !== undefined ? JSON.stringify(input.components) : undefined,
    });
    if (!updated) return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const existing = await presetService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });

    await presetService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
