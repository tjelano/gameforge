// test/componentGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { combineComponentHtml, parseComponentHtml, MockComponentGenerator } from '@/lib/services/ComponentGenerator';

describe('combineComponentHtml / parseComponentHtml round-trip', () => {
  it('recovers the original html and css after combining and re-parsing', () => {
    const original = {
      html: '<button class="btn-primary">Buy now</button>',
      css: '.btn-primary { background: var(--color-accent); }',
    };
    const combined = combineComponentHtml(original);
    expect(combined).toContain('<!DOCTYPE html>');
    expect(combined).toContain('<style>');
    const parsed = parseComponentHtml(combined);
    expect(parsed.html).toBe(original.html);
    expect(parsed.css).toBe(original.css);
  });
});

describe('MockComponentGenerator', () => {
  it('writes a real file under storage/components/ and returns its filename', async () => {
    const generator = new MockComponentGenerator();
    const result = await generator.generate('a primary button', 'style-1');
    expect(result.path).toMatch(/\.html$/);
    expect(result.prompt).toBe('a primary button');
  });
});
