import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { searchScreens, recommend, getFilters } from '@/lib/services/inspoClient';

export const dynamic = 'force-dynamic';

const MAX_BRIEF_LENGTH = 5000;

const SearchRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('search'), query: z.string().min(1).optional(), filters: z.record(z.string(), z.unknown()).optional() }),
  z.object({ mode: z.literal('recommend'), brief: z.string().min(1).max(MAX_BRIEF_LENGTH) }),
  z.object({ mode: z.literal('filters') }),
]);

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = SearchRequestSchema.parse(await req.json());

    let data: unknown;
    if (input.mode === 'search') {
      data = await searchScreens({ query: input.query, ...(input.filters ?? {}) });
    } else if (input.mode === 'recommend') {
      data = await recommend(input.brief);
    } else {
      data = await getFilters();
    }

    return NextResponse.json({ success: true, data });
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
