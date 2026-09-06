import { describe, it, expect } from 'vitest';
import { getContrastRatio, meetsWcagAA } from '@/lib/services/contrastChecker';

describe('getContrastRatio', () => {
  it('returns exactly 21 for black vs white (the maximum possible contrast)', () => {
    expect(getContrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('returns exactly 1 for a color against itself (same luminance both sides)', () => {
    expect(getContrastRatio('#808080', '#808080')).toBeCloseTo(1, 5);
  });

  it('is symmetric — argument order does not matter', () => {
    const a = getContrastRatio('#1c1a17', '#ede7dc');
    const b = getContrastRatio('#ede7dc', '#1c1a17');
    expect(a).toBeCloseTo(b, 10);
  });

  it('expands 3-digit hex shorthand to the same result as its 6-digit form', () => {
    // Real-world regression: Bootswatch seed themes use shorthand hex
    // (e.g. #fff, #222) for --color-bg/--color-fg. Without expansion,
    // relativeLuminance slices past the end of the string and returns NaN.
    expect(getContrastRatio('#fff', '#222')).toBeCloseTo(getContrastRatio('#ffffff', '#222222'), 10);
  });

  it("computes a real theme's contrast ratio correctly", () => {
    // GameForge's own FIXED_MOCK_TOKENS (lib/services/ThemeGenerator.ts):
    // a dark background (#1c1a17) against light cream text (#ede7dc).
    // Hand-derived during planning: approximately 14.1:1 — cross-check
    // this against an independent tool (e.g. https://webaim.org/resources/contrastchecker/,
    // entering #1c1a17 as background and #ede7dc as foreground) before
    // finalizing this test. If your independent check gives a precise
    // value, you may tighten this to `toBeCloseTo(<real value>, 1)`
    // instead of the range check below — either is acceptable as long
    // as the value has been independently verified, not just trusted
    // from this plan's hand derivation.
    const ratio = getContrastRatio('#1c1a17', '#ede7dc');
    expect(ratio).toBeGreaterThan(10);
    expect(ratio).toBeLessThan(18);
  });
});

describe('meetsWcagAA', () => {
  it('passes at exactly the 4.5 threshold', () => {
    expect(meetsWcagAA(4.5)).toBe(true);
  });

  it('fails just below the threshold, unrounded', () => {
    expect(meetsWcagAA(4.499)).toBe(false);
  });

  it('passes for a comfortably high ratio', () => {
    expect(meetsWcagAA(21)).toBe(true);
  });

  it('fails for a comfortably low ratio', () => {
    expect(meetsWcagAA(1)).toBe(false);
  });
});
