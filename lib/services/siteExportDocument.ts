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
// are genuine HTML boolean attributes (presence = true, regardless of
// value). An empty-string VALUE on any other attribute (e.g.
// <option value=""> or <input placeholder="">) is a real empty string,
// not "attribute absent" - it must still render as `name={""}`, never
// be silently treated as boolean shorthand.
const BOOLEAN_ATTRIBUTES = new Set(['disabled', 'required']);

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
    if (BOOLEAN_ATTRIBUTES.has(name) && value === '') return jsxName; // boolean shorthand, e.g. `disabled`
    // Wrapped as a JS string expression ({"..."}), not a bare
    // double-quoted JSX literal - JSX's plain-attribute-string escaping
    // is not the same as JS string escaping, so this guarantees correct
    // escaping via JSON.stringify regardless of the value's content.
    return `${jsxName}={${JSON.stringify(value)}}`;
  }).join(' ');
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
