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
    // GameForge's own FIXED_MOCK_TOKENS (lib/services/ThemeGenerator.ts): a dark
    // background (#1c1a17) against light cream text (#ede7dc). Verified via three
    // independent methods (hand-derivation, an independent script, and WebAIM's
    // published reference values): 14.108851070354959.
    expect(getContrastRatio('#1c1a17', '#ede7dc')).toBeCloseTo(14.11, 2);
  });

  it('correctly fails a real borderline case without rounding up', () => {
    const ratio = getContrastRatio('#fff', '#777');
    expect(ratio).toBeCloseTo(4.478, 3);
    expect(meetsWcagAA(ratio)).toBe(false);
  });

  it('throws a clear error for a non-hex color', () => {
    // ThemeTokensSchema's CSS_COLOR_RE also allows rgb()/rgba()/hsl()/hsla()
    // and bare named colors — none of which this function can turn into a
    // luminance value, so it must throw rather than silently return NaN.
    expect(() => getContrastRatio('rgb(255, 0, 0)', '#ffffff')).toThrow(/rgb\(255, 0, 0\)/);
  });

  it('throws a clear error for a named color, even one that goes through the shorthand-expansion branch first', () => {
    // 'red' has length 3, so it goes through the same shorthand-expansion
    // branch as '#fff' -> '#ffffff' ('red' -> 'rreedd') before failing the
    // final hex-format check — a different path than a non-hex value whose
    // length isn't 3, like 'rgb(255, 0, 0)'.
    expect(() => getContrastRatio('red', '#ffffff')).toThrow(/red/);
  });

  it('throws a clear error for a hex length that is not 3 or 6', () => {
    expect(() => getContrastRatio('#ffff', '#ffffff')).toThrow(/#ffff/);
    expect(() => getContrastRatio('#ffffffff', '#ffffff')).toThrow(/#ffffffff/);
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
