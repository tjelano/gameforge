import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { computeSyncDiff } from '@/lib/services/ExportSync';
import { pageService } from '@/lib/services/PageService';

export const dynamic = 'force-dynamic';

// Deliberately only `subdir` - apply NEVER accepts a client-supplied diff.
// It always recomputes fresh from current on-disk + DB state, exactly like
// preview does, so a stale or tampered client-side diff can never be
// applied; any extra fields (e.g. a "diff" the client might send) are
// simply ignored by this schema.
const ApplySchema = z.object({ subdir: z.string().min(1) });

const SUBDIR_PATTERN = /^[a-z0-9-]+$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = ApplySchema.parse(await req.json());
    if (!SUBDIR_PATTERN.test(input.subdir)) {
      return NextResponse.json({ success: false, error: 'Invalid subdir' }, { status: 400 });
    }

    const exportDir = path.join(getProjectRoot(), 'storage', 'exports', input.subdir);
    const result = await computeSyncDiff(id, exportDir);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    const { diff } = result;

    for (const newPage of diff.newPages) {
      const created = await pageService.create({ styleId: id, name: newPage.name, createdBy: user.id });
      await pageService.update(created.id, { componentAssetIds: JSON.stringify(newPage.componentAssetIds) });
    }
    for (const change of diff.pageOrderChanges) {
      await pageService.update(change.pageId, { componentAssetIds: JSON.stringify(change.newComponentAssetIds) });
    }
    for (const deletedId of diff.deletedPageIds) {
      await pageService.softDelete(deletedId);
    }

    return NextResponse.json({ success: true, data: diff });
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
