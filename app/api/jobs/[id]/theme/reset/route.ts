import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { ThemeTokensSchema, tokensToCss } from '@/lib/services/ThemeGenerator';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can reset this job.' }, { status: 403 });
    }
    if (job.status !== 'complete') {
      return NextResponse.json({ success: false, error: 'Only a completed job can be reset' }, { status: 409 });
    }

    if (job.output_kind !== 'theme') {
      return NextResponse.json({ success: false, error: 'Only theme jobs can be reset with this route' }, { status: 400 });
    }

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }
    if (options.originalTokens === undefined) {
      return NextResponse.json({ success: false, error: 'This job has never been edited' }, { status: 404 });
    }
    if (!job.result_path || job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const originalTokens = ThemeTokensSchema.parse(options.originalTokens);
    const filePath = path.join(getProjectRoot(), 'storage', 'themes', job.result_path);
    try {
      await fsPromises.writeFile(filePath, tokensToCss(originalTokens));
    } catch (e) {
      console.error(`Failed to write theme file on reset (job ${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the theme file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: originalTokens });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
