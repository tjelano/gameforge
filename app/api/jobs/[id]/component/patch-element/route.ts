import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import { applyElementPatch, type PatchError } from '@/lib/services/componentPatchService';

export const dynamic = 'force-dynamic';

const PatchElementSchema = z.object({
  dataGfId: z.string().min(1),
  documentHash: z.string().min(1),
  instruction: z.string().min(1),
});

function statusForError(error: PatchError): number {
  switch (error.code) {
    case 'COMPONENT_NOT_FOUND': return 404;
    case 'ELEMENT_NOT_FOUND': return 404;
    case 'ELEMENT_CHANGED': return 409;
    case 'CONFLICT': return 409;
    case 'SANITIZE_REJECTED': return 400;
    case 'WRITE_FAILED': return 500;
    default: return 500; // defense-in-depth if PatchError ever grows a case without this switch being updated
  }
}

function messageForError(error: PatchError): string {
  return 'message' in error ? error.message : error.code;
}

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
      return NextResponse.json({ success: false, error: 'Only the creator can edit this job.' }, { status: 403 });
    }
    // Same three checks as app/api/jobs/[id]/component/route.ts, kept as separate checks with
    // their own status codes (409/400/500) rather than collapsed into one, since that route's own
    // tests (test/jobComponentEditRoute.test.ts) assert those exact distinct codes.
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

    // A job's result_path and its promoted asset's image_path are the same filename — this is the
    // identical pattern app/api/components/[filename]/route.ts already uses to resolve an asset's
    // trust flag from a component filename, reused here instead of adding a new lookup method.
    const asset = await assetService.getByImagePath(job.result_path);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'This component has not been promoted to an asset yet' }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const input = PatchElementSchema.parse(body);

    const result = await applyElementPatch({
      filename: job.result_path,
      assetId: asset.id,
      requestingUserId: user.id,
      isAdmin: !!user.is_admin,
      dataGfId: input.dataGfId,
      documentHash: input.documentHash,
      instruction: input.instruction,
      styleId: job.style_id,
    });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: messageForError(result.error) }, { status: statusForError(result.error) });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Unexpected error in job component patch-element route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
