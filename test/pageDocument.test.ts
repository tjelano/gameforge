// test/pageDocument.test.ts
import { describe, it, expect } from 'vitest';
import { composePageHtml, composeEditablePageHtml } from '@/lib/services/pageDocument';

describe('composePageHtml', () => {
  it('wraps each component in a uniquely-scoped container, in order', () => {
    const html = composePageHtml([
      { html: '<button class="btn">A</button>', css: '.btn { color: red; }' },
      { html: '<button class="btn">B</button>', css: '.btn { color: blue; }' },
    ]);
    // Both components' HTML present, in order.
    const indexA = html.indexOf('>A<');
    const indexB = html.indexOf('>B<');
    expect(indexA).toBeGreaterThan(-1);
    expect(indexB).toBeGreaterThan(indexA);
  });

  it('scopes identically-named classes so they do not collide', () => {
    const html = composePageHtml([
      { html: '<div class="title">A</div>', css: '.title { color: red; }' },
      { html: '<div class="title">B</div>', css: '.title { color: blue; }' },
    ]);
    // The two ".title" rules must be scoped under DIFFERENT prefixes -
    // extract every "<prefix> .title" occurrence and confirm there are two
    // distinct prefixes, not one shared rule applying to both.
    const matches = [...html.matchAll(/(\.page-item-\d+)\s+\.title/g)].map(m => m[1]);
    expect(new Set(matches).size).toBe(2);
  });

  it('neutralizes a broad selector (body) by scoping it under the wrapper, where no real <body> exists', () => {
    const html = composePageHtml([
      { html: '<p>hi</p>', css: 'body { margin: 0; }' },
    ]);
    // The component's own `body { margin: 0; }` rule must never appear
    // unscoped/un-prefixed -- only as ".page-item-0 body { margin: 0; }".
    // (Not a blanket "no line starts with body{" check: composeItems' own
    // framework-owned base body rule is a legitimate, intentional unscoped
    // body rule with different content, and a check keyed on line-start
    // position would be fragile against it.)
    expect(html).not.toContain('\nbody { margin: 0; }');
    expect(html).toContain('.page-item-0 body { margin: 0; }');
  });

  it('injects theme CSS exactly once regardless of component count', () => {
    const themeCss = ':root { --color-accent: #ff6600; }';
    const html = composePageHtml([
      { html: '<p>A</p>', css: '.a {}' },
      { html: '<p>B</p>', css: '.b {}' },
      { html: '<p>C</p>', css: '.c {}' },
    ], themeCss);
    const occurrences = html.split('--color-accent: #ff6600').length - 1;
    expect(occurrences).toBe(1);
  });

  it('omits theme CSS entirely when none is given', () => {
    const html = composePageHtml([{ html: '<p>hi</p>', css: '.a {}' }]);
    expect(html).not.toContain(':root');
  });

  it('leaves var(...) references inside declaration values untouched by scoping', () => {
    const html = composePageHtml([
      { html: '<button class="btn">Go</button>', css: '.btn { background: var(--color-accent); padding: calc(var(--space-unit) * 2); }' },
    ]);
    expect(html).toContain('background: var(--color-accent)');
    expect(html).toContain('padding: calc(var(--space-unit) * 2)');
  });

  it('produces a valid standalone HTML document with one <style> and one <body>', () => {
    const html = composePageHtml([{ html: '<p>hi</p>', css: '.a { color: red; }' }]);
    expect(html).toContain('<!DOCTYPE html>');
    expect((html.match(/<style>/g) ?? []).length).toBe(1);
    expect((html.match(/<body>/g) ?? []).length).toBe(1);
  });

  it('returns a minimal empty document for zero components', () => {
    const html = composePageHtml([]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<body>');
  });

  // Regression test for the Website Builder Workbench "black box" bug: a page
  // with zero (or few) components rendered inside the live preview iframe had
  // no explicit <body> background anywhere in the pipeline (themeCss only
  // ever defines :root custom properties, never a body rule that reads them),
  // so the transparent iframe showed the dark dashboard behind it instead of
  // a page preview. composeItems must set a real body background itself.
  it('gives <body> a real background reading the theme, not just transparent, even with zero components', () => {
    const themeCss = ':root { --color-bg: #123456; }';
    const html = composePageHtml([], themeCss);
    expect(html).toContain('background: var(--color-bg');
    // Confirm --color-bg maps to `background`, not accidentally swapped with
    // the --color-fg (text color) variable.
    expect(html).not.toContain('background: var(--color-fg');
  });

  it('falls back to a real (non-transparent) background even when no theme is given at all', () => {
    const html = composePageHtml([]);
    expect(html).toContain('background: var(--color-bg, #fff)');
  });
});

describe('composeEditablePageHtml', () => {
  it('wraps each component with its asset id and revision hash as data attributes', () => {
    const html = composeEditablePageHtml([
      { html: '<button class="btn">A</button>', css: '.btn { color: red; }', assetId: 'asset-1', revisionHash: 'hash-1' },
      { html: '<button class="btn">B</button>', css: '.btn { color: blue; }', assetId: 'asset-2', revisionHash: 'hash-2' },
    ]);
    expect(html).toContain('data-gf-component-asset-id="asset-1"');
    expect(html).toContain('data-gf-rev="hash-1"');
    expect(html).toContain('data-gf-component-asset-id="asset-2"');
    expect(html).toContain('data-gf-rev="hash-2"');
  });

  it('still scopes CSS per item the same way composePageHtml does', () => {
    const html = composeEditablePageHtml([
      { html: '<div class="title">A</div>', css: '.title { color: red; }', assetId: 'a1', revisionHash: 'h1' },
      { html: '<div class="title">B</div>', css: '.title { color: blue; }', assetId: 'a2', revisionHash: 'h2' },
    ]);
    const matches = [...html.matchAll(/(\.page-item-\d+)\s+\.title/g)].map(m => m[1]);
    expect(new Set(matches).size).toBe(2);
  });

  it('produces the exact same output as composePageHtml when the extra fields are stripped, proving no drift between the two wrapper shapes', () => {
    const plainItems = [
      { html: '<p>hi</p>', css: '.a { color: red; }' },
      { html: '<p>bye</p>', css: '.b { color: blue; }' },
    ];
    const editableItems = plainItems.map((item, i) => ({ ...item, assetId: `asset-${i}`, revisionHash: `hash-${i}` }));
    const plain = composePageHtml(plainItems);
    const editable = composeEditablePageHtml(editableItems)
      .replace(/ data-gf-component-asset-id="[^"]*"/g, '')
      .replace(/ data-gf-rev="[^"]*"/g, '');
    expect(editable).toBe(plain);
  });
});

it('composePageHtml output is unaffected by the existence of composeEditablePageHtml (regression guard)', () => {
  const html = composePageHtml([{ html: '<p>hi</p>', css: '.a { color: red; }' }]);
  expect(html).not.toContain('data-gf-component-asset-id');
  expect(html).not.toContain('data-gf-rev');
});
