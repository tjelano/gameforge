import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

export const dynamic = 'force-dynamic';

const RetryWithCorrectionSchema = z.object({ jobId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { jobId } = RetryWithCorrectionSchema.parse(await req.json());

    const job = await jobService.getById(jobId);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can retry this job.' }, { status: 403 });
    }
    if (job.status !== 'failed') {
      return NextResponse.json({ success: false, error: 'Only a failed job can be retried with a correction.' }, { status: 409 });
    }
    if (!job.error_message?.startsWith(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX)) {
      return NextResponse.json({
        success: false,
        error: 'This job did not fail in a way that supports retry-with-correction.',
      }, { status: 400 });
    }

    // Distinct from the generic /api/jobs/retry route: this one ALSO flags
    // the job's options so the worker injects a corrective instruction,
    // rather than just re-running the identical request that already
    // failed once.
    const options = JSON.parse(job.options);
    options.ollamaCorrectionRequested = true;
    DatabaseConnection.getInstance().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify(options), jobId);

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
