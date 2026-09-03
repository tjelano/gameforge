import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { godotExporter } from '@/lib/services/GodotExporter';

export const dynamic = 'force-dynamic';

const ExportSchema = z.object({ subdir: z.string().min(1).default('godot') });

export async function POST(req: NextRequest) {
  try {
    const { subdir } = ExportSchema.parse(await req.json().catch(() => ({})));
    const result = await godotExporter.exportToGodot(subdir);
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
