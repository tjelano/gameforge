import sanitizeHtml from 'sanitize-html';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { parseDocument, DomUtils } from 'htmlparser2';
import render from 'dom-serializer';
import type { Element as DomElement } from 'domhandler';

/**
 * Required security invariant of the component-preview sandbox relaxation
 * (sandbox="allow-same-origin") — see docs/superpowers/specs/2026-09-14-element-specific-patching-design.md.
 * `script-src` is deliberately absent and falls back to `default-src 'none'`, blocking script
 * execution even if a future change mistakenly adds `allow-scripts` to the sandbox attribute.
 * Never weaken this without updating that spec's security reasoning first.
 */
export const COMPONENT_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

// A deliberately narrow allowlist for real website UI pieces (buttons,
// cards, nav bars, forms) — see docs/superpowers/specs/2026-09-07-
// component-generation-design.md's security note for why sanitization,
// not the sandboxed preview, is this feature's actual safety guarantee:
// the generated HTML+CSS is meant to be copied directly into the user's
// own real website, not just displayed inside GameForge.
// `img` is deliberately excluded: this scope (buttons, cards, nav bars)
// has no real need for external photographic images, and disallowing the
// tag entirely is the only way this module can actually deliver on
// "no external resources, ever" on the HTML side.
const ALLOWED_TAGS = [
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'button',
  'nav', 'header', 'footer', 'section', 'article',
  'form', 'label', 'input', 'textarea', 'select', 'option',
  'strong', 'em', 'b', 'i', 'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'id', 'data-gf-id'],
  a: ['href', 'target', 'rel'],
  button: ['type', 'disabled'],
  input: ['type', 'name', 'placeholder', 'value', 'required'],
  textarea: ['name', 'placeholder', 'rows', 'cols'],
  select: ['name'],
  option: ['value'],
  label: ['for'],
};

export function sanitizeComponentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    disallowedTagsMode: 'discard',
  });
}

// Allowlist of safe CSS functions, not a blocklist of dangerous ones — a
// brand-new CSS function (image-set(), cross-fade(), whatever ships next)
// defaults to REJECTED, not silently permitted. This is the actual fix for
// the substring-blocklist pattern that failed 3 times in a row (hex-escaped
// url(), bare-string @import, image-set()).
const ALLOWED_CSS_FUNCTIONS = new Set([
  'var', 'calc', 'min', 'max', 'clamp',
  'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'color',
  'repeat', 'minmax',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'skew', 'skewx', 'skewy',
  'matrix', 'matrix3d',
  'cubic-bezier', 'steps',
  'attr', 'counter', 'counters', 'env',
]);

export function sanitizeComponentCss(css: string): string {
  // Closes the <style>-tag-breakout vector at the source. A quoted CSS
  // string value (e.g. `content: "</style><script>...";`) is syntactically
  // valid CSS that a real parser accepts without complaint, so this needs
  // its own check independent of the parser-based ones below.
  if (/<\/style/i.test(css)) {
    throw new Error('Component CSS cannot contain "</style".');
  }

  // Same category of breakout as the </style check above, for the other two
  // literal markers combineComponentHtml/parseComponentHtml's naive indexOf
  // extraction depends on — a quoted CSS string value containing <body or
  // </body is syntactically valid CSS that silently corrupts that extraction
  // (wrong html/css spliced from the wrong positions) rather than throwing.
  if (/<body|<\/body/i.test(css)) {
    throw new Error('Component CSS cannot contain "<body" or "</body".');
  }

  // Real parsing, not substring blocklisting — see ALLOWED_CSS_FUNCTIONS
  // comment above for why. Malformed CSS that fails to parse is rejected
  // too; this function has no need to accept invalid CSS.
  const root = postcss.parse(css);

  // Plain declarations only: reject every at-rule, not just known-dangerous
  // ones (@import, @font-face, ...). Simple button/card/nav-bar CSS has no
  // real need for at-rules, and rejecting all of them closes off every
  // current AND future at-rule-based resource-loading vector in one move.
  root.walkAtRules((rule) => {
    throw new Error(`Component CSS cannot contain at-rules (found @${rule.name}).`);
  });

  root.walkDecls((decl) => {
    const parsedValue = valueParser(decl.value);
    parsedValue.walk((node) => {
      // node.value === '' is a bare grouping paren (e.g. the outer (...) in
      // `calc((var(--space-unit) * 3) - 2px)`), not a function call — skip
      // the allowlist check for it. .walk() still descends into its
      // children regardless, so a disallowed function hidden inside extra
      // parens is still caught on its own real name.
      if (node.type === 'function' && node.value !== '' && !ALLOWED_CSS_FUNCTIONS.has(node.value.toLowerCase())) {
        throw new Error(`Component CSS cannot use the "${node.value}(...)" function.`);
      }
    });
  });

  return css;
}

function isElement(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'tag';
}

function walkElementsInDocumentOrder(root: DomElement): DomElement[] {
  const out: DomElement[] = [];
  function visit(node: DomElement) {
    out.push(node);
    for (const child of node.children) {
      if (isElement(child)) visit(child);
    }
  }
  visit(root);
  return out;
}

const GF_PATCH_CLASS_PATTERN = /^gf-\d+$/;

// A `gf-<n>` class only means something paired with the data-gf-id it was assigned for — full-write
// mode is reassigning fresh ids to every element here, so any gf-<n> class already on the incoming
// html (e.g. echoed back by the AI when "Regenerate with changes" shows it the current markup as a
// starting point, per buildComponentPrompt) is now an orphan: it doesn't match any id in the
// document being produced and has no CSS rule of its own reason to exist post-regenerate. Stripped
// here, not just left as harmless-looking dead weight, so class lists don't silently accumulate
// class names from prior patches across repeated regenerations.
function stripStalePatchClasses(el: DomElement): void {
  const classAttr = el.attribs['class'];
  if (!classAttr) return;
  const kept = classAttr.split(/\s+/).filter((c) => c && !GF_PATCH_CLASS_PATTERN.test(c));
  if (kept.length > 0) el.attribs['class'] = kept.join(' ');
  else delete el.attribs['class'];
}

/**
 * Assigns permanent `data-gf-id` attributes to every element in an HTML fragment.
 *
 * Full-write mode (no `opts.preserveRootId`): strips any incoming `data-gf-id` from every
 * element and renumbers the whole fragment from 1, in document order. Also strips any stale
 * `gf-<n>` patch-marker class (see stripStalePatchClasses) — that class only means something
 * paired with the specific id it was assigned for, which full-write mode is discarding anyway.
 * Used by the component write paths (generate, manual edit, reset) — never trusts an id an AI
 * response or hand-edit happened to already carry.
 *
 * Patch mode (`opts.preserveRootId` set): the fragment's single root element keeps that exact
 * id; every other element in the fragment has any incoming `data-gf-id` stripped and gets a
 * fresh one starting at `opts.startAt` (required — the caller must pass
 * `max(existing data-gf-id in the full stored document) + 1`, so ids stay unique across the
 * whole document, not just within this fragment).
 */
export function assignElementIds(html: string, opts?: { preserveRootId?: string; startAt?: number }): string {
  if (opts?.preserveRootId !== undefined && opts.startAt === undefined) {
    throw new Error('assignElementIds: startAt is required when preserveRootId is set.');
  }

  const dom = parseDocument(html);
  const roots = dom.children.filter(isElement);

  if (opts?.preserveRootId !== undefined) {
    const [root, ...rest] = roots;
    if (!root || rest.length > 0) {
      throw new Error('assignElementIds: preserveRootId mode requires exactly one root element.');
    }
    root.attribs['data-gf-id'] = opts.preserveRootId;
    let counter = opts.startAt!;
    for (const el of walkElementsInDocumentOrder(root)) {
      if (el === root) continue;
      delete el.attribs['data-gf-id'];
      el.attribs['data-gf-id'] = String(counter);
      counter += 1;
    }
  } else {
    let counter = 1;
    for (const root of roots) {
      for (const el of walkElementsInDocumentOrder(root)) {
        delete el.attribs['data-gf-id'];
        el.attribs['data-gf-id'] = String(counter);
        stripStalePatchClasses(el);
        counter += 1;
      }
    }
  }

  return render(dom);
}
