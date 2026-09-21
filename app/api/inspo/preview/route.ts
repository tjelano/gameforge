import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { isValidInspoSlug, getDesignMd, InspoHttpError } from '@/lib/services/inspoClient';
import { mapDesignMdToTokens } from '@/lib/services/themeImport/inspoImporter';

export const dynamic = 'force-dynamic';

const PreviewSchema = z.object({
  slug: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = PreviewSchema.parse(await req.json());
    if (!isValidInspoSlug(input.slug)) {
      return NextResponse.json({ success: false, error: 'Invalid Inspo slug.' }, { status: 400 });
    }

    let designMd: string;
    try {
      designMd = await getDesignMd(input.slug);
    } catch (e) {
      if (e instanceof InspoHttpError) {
        const message = e.status === 429
          ? 'Inspo is rate-limited right now. Try again shortly.'
          : e.status === 404
          ? 'Inspo returned 404: Could not find that site.'
          : `Inspo returned an error (${e.status}). Try again shortly.`;
        const statusCode = e.status >= 400 && e.status < 500 ? e.status : 502;
        return NextResponse.json({ success: false, error: message }, { status: statusCode });
      }
      throw e;
    }

    const mapped = mapDesignMdToTokens(designMd);
    if (!mapped.success) {
      return NextResponse.json({ success: false, error: mapped.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      data: {
        tokens: mapped.tokens,
        provenance: mapped.provenance,
        lowConfidence: mapped.lowConfidence,
        capturedAt: mapped.capturedAt,
      },
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
