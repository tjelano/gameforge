import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { styleService } from '@/lib/services/StyleService';

export const dynamic = 'force-dynamic';

const ForkSchema = z.object({ newOwnerId: z.string().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { newOwnerId } = ForkSchema.parse(await req.json());

    const result = await styleService.fork(id, newOwnerId);
    if ('error' in result) {
      return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result });
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
