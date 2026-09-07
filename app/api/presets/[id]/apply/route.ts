import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const ApplyPresetSchema = z.object({
  newStyleName: z.string().min(1).optional(),
  existingStyleId: z.string().uuid().optional(),
}).refine(
  data => (data.newStyleName ? 1 : 0) + (data.existingStyleId ? 1 : 0) === 1,
  { message: 'Provide exactly one of newStyleName or existingStyleId' }
);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = ApplyPresetSchema.parse(await req.json());
    const result = await presetService.applyPreset(id, input, user.id);

    if ('error' in result) {
      if (result.error === 'NOTHING_TO_GENERATE') {
        return NextResponse.json({ success: false, error: 'This preset has nothing to generate.' }, { status: 400 });
      }
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
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
