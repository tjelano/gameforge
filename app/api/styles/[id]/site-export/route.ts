import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { siteExporter } from '@/lib/services/SiteExporter';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const SiteExportSchema = z.object({
  subdir: z.string().regex(/^[a-z0-9-]+$/, 'subdir must contain only lowercase letters, numbers, and hyphens'),
});

const ERROR_MESSAGES: Record<string, string> = {
  NOTHING_TO_EXPORT: 'This Style Bible has no pages to export.',
  ALREADY_EXISTS: 'That folder name is already used — pick another.',
  INVALID_SUBDIR: 'subdir must contain only lowercase letters, numbers, and hyphens.',
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Request body must be valid JSON' }, { status: 400 });
    }
    const input = SiteExportSchema.parse(body);
    const result = await siteExporter.exportSite(id, input.subdir);

    if ('error' in result) {
      return NextResponse.json({ success: false, error: ERROR_MESSAGES[result.error] }, { status: 400 });
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
