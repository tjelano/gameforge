import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { searchScreens, recommend, getFilters } from '@/lib/services/inspoClient';

export const dynamic = 'force-dynamic';

const MAX_BRIEF_LENGTH = 5000;

// Whitelisted to the real search_screens parameters (confirmed against Inspo's
// live MCP tool schema) instead of an unbounded `filters: z.record(...)` blob —
// that record had no size/key limits and, worse, got spread after `query` into
// the searchScreens() call, letting a `filters.query` key silently override the
// validated query. Enum-ish fields (screenMode/detail/device) stay bounded
// strings rather than z.enum(...) since we haven't independently verified every
// exact valid value Inspo accepts. `screenMode` maps to Inspo's own `mode` param
// (renamed here only because `mode` is already this schema's discriminator).
const SearchRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('search'),
    query: z.string().min(1).max(500).optional(),
    screenMode: z.string().max(100).optional(),
    vibe: z.string().max(100).optional(),
    color: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    style: z.string().max(100).optional(),
    detail: z.string().max(100).optional(),
    device: z.string().max(100).optional(),
    industry: z.string().max(100).optional(),
    pageType: z.string().max(100).optional(),
    accentHue: z.string().max(100).optional(),
    maxTokens: z.number().int().min(1).max(100000).optional(),
    paperBand: z.string().max(100).optional(),
    displayClass: z.string().max(100).optional(),
    macrostructure: z.string().max(100).optional(),
  }).strict(),
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
      // Named fields only, no spread: each argument comes from a validated,
      // bounded schema field, so nothing here can override `query`.
      data = await searchScreens({
        query: input.query,
        mode: input.screenMode,
        vibe: input.vibe,
        color: input.color,
        limit: input.limit,
        style: input.style,
        detail: input.detail,
        device: input.device,
        industry: input.industry,
        pageType: input.pageType,
        accentHue: input.accentHue,
        maxTokens: input.maxTokens,
        paperBand: input.paperBand,
        displayClass: input.displayClass,
        macrostructure: input.macrostructure,
      });
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
