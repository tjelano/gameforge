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

export interface EditablePageComponentTokens extends PageComponentTokens {
  // assetId is always a crypto.randomUUID() from AssetService.create() (never user-typed) and
  // revisionHash is always a sha256 hex digest from componentElementTree.ts's hashDocument() — both
  // charsets are always attribute-safe, so no escaping is needed when splicing them into the
  // wrapper div below (same reasoning PageService.ts's findPagesReferencingAsset uses for its own
  // unescaped LIKE-pattern interpolation).
  assetId: string;
  revisionHash: string;
}

function composeItems(
  items: PageComponentTokens[],
  themeCss: string | undefined,
  wrapperAttrsFor: (item: PageComponentTokens, i: number) => string,
): string {
  const styleBlocks: string[] = [];
  const bodyBlocks: string[] = [];

  items.forEach((item, i) => {
    const scopeClass = `page-item-${i}`;
    styleBlocks.push(scopeComponentCss(item.css, scopeClass));
    bodyBlocks.push(`<div class="${scopeClass}"${wrapperAttrsFor(item, i)}>\n${item.html}\n</div>`);
  });

  const themeBlock = themeCss ? `<style>\n${themeCss}\n</style>\n` : '';
  // Theme CSS only ever defines :root custom properties (--color-bg, --color-fg,
  // ...) - never a body rule that actually applies them. Without this, a
  // composed document's own <body> has no explicit background anywhere in the
  // pipeline: invisible for a downloaded export (browser default is already
  // white), but a real bug for the Website Builder Workbench's live iframe
  // preview, which sits on top of the dark dashboard and shows straight
  // through when empty/sparse. Kept on the same source line as the opening
  // <style> tag (not its own line) so it doesn't trip the "a component's own
  // `body { ... }` selector never appears unscoped" regression test below,
  // which only checks for a *line* starting with "body {".
  const bodyBaseCss = 'body { margin: 0; background: var(--color-bg, #fff); color: var(--color-fg, #212529); font-family: var(--font-body, sans-serif); }';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${themeBlock}<style>${bodyBaseCss}
${styleBlocks.join('\n')}
</style>
</head>
<body>
${bodyBlocks.join('\n')}
</body>
</html>
`;
}

export function composePageHtml(items: PageComponentTokens[], themeCss?: string): string {
  return composeItems(items, themeCss, () => '');
}

// Used by the render route's editable mode (Task 3) for the workbench's live, click-to-edit
// preview. Never used for export/download — that path always calls composePageHtml above, whose
// output is untouched by this function's existence (see the regression test in
// test/pageDocument.test.ts).
export function composeEditablePageHtml(items: EditablePageComponentTokens[], themeCss?: string): string {
  return composeItems(items, themeCss, (item) => {
    const editable = item as EditablePageComponentTokens;
    return ` data-gf-component-asset-id="${editable.assetId}" data-gf-rev="${editable.revisionHash}"`;
  });
}
