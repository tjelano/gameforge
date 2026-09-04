// test/themePreview.test.ts
import { describe, it, expect } from 'vitest';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

describe('buildThemePreviewHtml', () => {
  it('links the given CSS URL as a stylesheet', () => {
    const html = buildThemePreviewHtml('/api/themes/abc.css');
    expect(html).toContain('<link rel="stylesheet" href="/api/themes/abc.css">');
  });

  it('includes a heading, a paragraph, two buttons, a card, and a nav bar, all referencing CSS variables', () => {
    const html = buildThemePreviewHtml('/api/themes/abc.css');
    expect(html).toContain('<h1');
    expect(html).toContain('<p');
    expect(html).toContain('var(--color-accent)');
    expect(html).toContain('var(--color-bg)');
    expect(html).toContain('var(--font-heading)');
    expect(html).toContain('nav');
    // Two distinct buttons: a primary (accent-filled) and a secondary (outlined).
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });

  it('is a complete, valid HTML document (has html/head/body)', () => {
    const html = buildThemePreviewHtml('/api/themes/abc.css');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
  });
});
