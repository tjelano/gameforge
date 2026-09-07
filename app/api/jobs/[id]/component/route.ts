import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { combineComponentHtml, parseComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';

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
    if (job.output_kind !== 'component') {
      return NextResponse.json({ success: false, error: 'Only component jobs can be edited with this route' }, { status: 400 });
    }
    if (!job.result_path) {
      return NextResponse.json({ success: false, error: 'Job has no result file' }, { status: 500 });
    }
    if (job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const rawInput = (await req.json()) as ComponentTokens;
    let tokens: ComponentTokens;
    try {
      tokens = {
        html: sanitizeComponentHtml(rawInput.html),
        css: sanitizeComponentCss(rawInput.css),
      };
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }

    const filePath = path.join(getProjectRoot(), 'storage', 'components', job.result_path);

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }

    if (options.originalComponent === undefined) {
      let currentDocument: string;
      try {
        currentDocument = await fsPromises.readFile(filePath, 'utf-8');
      } catch (e) {
        console.error(`Failed to read component file for original capture (job ${id}):`, e);
        return NextResponse.json({ success: false, error: 'Could not read the component file' }, { status: 500 });
      }
      const currentTokens = parseComponentHtml(currentDocument);
      options = { ...options, originalComponent: currentTokens };
      DatabaseConnection.getInstance()
        .prepare('UPDATE jobs SET options = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(options), Date.now(), id);
    } else {
      DatabaseConnection.getInstance()
        .prepare('UPDATE jobs SET updated_at = ? WHERE id = ?')
        .run(Date.now(), id);
    }

    try {
      await fsPromises.writeFile(filePath, combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write component file on edit (job ${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the component file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: tokens });
  } catch (error: any) {
    console.error('Unexpected error in component edit route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
