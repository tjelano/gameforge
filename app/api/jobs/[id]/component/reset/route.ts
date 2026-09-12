import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { combineComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
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
    if (job.output_kind !== 'component') {
      return NextResponse.json({ success: false, error: 'Only component jobs can be reset with this route' }, { status: 400 });
    }

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }
    if (options.originalComponent === undefined) {
      return NextResponse.json({ success: false, error: 'This job has never been edited' }, { status: 404 });
    }
    if (!job.result_path || job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const parsed = z.object({ html: z.string(), css: z.string() }).parse(options.originalComponent);
    let originalTokens: ComponentTokens;
    try {
      originalTokens = {
        html: sanitizeComponentHtml(parsed.html),
        css: sanitizeComponentCss(parsed.css),
      };
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }
    const filePath = path.join(getProjectRoot(), 'storage', 'components', job.result_path);
    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, combineComponentHtml(originalTokens));
    } catch (e) {
      console.error(`Failed to write component file on reset (job ${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the component file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: originalTokens });
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
