import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z, ZodError } from 'zod';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss } from '@/lib/services/themeTokens';
import { parseW3cTokensJson } from '@/lib/services/themeImport/w3cImporter';

export const dynamic = 'force-dynamic';

const ImportTokensSchema = z.object({
  name: z.string().min(1),
  tokensJson: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = ImportTokensSchema.parse(await req.json());

    const parsed = parseW3cTokensJson(input.tokensJson);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }

    // Write the file before creating any DB rows, same ordering (and same
    // reasoning) as SeedThemeImporter.ts's createSeedTheme(): if the write
    // fails, nothing has been created yet, so there's no orphaned style row
    // left behind.
    const filename = `imported-${crypto.randomUUID()}.css`;
    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(parsed.tokens));
    } catch (e) {
      console.error(`Failed to write imported theme file ${filename}:`, e);
      throw e;
    }

    const style = await styleService.create({
      name: input.name,
      createdBy: user.id,
      parameters: JSON.stringify(parsed.tokens),
    });

    await assetService.create({
      styleId: style.id,
      createdBy: user.id,
      assetType: 'theme',
      prompt: `Imported from W3C Design Tokens JSON`,
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
