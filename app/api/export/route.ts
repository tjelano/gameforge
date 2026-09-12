import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { godotExporter } from '@/lib/services/GodotExporter';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const ExportSchema = z.object({
  styleId: z.string().uuid(),
  subdir: z.string().regex(/^[a-z0-9-]+$/, 'subdir must contain only lowercase letters, numbers, and hyphens').default('godot'),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { styleId, subdir } = ExportSchema.parse(await req.json().catch(() => ({})));
    const result = await godotExporter.exportToGodot(styleId, subdir);
    if ('error' in result) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
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
