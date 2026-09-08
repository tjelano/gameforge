// lib/services/pageDocument.ts
//
// Pure compose logic for a Page: takes already-parsed component
// {html, css} tokens in order plus an optional theme CSS string, and
// produces one standalone HTML document. Kept separate from PageService.ts
// (which owns the DB row and file reads) the same way componentDocument.ts
// is kept separate from ComponentGenerator.ts - one file, one
// responsibility, independently testable with no DB/fs setup needed.

import postcss from 'postcss';

export interface PageComponentTokens {
  html: string;
  css: string;
}

// Known limitation: a component whose own CSS defines `:root { --foo: ... }`
// custom properties will have that block rewritten to `.page-item-N :root`,
// which matches nothing (`:root` only ever matches the document root, never
// a scoped descendant selector) - those declarations are silently dropped
// inside a composed page even though the same component renders them
// correctly when served standalone via /api/components/[filename]. The same
// walkRules-based rewrite likely mangles @keyframes frame selectors (e.g.
// `0%`/`100%`) the same way, though that's not confirmed - revisit either
// case only if it ever becomes reachable in practice.
//
// Exported (not just used internally) because SiteExporter.ts's CSS
// Modules integration needs the exact same prefix-every-selector
// technique for a different reason: Next's CSS Modules compiler runs in
// "pure" mode, which rejects any selector with no local class (confirmed
// by actually running Next's own vendored postcss-modules-local-by-default
// plugin against a bare `button {...}` rule) - prefixing every selector
// with a real local class is what makes ANY component CSS, including a
// bare-tag/universal/pseudo-class rule, satisfy that constraint.
export function scopeComponentCss(css: string, scopeClass: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selector = rule.selectors.map(s => `.${scopeClass} ${s}`).join(', ');
  });
  return root.toString();
}

export function composePageHtml(items: PageComponentTokens[], themeCss?: string): string {
  const styleBlocks: string[] = [];
  const bodyBlocks: string[] = [];

  items.forEach((item, i) => {
    const scopeClass = `page-item-${i}`;
    styleBlocks.push(scopeComponentCss(item.css, scopeClass));
    bodyBlocks.push(`<div class="${scopeClass}">\n${item.html}\n</div>`);
  });

  const themeBlock = themeCss ? `<style>\n${themeCss}\n</style>\n` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${themeBlock}<style>
${styleBlocks.join('\n')}
</style>
</head>
<body>
${bodyBlocks.join('\n')}
</body>
</html>
`;
}
