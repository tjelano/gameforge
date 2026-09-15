import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { parseComponentHtml, combineComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss, COMPONENT_PREVIEW_CSP } from '@/lib/services/componentSanitize';
import { hashDocument } from '@/lib/services/componentElementTree';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

// Injects the gf-rev meta tag into an HTML document. Returns the modified document
// on success, or null if the injection failed (e.g., the charset marker is missing).
// Exported for testing edge cases where the injection might fail.
export function injectRevisionTag(document: string, revisionHash: string): string | null {
  const result = document.replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8">\n<meta name="gf-rev" content="${revisionHash}">`,
  );
  // Defense against silent injection failure: verify the meta tag actually landed.
  if (!result.includes(`<meta name="gf-rev" content="${revisionHash}">`)) {
    return null;
  }
  return result;
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

  const revisionHash = hashDocument(data);

  // Sanitization only ever runs at WRITE time (generate/edit/reset) — this
  // file could still have landed on disk some other way (git pull from
  // another machine, an older less-hardened version of this code, a bad
  // merge). Re-sanitize here too, at SERVE time, so every possible path
  // onto disk is covered uniformly, not just this codebase's own write
  // paths. A component file is a full HTML document that could carry a
  // <script> or event handler if it bypassed those paths — unlike themes
  // or images, which are structurally incapable of carrying executable
  // content.
  //
  // Exception: an asset the user explicitly marked `edited_externally`
  // (via PATCH /api/assets/[id]/component with trustAsEdited) already had
  // its trust decision made and reviewed at WRITE time — re-sanitizing it
  // here would silently strip the hand-edited content right back out on
  // every reload. Skip only the sanitize calls for that case; parsing and
  // reassembly still run unconditionally either way.
  let safeDocument: string;
  try {
    const tokens = parseComponentHtml(data);
    const styleId = req.nextUrl.searchParams.get('styleId');
    const themeCss = await assetService.loadThemeCssForStyle(styleId);
    const asset = await assetService.getByImagePath(filename);
    // output_kind is checked too, matching the other read paths: only a
    // component-type asset can grant trust to a component file, never a
    // theme/image row that happens to share this image_path.
    const trusted = asset?.output_kind === 'component' && asset.edited_externally === 1;
    safeDocument = combineComponentHtml({
      html: trusted ? tokens.html : sanitizeComponentHtml(tokens.html),
      css: trusted ? tokens.css : sanitizeComponentCss(tokens.css),
    }, themeCss ?? undefined);
    const injected = injectRevisionTag(safeDocument, revisionHash);
    if (!injected) {
      console.error(`Failed to inject gf-rev meta tag for component ${filename} — combineComponentHtml's output format may have changed.`);
      return NextResponse.json({ success: false, error: 'Component file failed validation' }, { status: 500 });
    }
    safeDocument = injected;
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
      'Content-Security-Policy': COMPONENT_PREVIEW_CSP,
    },
  });
}
