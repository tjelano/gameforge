import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';

export const dynamic = 'force-dynamic';

const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme', 'component']).optional(),
  candidateCount: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const input = GenerateSchema.parse(await req.json());

    if (input.outputKind === 'theme') {
      const pieces = (input.options as { pieces?: unknown } | undefined)?.pieces;
      if (Array.isArray(pieces) && pieces.length > 0) {
        return NextResponse.json({ success: false, error: 'Theme jobs cannot include UI-sheet options.' }, { status: 400 });
      }
    }

    const count = input.candidateCount ?? 1;
    if (count === 1) {
      const job = await jobService.create(input);
      return NextResponse.json({ success: true, data: job });
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const job = await jobService.create(input);
      DatabaseConnection.getInstance().prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchId, job.id);
      jobs.push({ ...job, batch_id: batchId });
    }
    return NextResponse.json({ success: true, data: jobs });
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
