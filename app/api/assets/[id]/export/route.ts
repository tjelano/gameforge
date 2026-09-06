// app/api/assets/[id]/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { styleService } from '@/lib/services/StyleService';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import { tokensToW3cTokens } from '@/lib/services/themeExport/w3cExporter';

export const dynamic = 'force-dynamic';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get('format');

  const asset = await assetService.getById(id);
  if (!asset) {
    return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
  }
  if (asset.output_kind !== 'theme' || !asset.image_path) {
    return NextResponse.json({ success: false, error: 'Only theme assets can be exported this way' }, { status: 400 });
  }
  // Same guard as app/api/themes/[filename]/route.ts — image_path comes
  // from the database, never user-typed paths, but is defense-in-depth
  // against a corrupted/hostile git-synced import setting it to something
  // unexpected.
  if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid image path' }, { status: 400 });
  }
  if (format !== 'tailwind' && format !== 'w3c') {
    return NextResponse.json({ success: false, error: 'format must be "tailwind" or "w3c"' }, { status: 400 });
  }

  let css: string;
  try {
    css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', asset.image_path), 'utf-8');
  } catch (e) {
    console.error(`Failed to read theme file for export (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: 'Could not read the theme file' }, { status: 500 });
  }

  let tokens;
  try {
    tokens = parseThemeCss(css);
  } catch (e) {
    console.error(`Failed to parse theme CSS for export (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: 'Could not parse the theme file' }, { status: 500 });
  }

  const style = await styleService.getById(asset.style_id);
  const baseName = slugify(style?.name ?? '') || 'theme';

  let body: string;
  let contentType: string;
  let extension: string;
  try {
    if (format === 'tailwind') {
      body = tokensToTailwindTheme(tokens);
      contentType = 'text/css';
      extension = 'css';
    } else {
      body = tokensToW3cTokens(tokens);
      contentType = 'application/json';
      extension = 'json';
    }
  } catch (e: any) {
    console.error(`Failed to convert theme tokens for export (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 422 });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${baseName}.${extension}"`,
    },
  });
}
