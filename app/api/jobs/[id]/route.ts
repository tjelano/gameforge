import { NextRequest, NextResponse } from 'next/server';
import { jobService } from '@/lib/services/JobService';
import { deleteFileIfSafe } from '@/lib/services/shared/assetSafety';

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

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });

    if (job.result_path) {
      await deleteFileIfSafe(job.result_path);
    }
    await jobService.delete(id);

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
