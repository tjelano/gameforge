import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { parseComponentHtml, combineComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

// Looks up styleId's most-recently-promoted theme and returns its CSS,
// re-sanitized through the same boundary as component CSS. Theme CSS is
// validated by a completely separate pipeline (ThemeTokensSchema) at
// generation/edit time only, never re-checked at serve time the way
// component files now are — reusing sanitizeComponentCss here closes that
// gap rather than trusting theme content raw. Returns null (no injection,
// same as today's unstyled preview) for any reason the theme can't be used:
// no styleId, no promoted theme, unreadable file, or failed sanitization.
async function loadThemeCssForStyle(styleId: string | null): Promise<string | null> {
  if (!styleId) return null;
  try {
    const themes = await assetService.getActiveThemeAssetsForStyle(styleId);
    if (themes.length === 0) return null;
    const themeFilename = themes[0].image_path;
    // Same bare-filename guard as this route's own `filename` param below —
    // image_path is DB-sourced, not user-typed, but it can arrive via
    // GitService.importFromJson() (a git-synced JSON export from another
    // machine, or a bad merge) with no validation on its shape, so it gets
    // the same defense-in-depth treatment as every other filename this app
    // serves off disk.
    if (!themeFilename || themeFilename.includes('/') || themeFilename.includes('\\') || themeFilename.includes('..')) {
      return null;
    }
    const themePath = path.join(getProjectRoot(), 'storage', 'themes', themeFilename);
    const rawCss = await fsPromises.readFile(themePath, 'utf-8');
    return sanitizeComponentCss(rawCss);
  } catch (e) {
    console.error(`Could not load theme CSS for style ${styleId}:`, e);
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Same guard as app/api/themes/[filename]/route.ts and
  // app/api/images/[filename]/route.ts — filenames come from the
  // database, never user-typed paths, but this is a public route, so
  // reject anything that isn't a bare filename.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'components', filename);

  let data: string;
  try {
    data = await fsPromises.readFile(physicalPath, 'utf-8');
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Component not found' }, { status: 404 });
    }
    console.error(`Failed to read component ${filename}:`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }

  // Sanitization only ever runs at WRITE time (generate/edit/reset) — this
  // file could still have landed on disk some other way (git pull from
  // another machine, an older less-hardened version of this code, a bad
  // merge). Re-sanitize here too, at SERVE time, so every possible path
  // onto disk is covered uniformly, not just this codebase's own write
  // paths. A component file is a full HTML document that could carry a
  // <script> or event handler if it bypassed those paths — unlike themes
  // or images, which are structurally incapable of carrying executable
  // content.
  let safeDocument: string;
  try {
    const tokens = parseComponentHtml(data);
    const styleId = req.nextUrl.searchParams.get('styleId');
    const themeCss = await loadThemeCssForStyle(styleId);
    safeDocument = combineComponentHtml({
      html: sanitizeComponentHtml(tokens.html),
      css: sanitizeComponentCss(tokens.css),
    }, themeCss ?? undefined);
  } catch (e) {
    console.error(`Component ${filename} failed re-sanitization at serve time:`, e);
    return NextResponse.json({ success: false, error: 'Component file failed validation' }, { status: 500 });
  }

  return new NextResponse(safeDocument, {
    headers: {
      'Content-Type': 'text/html',
      // Defense-in-depth for GameForge's own preview rendering only —
      // this header is never baked into the stored file itself, since
      // the file is meant to be copied into the user's own real
      // website. See the design spec's security note.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
    },
  });
}
