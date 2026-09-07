// lib/services/componentDocument.ts
//
// Split out of ComponentGenerator.ts: this file holds only the pure
// document-assembly/parsing logic, with no Node-only imports (no fs, no
// crypto, no DB service). ComponentGenerator.ts re-exports everything here
// for existing server-side callers, but a 'use client' component (the
// component edit page) imports directly from this file — importing
// parseComponentHtml from ComponentGenerator.ts itself would pull its
// ClaudeApiComponentGenerator -> StyleService -> lib/database ->
// better-sqlite3/fs import chain into the browser bundle and fail to
// compile. Confirmed by actually loading the edit page in a browser,
// not just by reading the import graph — same bug themeTokens.ts's
// header documents for ThemeGenerator.ts.

export interface ComponentTokens {
  html: string;
  css: string;
}

const STYLE_OPEN = '<style>';
const STYLE_CLOSE = '</style>';
const BODY_OPEN = '<body>';
const BODY_CLOSE = '</body>';

// themeCss is an optional SECOND <style> block appended after the
// component's own — used only at serve time (GET /api/components/[filename])
// to inject a Style Bible's :root{...} variable definitions so var(--color-
// accent) etc. resolve to real values in GameForge's own preview UI. Never
// passed by the write paths (generate/edit/reset), so it's never baked into
// the stored file — the file the user copies into their own site stays
// exactly what they wrote. parseComponentHtml only ever reads the FIRST
// <style>...</style> pair, so appending this after it doesn't affect
// round-tripping through the edit page.
export function combineComponentHtml(tokens: ComponentTokens, themeCss?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${STYLE_OPEN}
${tokens.css}
${STYLE_CLOSE}
${themeCss ? `${STYLE_OPEN}\n${themeCss}\n${STYLE_CLOSE}\n` : ''}</head>
${BODY_OPEN}
${tokens.html}
${BODY_CLOSE}
</html>
`;
}

export function parseComponentHtml(document: string): ComponentTokens {
  const styleStart = document.indexOf(STYLE_OPEN);
  const styleEnd = document.indexOf(STYLE_CLOSE);
  const bodyStart = document.indexOf(BODY_OPEN);
  const bodyEnd = document.indexOf(BODY_CLOSE);
  if (styleStart === -1 || styleEnd === -1 || bodyStart === -1 || bodyEnd === -1) {
    throw new Error('Component document is missing a <style> or <body> section.');
  }
  return {
    css: document.slice(styleStart + STYLE_OPEN.length, styleEnd).trim(),
    html: document.slice(bodyStart + BODY_OPEN.length, bodyEnd).trim(),
  };
}
