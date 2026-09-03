import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { jobService } from '@/lib/services/JobService';

export const dynamic = 'force-dynamic';

const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  assetType: z.string().min(1),
  prompt: z.string().min(1),
  options: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const input = GenerateSchema.parse(await req.json());
    const job = await jobService.create(input);
    return NextResponse.json({ success: true, data: job });
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
