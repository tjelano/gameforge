import { NextRequest, NextResponse } from 'next/server';
import { jobService } from '@/lib/services/JobService';
import { deleteFileIfSafe } from '@/lib/services/shared/assetSafety';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: job });
  } catch (error: any) {
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
    const job = await jobService.getById(id);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can delete this job.' }, { status: 403 });
    }

    // Split-child assets reference this job via source_job_id, not via
    // image_path — deleteFileIfSafe() only checks image_path, so a sheet's
    // composite would otherwise be deleted unconditionally here, and the
    // jobs DELETE below would then fail closed on the FK (RESTRICT).
    // Refuse up front, before touching the file, so neither happens.
    const db = DatabaseConnection.getInstance();
    const hasChildren = db.prepare(
      'SELECT 1 FROM assets WHERE source_job_id = ? LIMIT 1'
    ).get(id);
    if (hasChildren) {
      return NextResponse.json(
        { success: false, error: 'This sheet has split elements. Delete those first.' },
        { status: 409 }
      );
    }

    if (job.result_path) {
      await deleteFileIfSafe(job.result_path, job.output_kind);
    }
    await jobService.delete(id);

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
