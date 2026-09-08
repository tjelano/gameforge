// lib/services/siteExportDocument.ts
//
// Pure HTML -> JSX text conversion, used only by SiteExporter.ts at
// export time. No DB/fs/Node-only imports - same convention as
// pageDocument.ts and componentDocument.ts. The input HTML has ALREADY
// passed sanitizeComponentHtml, so only the small, fully-known
// ALLOWED_TAGS/ALLOWED_ATTRIBUTES vocabulary from componentSanitize.ts
// can appear here - this function does not need to handle arbitrary
// HTML-in-the-wild edge cases.
//
// The emitted JSX assumes a `styles` import is in scope (a CSS Module,
// e.g. `import styles from './Button-a1b2c3.module.css'`) - SiteExporter.ts
// is responsible for actually writing that import into the generated
// .tsx file; this function only emits the `styles['class-name']`
// reference text.

import { parseDocument } from 'htmlparser2';
import postcss from 'postcss';

interface ParsedNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: ParsedNode[];
}

const ATTRIBUTE_NAME_MAP: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
};

const VOID_ELEMENTS = new Set(['br', 'hr', 'input']);

// Only these two attributes in componentSanitize.ts's ALLOWED_ATTRIBUTES
// are genuine HTML boolean attributes. Per the HTML spec, PRESENCE alone
// means true, regardless of the attribute's string value - browsers
// ignore the value entirely, so both `disabled` and `disabled="disabled"`
// (a real, common LLM-emitted XHTML-style form) mean the same thing.
// React's typing for these props is `boolean`, not `string` - confirmed
// with a real tsc compile that emitting `disabled={"disabled"}` (the old,
// buggy `value === ''`-gated behavior's fallback path for any non-empty
// value) produces TS2322. sanitizeHtml does NOT normalize
// disabled="disabled" to an empty value (confirmed by actually running
// it) - so ANY value on one of these two attributes, not just '', is
// reachable and must always render as the bare JSX shorthand.
const BOOLEAN_ATTRIBUTES = new Set(['disabled', 'required']);

// input/textarea's rows/cols in componentSanitize.ts's ALLOWED_ATTRIBUTES
// are the only two allowlisted attributes React types as `number`, not
// `string` - confirmed with a real tsc compile that rows={"4"} produces
// TS2322. The attribute allowlist has no value-format restriction (an
// LLM could emit non-numeric text), so this coerces defensively rather
// than assuming well-formed input, falling back to a safe positive
// integer default (matches this being a purely cosmetic sizing hint,
// not a security-relevant value).
const NUMERIC_ATTRIBUTES = new Set(['rows', 'cols']);

// Exported (not just used internally) because SiteExporter.ts's
// buildLayoutFile also needs to safely embed free text (a Page's name)
// into generated JSX - the exact same "{`/`}`/`<`/`>` breaks raw JSX
// text" problem applies there too, and reusing this already-tested
// function is safer than duplicating the escaping logic.
export function escapeJsxText(text: string): string {
  // `{`/`}` would be misread as a JSX expression container. `<`/`>` are
  // syntax errors in raw JSX text (confirmed by actually compiling
  // equivalent JSX with tsc --jsx react-jsx: unescaped "<" -> TS1003,
  // unescaped ">" -> TS1382) - text content is NOT restricted by
  // sanitizeComponentHtml (only tags/attributes are), so LLM-generated
  // component copy containing any of these four characters is a real,
  // reachable case, not a hypothetical one.
  if (!/[{}<>]/.test(text)) return text;
  return `{${JSON.stringify(text)}}`;
}

function renderClassAttribute(value: string): string {
  // JSON.stringify is the only safe choice here, not raw interpolation -
  // it always produces double-quoted output, which correctly handles a
  // quote character inside a class name (a real, reachable case: this
  // HTML is AI-generated, and sanitizeComponentHtml allowlists attribute
  // NAMES, not value content). Do not "fix" this to produce
  // single-quoted output to match some other convention - there is no
  // safe way to hand-roll single-quote escaping here that JSON.stringify
  // doesn't already give you for free.
  const classNames = value.split(/\s+/).filter(Boolean);
  if (classNames.length === 1) {
    return `className={styles[${JSON.stringify(classNames[0])}]}`;
  }
  const lookups = classNames.map(c => `\${styles[${JSON.stringify(c)}]}`).join(' ');
  return `className={\`${lookups}\`}`;
}

function renderAttributes(attribs: Record<string, string>): string {
  return Object.entries(attribs).map(([name, value]) => {
    if (name === 'class') return renderClassAttribute(value);
    const jsxName = ATTRIBUTE_NAME_MAP[name] ?? name;
    if (BOOLEAN_ATTRIBUTES.has(name)) return jsxName; // presence alone means true, any value
    if (NUMERIC_ATTRIBUTES.has(name)) {
      const num = Number.parseInt(value, 10);
      return `${jsxName}={${Number.isFinite(num) && num > 0 ? num : 1}}`;
    }
    // Wrapped as a JS string expression ({"..."}), not a bare
    // double-quoted JSX literal - JSX's plain-attribute-string escaping
    // is not the same as JS string escaping, so this guarantees correct
    // escaping via JSON.stringify regardless of the value's content.
    return `${jsxName}={${JSON.stringify(value)}}`;
  }).join(' ');
}

// CSS Modules (both webpack's css-loader and Next 16's Turbopack default)
// compile in "pure" mode, which REJECTS any selector with no local class
// (confirmed by actually running Next's own vendored
// postcss-modules-local-by-default plugin in mode:'pure': `button {...}`,
// `a:hover {...}`, `*{...}`, and `:root{...}` all fail; `.btn`, `.nav a`,
// `.card:hover` all pass). sanitizeComponentCss validates functions and
// at-rules but never selectors, so an LLM-emitted bare-tag/universal/
// pseudo-class rule with no class reaches here unchanged and would break
// the exported project's build with an opaque CSS-loader error the user
// can't fix from inside GameForge. Also handles `id` selectors the same
// way (as global, not local): htmlToJsx emits `id={"..."}` as the raw,
// unmodified string (unlike `class`, which gets rewritten to reference
// the CSS-Module-scoped `styles[...]` object) - so an `#id` rule must
// stay a GLOBAL selector to keep matching the literal, un-hashed id
// CSS Modules would otherwise apply to it.
export function globalizeBareSelectors(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selector = rule.selectors.map(s => (/\.[A-Za-z_-]/.test(s) ? s : `:global(${s})`)).join(', ');
  });
  return root.toString();
}

function renderNode(node: ParsedNode): string {
  if (node.type === 'text') {
    return escapeJsxText(node.data ?? '');
  }
  if (node.type === 'tag' && node.name) {
    const attrs = renderAttributes(node.attribs ?? {});
    const attrsStr = attrs ? ` ${attrs}` : '';
    if (VOID_ELEMENTS.has(node.name)) {
      return `<${node.name}${attrsStr} />`;
    }
    const children = (node.children ?? []).map(renderNode).join('');
    return `<${node.name}${attrsStr}>${children}</${node.name}>`;
  }
  return '';
}

export function htmlToJsx(html: string): string {
  const doc = parseDocument(html) as unknown as { children: ParsedNode[] };
  return doc.children.map(renderNode).join('');
}
