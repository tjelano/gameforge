import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z, ZodError } from 'zod';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss, ThemeTokensSchema } from '@/lib/services/themeTokens';
import { isValidInspoSlug } from '@/lib/services/inspoClient';

export const dynamic = 'force-dynamic';

// Mirrors inspoImporter.ts's FieldProvenance type (one of the 3 tiers per
// ThemeTokens field) - a closed shape, not a loose record, so a client
// can't fabricate provenance for a field that doesn't exist or claim an
// invalid tier. lowConfidence is intentionally NOT part of this schema:
// it's derived server-side from the validated provenance below (mirroring
// mapDesignMdToTokens's own defaultCount > 4 rule), never trusted from
// the client - a client-supplied lowConfidence would otherwise let a
// forged "high confidence" claim contradict fabricated provenance.
const FieldProvenanceSchema = z.object({
  colorBackground: z.enum(['css-var', 'heuristic', 'default']),
  colorForeground: z.enum(['css-var', 'heuristic', 'default']),
  colorAccent: z.enum(['css-var', 'heuristic', 'default']),
  colorBorder: z.enum(['css-var', 'heuristic', 'default']),
  fontHeading: z.enum(['css-var', 'heuristic', 'default']),
  fontBody: z.enum(['css-var', 'heuristic', 'default']),
  spaceUnit: z.enum(['css-var', 'heuristic', 'default']),
  radiusBase: z.enum(['css-var', 'heuristic', 'default']),
});

const ImportInspoSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  tokens: z.record(z.string(), z.unknown()),
  provenance: FieldProvenanceSchema,
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = ImportInspoSchema.parse(await req.json());
    if (!isValidInspoSlug(input.slug)) {
      return NextResponse.json({ success: false, error: 'Invalid Inspo slug.' }, { status: 400 });
    }

    // The tokens the user approved in the preview step, not a slug to
    // re-resolve — this is what makes preview/commit divergence impossible
    // by construction. Re-validated here as defense-in-depth against a
    // tampered client request body, the same as every other write path in
    // this codebase that accepts client-supplied structured data.
    const validatedTokens = ThemeTokensSchema.safeParse(input.tokens);
    if (!validatedTokens.success) {
      return NextResponse.json({
        success: false,
        error: `Tokens are not valid: ${validatedTokens.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      }, { status: 400 });
    }

    const filename = `imported-${crypto.randomUUID()}.css`;
    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(validatedTokens.data));
    } catch (e) {
      console.error(`Failed to write imported theme file ${filename}:`, e);
      throw e;
    }

    // Same rule as mapDesignMdToTokens (lib/services/themeImport/inspoImporter.ts):
    // more than half of the 8 fields defaulted -> low confidence. Computed
    // here from the now-validated provenance, not trusted from the client.
    const defaultCount = Object.values(input.provenance).filter(tier => tier === 'default').length;
    const lowConfidence = defaultCount > 4;

    const parameters = {
      ...validatedTokens.data,
      __source: {
        slug: input.slug,
        capturedAt: null as string | null, // set below if a capturedAt was actually passed through
        importedAt: Date.now(),
        provenance: input.provenance,
        lowConfidence,
      },
    };

    const style = await styleService.create({
      name: input.name,
      createdBy: user.id,
      parameters: JSON.stringify(parameters),
    });

    await assetService.create({
      styleId: style.id,
      createdBy: user.id,
      assetType: 'theme',
      prompt: `Imported from Inspo: ${input.slug}`,
      imagePath: filename,
      outputKind: 'theme',
    });

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
