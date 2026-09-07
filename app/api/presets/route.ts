import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const presets = await presetService.getActivePresets();
    return NextResponse.json({ success: true, data: presets });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const CreatePresetSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  techStackTags: z.array(z.string()).default([]),
  themePrompt: z.string().nullable().optional(),
  components: z.array(z.object({ assetType: z.string().min(1), prompt: z.string().min(1) })).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = CreatePresetSchema.parse(await req.json());
    const preset = await presetService.create({
      name: input.name,
      createdBy: user.id,
      prompt: input.prompt,
      techStackTags: JSON.stringify(input.techStackTags),
      themePrompt: input.themePrompt ?? null,
      components: JSON.stringify(input.components),
    });
    return NextResponse.json({ success: true, data: preset });
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
