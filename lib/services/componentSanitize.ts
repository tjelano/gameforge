import sanitizeHtml from 'sanitize-html';

// A deliberately narrow allowlist for real website UI pieces (buttons,
// cards, nav bars, forms) — see docs/superpowers/specs/2026-09-07-
// component-generation-design.md's security note for why sanitization,
// not the sandboxed preview, is this feature's actual safety guarantee:
// the generated HTML+CSS is meant to be copied directly into the user's
// own real website, not just displayed inside GameForge.
const ALLOWED_TAGS = [
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'button', 'img',
  'nav', 'header', 'footer', 'section', 'article',
  'form', 'label', 'input', 'textarea', 'select', 'option',
  'strong', 'em', 'b', 'i', 'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'id'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt'],
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

export function sanitizeComponentCss(css: string): string {
  if (/url\(/i.test(css)) {
    throw new Error('Component CSS cannot reference external resources (url(...) is not supported).');
  }
  return css;
}
