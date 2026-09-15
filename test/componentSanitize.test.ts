import { describe, it, expect } from 'vitest';
import { sanitizeComponentHtml, sanitizeComponentCss, COMPONENT_PREVIEW_CSP, assignElementIds } from '@/lib/services/componentSanitize';

describe('sanitizeComponentHtml', () => {
  it('strips a <script> tag entirely', () => {
    const dirty = '<div>Hello<script>alert(1)</script></div>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');
  });

  it('strips an onclick attribute but keeps the element', () => {
    const dirty = '<button onclick="alert(1)">Click me</button>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('<button');
    expect(clean).toContain('Click me');
  });

  it('strips a javascript: href', () => {
    const dirty = '<a href="javascript:alert(1)">link</a>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('javascript:');
  });

  it('passes a realistic, legitimate component through with its structure intact', () => {
    const clean = '<button class="btn-primary">Buy now</button>';
    const result = sanitizeComponentHtml(clean);
    expect(result).toContain('<button');
    expect(result).toContain('class="btn-primary"');
    expect(result).toContain('Buy now');
  });

  // img is deliberately not in ALLOWED_TAGS: a perfect CSS check alone
  // can't deliver "no external resources, ever" if <img src="https://...">
  // is still allowed through unchanged on the HTML side.
  it('strips an <img> tag entirely, not just its src attribute', () => {
    const dirty = '<img src="https://evil.example/x.png">';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('<img');
  });

  // `for` links a <label> to its <input> by id — dropping it silently
  // breaks the accessible association for every Form component.
  it('preserves the for attribute on <label>', () => {
    const clean = sanitizeComponentHtml('<label for="email">Email</label><input id="email">');
    expect(clean).toContain('for="email"');
  });
});

describe('sanitizeComponentCss', () => {
  it('rejects CSS containing url( in a background property', () => {
    expect(() => sanitizeComponentCss('.btn { background: url(https://evil.example/track.gif); }')).toThrow();
  });

  it('rejects CSS containing an @import with url(', () => {
    expect(() => sanitizeComponentCss("@import url('https://evil.example/style.css');")).toThrow();
  });

  it('rejects CSS with mixed-case URL(', () => {
    expect(() => sanitizeComponentCss('.btn { background: URL(https://evil.example/x.png); }')).toThrow();
  });

  it('passes through legitimate CSS with no url() references unchanged', () => {
    const css = '.btn { background: var(--color-accent); color: var(--color-bg); padding: calc(var(--space-unit) * 2); border-radius: var(--radius-base); }';
    expect(sanitizeComponentCss(css)).toBe(css);
  });

  // CSS Syntax Level 3 decodes hex-escape sequences in identifiers before a
  // real parser decides whether it's looking at the url() function, so
  // `\75rl(...)` is semantically identical to `url(...)` to every browser
  // even though the literal substring "url(" never appears. These pin the
  // exact bypass payloads a reviewer found against the bare /url\(/i regex.
  it('rejects a hex-escaped "u" bypass: \\75rl(...)', () => {
    expect(() => sanitizeComponentCss('a { background: \\75rl(https://evil.example/track.gif); }')).toThrow();
  });

  it('rejects a fully hex-escaped "url" bypass: \\75\\72\\6c(...)', () => {
    expect(() => sanitizeComponentCss('a { background: \\75\\72\\6c(https://evil.example/track.gif); }')).toThrow();
  });

  it('rejects a zero-padded hex-escape bypass: \\000075rl(...)', () => {
    expect(() => sanitizeComponentCss('a { background: \\000075rl(https://evil.example/track.gif); }')).toThrow();
  });

  it('rejects a bypass with escaped parens: \\75rl\\28...\\29', () => {
    expect(() => sanitizeComponentCss('a { background: \\75rl\\28https://evil.example/track.gif\\29; }')).toThrow();
  });

  // @import has two valid syntaxes per the CSS Import Rules spec:
  // `@import url(...)` and the bare-string form `@import "...";` — the
  // latter loads external resources without ever containing "url(" or a
  // backslash, so it bypassed both prior checks entirely.
  it('rejects the bare-string @import bypass (no url(), no backslash)', () => {
    expect(() => sanitizeComponentCss('@import "https://evil.example/style.css";')).toThrow();
  });

  it('rejects @import url(...) explicitly (not just via the generic url() test)', () => {
    expect(() => sanitizeComponentCss("@import url('https://evil.example/style.css');")).toThrow();
  });

  // Round 3: a live-browser-verified bypass. CSS Images Level 4's bare-string
  // <image-set-option> syntax loads an external resource exactly like url(),
  // but contains neither "url(", a backslash, nor "@import" — it defeated
  // all 3 substring checks above, which is why sanitizeComponentCss was
  // rewritten to parse real CSS (postcss) and allowlist function names
  // (postcss-value-parser) instead of blocklisting known-bad substrings.
  it('rejects the image-set() bypass (no url(), no backslash, no @import)', () => {
    expect(() =>
      sanitizeComponentCss('.btn { background-image: image-set("https://evil.example/track.png" 1x); }')
    ).toThrow();
  });

  it('rejects any at-rule, not just @import (e.g. @font-face)', () => {
    expect(() => sanitizeComponentCss('@font-face { src: url(x.woff); }')).toThrow();
  });

  it('rejects an unknown/unsafe function not in the allowlist (cross-fade)', () => {
    expect(() =>
      sanitizeComponentCss('.btn { background: cross-fade(url(a.png), url(b.png)); }')
    ).toThrow();
  });

  // The design spec's later <style>-embedding template is vulnerable to a
  // literal "</style" sequence breaking out of the tag once combined into a
  // document. A quoted CSS string value containing it is syntactically
  // valid CSS (postcss.parse accepts it without complaint), so this needs
  // its own check independent of the at-rule/function-allowlist checks.
  it('rejects CSS containing a </style breakout sequence', () => {
    expect(() =>
      sanitizeComponentCss('.btn { color: red; }</style><img src="https://evil.example/x.png">')
    ).toThrow();
  });

  it('passes through legitimate CSS using rgba() and linear-gradient() unchanged', () => {
    const css = '.btn { background: linear-gradient(rgba(0, 0, 0, 0.5), red); }';
    expect(sanitizeComponentCss(css)).toBe(css);
  });

  // postcss-value-parser represents a bare grouping paren (the outer (...)
  // in an expression like calc((a) - b), used purely for precedence, not a
  // function call) as a function-type node with an empty name (value: '').
  // That empty string isn't in ALLOWED_CSS_FUNCTIONS, so ordinary CSS math
  // using extra parens for grouping was being rejected outright.
  it('passes through legitimate CSS using grouping parens inside calc() unchanged', () => {
    const css = '.btn { padding: calc((var(--space-unit) * 3) - 2px); }';
    expect(sanitizeComponentCss(css)).toBe(css);
  });

  it('passes through legitimate CSS with doubly-nested grouping parens unchanged', () => {
    const css = '.btn { font-size: clamp(4px, calc((100vw - 320px) / 100), 24px); }';
    expect(sanitizeComponentCss(css)).toBe(css);
  });

  // combineComponentHtml/parseComponentHtml round-trip components by naive
  // indexOf on the <body>/</body> markers, same as the <style>/</style>
  // markers above. A quoted CSS string value containing either literal
  // marker is syntactically valid CSS (postcss.parse accepts it without
  // complaint) and silently corrupts parseComponentHtml's extraction —
  // wrong html/css spliced from the wrong positions, no exception thrown.
  it('rejects CSS containing a <body breakout sequence', () => {
    expect(() => sanitizeComponentCss('.a { content: "<body>hijack"; }')).toThrow();
  });

  it('rejects CSS containing a </body breakout sequence', () => {
    expect(() => sanitizeComponentCss('.a { content: "</body>hijack"; }')).toThrow();
  });
});

describe('COMPONENT_PREVIEW_CSP', () => {
  it('is the exact pinned literal — not just internally self-consistent', () => {
    // Pinned literal, not "matches itself" — a regression that weakens this string
    // (e.g. adding a script-src, loosening img-src) must fail this test even though
    // every other reference to the constant would still trivially match it.
    expect(COMPONENT_PREVIEW_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:;");
  });

  it('has no script-src override (relies on default-src none)', () => {
    expect(COMPONENT_PREVIEW_CSP).not.toContain('script-src');
  });

  it('restricts img-src to data: only', () => {
    expect(COMPONENT_PREVIEW_CSP).toMatch(/img-src data:;?$/);
  });
});

describe('assignElementIds', () => {
  it('assigns sequential ids in document order, full-write mode', () => {
    const html = '<div><span>a</span><button>b</button></div>';
    const result = assignElementIds(html);
    expect(result).toContain('data-gf-id="1"');
    expect(result).toContain('data-gf-id="2"');
    expect(result).toContain('data-gf-id="3"');
    // div gets 1, span gets 2, button gets 3 — outer-to-inner, then next sibling
    const divMatch = result.match(/<div data-gf-id="(\d+)"/);
    const spanMatch = result.match(/<span data-gf-id="(\d+)"/);
    const buttonMatch = result.match(/<button data-gf-id="(\d+)"/);
    expect(divMatch![1]).toBe('1');
    expect(spanMatch![1]).toBe('2');
    expect(buttonMatch![1]).toBe('3');
  });

  it('strips and reassigns any incoming data-gf-id in full-write mode — never trusts it', () => {
    const html = '<div data-gf-id="999"><span data-gf-id="999">a</span></div>';
    const result = assignElementIds(html);
    expect(result).not.toContain('data-gf-id="999"');
    // Two elements, two DIFFERENT fresh ids — not both left at 999
    const ids = [...result.matchAll(/data-gf-id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['1', '2']);
  });

  it('strips a stale gf-<n> patch-marker class in full-write mode — it belonged to a discarded id', () => {
    const html = '<div class="card"><button class="btn-primary gf-3" data-gf-id="3">Buy</button></div>';
    const result = assignElementIds(html);
    expect(result).not.toContain('gf-3');
    expect(result).toContain('class="btn-primary"');
    // Unrelated classes on other elements survive untouched
    expect(result).toContain('class="card"');
  });

  it('drops the class attribute entirely in full-write mode if a gf-<n> class was the only one', () => {
    const html = '<button class="gf-5">Buy</button>';
    const result = assignElementIds(html);
    expect(result).not.toContain('gf-5');
    expect(result).not.toContain('class=');
  });

  it('preserveRootId mode: does NOT strip a gf-<n> class — that stripping is full-write-mode-only', () => {
    // stripStalePatchClasses is only wired into the full-write branch (a descendant's own
    // gf-<n> class, e.g. from a prior separate patch before it was nested under this new
    // patch, has nothing to do with THIS patch's root id and stays intact).
    const fragment = '<div data-gf-id="root"><button class="gf-3">ok</button></div>';
    const result = assignElementIds(fragment, { preserveRootId: 'root', startAt: 20 });
    expect(result).toContain('class="gf-3"');
  });

  it('preserveRootId mode: keeps the root id, reassigns every descendant from startAt', () => {
    const fragment = '<button data-gf-id="stale"><span>ok</span></button>';
    const result = assignElementIds(fragment, { preserveRootId: '7', startAt: 20 });
    expect(result).toContain('data-gf-id="7"');
    expect(result).toContain('data-gf-id="20"');
    expect(result).not.toContain('data-gf-id="stale"');
  });

  it('preserveRootId mode: strips an id a descendant already carries, never trusts it', () => {
    // Simulates the AI's returned fragment hallucinating/copying an id onto a child —
    // must be stripped and reassigned, not passed through, per the spec's round-3 fix (N5).
    const fragment = '<div data-gf-id="7"><span data-gf-id="3">already tagged</span></div>';
    const result = assignElementIds(fragment, { preserveRootId: '7', startAt: 50 });
    expect(result).toContain('data-gf-id="7"');
    expect(result).not.toContain('data-gf-id="3"');
    expect(result).toContain('data-gf-id="50"');
  });

  it('preserveRootId mode throws if startAt is omitted', () => {
    expect(() => assignElementIds('<div></div>', { preserveRootId: '1' })).toThrow();
  });
});
