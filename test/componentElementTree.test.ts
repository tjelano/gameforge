import { describe, it, expect } from 'vitest';
import {
  findElementByDataGfId,
  replaceElementByDataGfId,
  maxDataGfId,
  hashDocument,
} from '@/lib/services/componentElementTree';

describe('findElementByDataGfId', () => {
  it('finds a single match', () => {
    const html = '<div><span data-gf-id="3">hi</span></div>';
    const result = findElementByDataGfId(html, '3');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.outerHtml).toContain('hi');
      expect(result.outerHtml).toContain('data-gf-id="3"');
    }
  });

  it('reports not found for a missing id', () => {
    const result = findElementByDataGfId('<div data-gf-id="1"></div>', '99');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.ambiguous).toBe(false);
  });

  it('reports ambiguous for a duplicate id — fails closed, does not pick the first match', () => {
    const html = '<div data-gf-id="5"></div><span data-gf-id="5"></span>';
    const result = findElementByDataGfId(html, '5');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.ambiguous).toBe(true);
  });

  it('returns the classes already on the matched element', () => {
    const html = '<button data-gf-id="1" class="btn primary">Go</button>';
    const result = findElementByDataGfId(html, '1');
    expect(result.found).toBe(true);
    if (result.found) expect(result.classes).toEqual(['btn', 'primary']);
  });

  it('finds an element nested multiple levels deep', () => {
    const html = '<div><section><article><span data-gf-id="7">deep content</span></article></section></div>';
    const result = findElementByDataGfId(html, '7');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.outerHtml).toContain('deep content');
      expect(result.outerHtml).toContain('data-gf-id="7"');
    }
  });
});

describe('replaceElementByDataGfId', () => {
  it('replaces the matched element subtree in place, leaving siblings untouched', () => {
    const html = '<div><span data-gf-id="1">old</span><p data-gf-id="2">keep</p></div>';
    const result = replaceElementByDataGfId(html, '1', '<span data-gf-id="1" class="gf-1">new</span>');
    expect(result).toContain('new');
    expect(result).not.toContain('old');
    expect(result).toContain('keep');
  });

  it('throws if the id is not found', () => {
    expect(() => replaceElementByDataGfId('<div data-gf-id="1"></div>', '99', '<div></div>')).toThrow();
  });

  it('throws if the id is ambiguous', () => {
    const html = '<div data-gf-id="1"></div><span data-gf-id="1"></span>';
    expect(() => replaceElementByDataGfId(html, '1', '<div></div>')).toThrow();
  });

  it('throws if replacement HTML contains multiple root elements', () => {
    const html = '<div><span data-gf-id="1">target</span></div>';
    expect(() => replaceElementByDataGfId(html, '1', '<span>root1</span><span>root2</span>')).toThrow();
  });

  it('throws if replacement HTML contains zero root elements (empty or text-only)', () => {
    const html = '<div><span data-gf-id="1">target</span></div>';
    expect(() => replaceElementByDataGfId(html, '1', '')).toThrow();
  });

  it('replaces an element nested multiple levels deep, preserving structure', () => {
    const html = '<div><section><article><span data-gf-id="5">old deep</span></article></section></div>';
    const result = replaceElementByDataGfId(html, '5', '<span data-gf-id="5">new deep</span>');
    expect(result).toContain('new deep');
    expect(result).not.toContain('old deep');
    expect(result).toContain('<article>');
    expect(result).toContain('<section>');
  });
});

describe('maxDataGfId', () => {
  it('returns the highest id present', () => {
    const html = '<div data-gf-id="3"><span data-gf-id="10"></span><p data-gf-id="2"></p></div>';
    expect(maxDataGfId(html)).toBe(10);
  });

  it('returns 0 when no element carries the attribute', () => {
    expect(maxDataGfId('<div><span></span></div>')).toBe(0);
  });
});

describe('hashDocument', () => {
  it('is deterministic for identical input', () => {
    expect(hashDocument('same content')).toBe(hashDocument('same content'));
  });

  it('differs for different input', () => {
    expect(hashDocument('a')).not.toBe(hashDocument('b'));
  });
});
