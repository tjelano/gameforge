import sanitizeHtml from 'sanitize-html';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

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
  '*': ['class', 'id'],
  a: ['href', 'target', 'rel'],
  button: ['type', 'disabled'],
  input: ['type', 'name', 'placeholder', 'value', 'required'],
  textarea: ['name', 'placeholder', 'rows', 'cols'],
  select: ['name'],
  option: ['value'],
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
