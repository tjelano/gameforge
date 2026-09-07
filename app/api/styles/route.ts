import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { styleService } from '@/lib/services/StyleService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const styles = await styleService.getActiveStyles();
    return NextResponse.json({ success: true, data: styles });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const CreateStyleSchema = z.object({
  name: z.string().min(1),
  parameters: z.string().default('{}'),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = CreateStyleSchema.parse(await req.json());
    const style = await styleService.create({ ...input, createdBy: user.id });
    return NextResponse.json({ success: true, data: style });
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
