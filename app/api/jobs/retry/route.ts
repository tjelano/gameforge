import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { jobService } from '@/lib/services/JobService';
import { deleteFileIfSafe } from '@/lib/services/shared/assetSafety';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const RetrySchema = z.object({ jobId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json();
    const { jobId } = RetrySchema.parse(body);

    const job = await jobService.getById(jobId);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can retry this job.' }, { status: 403 });
    }
    if (job.status !== 'complete' && job.status !== 'failed') {
      return NextResponse.json({ success: false, error: 'Only a completed or failed job can be retried' }, { status: 409 });
    }

    // Free the old attempt's image (if any, and if no asset already
    // claims it) before wiping result_path — the shared helper only
    // deletes when nothing else still references the file.
    if (job.result_path) {
      await deleteFileIfSafe(job.result_path, job.output_kind);
    }

    const updated = await jobService.resetForRetry(jobId);
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
