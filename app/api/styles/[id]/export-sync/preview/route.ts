import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { computeSyncDiff } from '@/lib/services/ExportSync';
import { isExportInProgress } from '@/lib/services/SiteExporter';

export const dynamic = 'force-dynamic';

const PreviewSchema = z.object({ subdir: z.string().min(1) });

// Mirrors SiteExporter's own subdir validation - re-checked here for the
// same reason SiteExporter re-checks it: this route builds a real
// filesystem path from it and must not be reachable with a path-traversal
// payload regardless of caller.
const SUBDIR_PATTERN = /^[a-z0-9-]+$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = PreviewSchema.parse(await req.json());
    if (!SUBDIR_PATTERN.test(input.subdir)) {
      return NextResponse.json({ success: false, error: 'Invalid subdir' }, { status: 400 });
    }
    if (await isExportInProgress(input.subdir)) {
      return NextResponse.json({ success: false, error: 'An export is currently in progress for this folder. Try again in a moment.' }, { status: 409 });
    }

    const exportDir = path.join(getProjectRoot(), 'storage', 'exports', input.subdir);
    const result = await computeSyncDiff(id, exportDir);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, data: result.diff });
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
