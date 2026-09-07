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

export function combineComponentHtml(tokens: ComponentTokens): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${STYLE_OPEN}
${tokens.css}
${STYLE_CLOSE}
</head>
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
