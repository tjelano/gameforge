import { describe, it, expect } from 'vitest';
import { resolveSourceTarget } from '@/lib/preview/findInSource';

describe('resolveSourceTarget', () => {
  it('returns null for both when dataGfId is null', () => {
    const result = resolveSourceTarget(null, '<button data-gf-id="1">x</button>', '.gf-1 { color: red; }');
    expect(result).toEqual({ html: null, css: null });
  });

  it('finds the data-gf-id attribute range in html', () => {
    const html = '<div><button data-gf-id="3">Buy</button></div>';
    const result = resolveSourceTarget('3', html, '');
    expect(result.html).not.toBeNull();
    expect(html.slice(result.html!.start, result.html!.end)).toBe('data-gf-id="3"');
  });

  it('returns null html when no matching data-gf-id exists', () => {
    const html = '<div><button data-gf-id="3">Buy</button></div>';
    const result = resolveSourceTarget('99', html, '');
    expect(result.html).toBeNull();
  });

  it('finds the .gf-<id> selector range in css', () => {
    const css = '.card { color: blue; }\n.gf-3 { color: red; }';
    const result = resolveSourceTarget('3', '', css);
    expect(result.css).not.toBeNull();
    expect(css.slice(result.css!.start, result.css!.end)).toBe('.gf-3');
  });

  it('returns null css when no .gf-<id> rule exists (most elements have none)', () => {
    const css = '.btn-primary { color: blue; }';
    const result = resolveSourceTarget('3', '', css);
    expect(result.css).toBeNull();
  });

  it('does not match .gf-3 as a substring of .gf-31', () => {
    const css = '.gf-31 { color: green; }';
    const result = resolveSourceTarget('3', '', css);
    expect(result.css).toBeNull();
  });

  it('does not match .gf-3 as a substring of prefix-gf-3', () => {
    const css = '.prefix-gf-3 { color: green; }';
    const result = resolveSourceTarget('3', '', css);
    expect(result.css).toBeNull();
  });

  it('handles a regex-special id safely without throwing (defensive, even though real ids are digit-only)', () => {
    const css = '.gf-3 { color: red; }';
    expect(() => resolveSourceTarget('3.', '', css)).not.toThrow();
    expect(resolveSourceTarget('3.', '', css).css).toBeNull();
  });

  it('still finds a regex-special id when the CSS actually contains that literal selector (single-escape, not double-escape)', () => {
    // A hypothetical non-digit id containing a regex-special character — real ids are digit-only,
    // but the escaping must still find a genuine match, not just fail safe on one that isn't real.
    const css = '.gf-3.x { color: red; }';
    const result = resolveSourceTarget('3.x', '', css);
    expect(result.css).toEqual({ start: 0, end: 7 });
  });
});
