// test/pageDocument.test.ts
import { describe, it, expect } from 'vitest';
import { composePageHtml } from '@/lib/services/pageDocument';

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
    expect(html).not.toMatch(/^\s*body\s*\{/m); // never appears unscoped
    expect(html).toContain('body { margin: 0; }'); // still present, but scoped
    expect(html).toMatch(/\.page-item-0\s+body/);
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
});
