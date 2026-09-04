import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { AssetSchema } from '@/lib/database/schema';

export const dynamic = 'force-dynamic';

const PromoteSchema = z.object({ jobId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId } = PromoteSchema.parse(body);

    const db = DatabaseConnection.getInstance();
    const result = db.transaction(() => {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
      if (!job || !job.result_path) {
        return { success: false as const, error: 'Job not complete or missing result path' };
      }

      // A job past 'complete' (i.e. already 'promoted') isn't an error
      // on its own — it's what a retried identical request looks like
      // once the first call already succeeded. Only 'complete' and
      // 'promoted' are valid states to reach here; anything else
      // (pending/processing/failed/discarded) is a genuine rejection.
      if (job.status !== 'complete' && job.status !== 'promoted') {
        return { success: false as const, error: 'Job not complete or missing result path' };
      }

      const existing = db.prepare('SELECT * FROM assets WHERE image_path = ?').get(job.result_path);
      if (existing) {
        return { success: true as const, data: AssetSchema.parse(existing), alreadyExists: true };
      }

      const assetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(assetId, job.style_id, job.created_by, job.asset_type, job.prompt, job.result_path, Date.now(), job.output_kind);

      db.prepare(`UPDATE jobs SET status = 'promoted', updated_at = ? WHERE id = ?`).run(Date.now(), jobId);

      const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
      return { success: true as const, data: AssetSchema.parse(asset) };
    })();

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
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
