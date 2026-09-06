import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { ThemeTokensSchema, tokensToCss, parseThemeCss } from '@/lib/services/ThemeGenerator';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }
    if (job.status !== 'complete') {
      return NextResponse.json({ success: false, error: 'Only a completed job can be edited' }, { status: 409 });
    }
    if (job.output_kind !== 'theme') {
      return NextResponse.json({ success: false, error: 'Only theme jobs can be edited with this route' }, { status: 400 });
    }
    // A 'complete' theme job always has a result_path (the worker sets it
    // when marking the job complete) — a missing one here would mean the
    // job's own invariant is already broken, not something this route can
    // recover from gracefully.
    if (!job.result_path) {
      return NextResponse.json({ success: false, error: 'Job has no result file' }, { status: 500 });
    }
    if (job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const tokens = ThemeTokensSchema.parse(await req.json());
    const filePath = path.join(getProjectRoot(), 'storage', 'themes', job.result_path);

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }

    if (options.originalTokens === undefined) {
      let currentCss: string;
      try {
        currentCss = await fsPromises.readFile(filePath, 'utf-8');
      } catch (e) {
        console.error(`Failed to read theme file for original tokens capture (job ${id}):`, e);
        return NextResponse.json({ success: false, error: 'Could not read the theme file' }, { status: 500 });
      }
      const currentTokens = parseThemeCss(currentCss);
      options = { ...options, originalTokens: currentTokens };
      DatabaseConnection.getInstance()
        .prepare('UPDATE jobs SET options = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(options), Date.now(), id);
    }

    try {
      await fsPromises.writeFile(filePath, tokensToCss(tokens));
    } catch (e) {
      console.error(`Failed to write theme file on edit (job ${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the theme file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: tokens });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error(`Unexpected error in theme edit route:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
