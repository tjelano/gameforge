import { describe, it, expect } from 'vitest';
import { hexToOklab, getThemeDistance, SIMILARITY_THRESHOLD } from '@/lib/services/oklabDistance';
import { oklchToHex } from '@/lib/services/seedThemes/oklch';
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

describe('hexToOklab', () => {
  it('produces a≈0 and b≈0 for any gray color, regardless of lightness', () => {
    const darkGray = hexToOklab('#333333');
    const midGray = hexToOklab('#808080');
    const lightGray = hexToOklab('#cccccc');
    for (const { a, b } of [darkGray, midGray, lightGray]) {
      expect(a).toBeCloseTo(0, 3);
      expect(b).toBeCloseTo(0, 3);
    }
    // Lightness must still increase with the gray value.
    expect(darkGray.L).toBeLessThan(midGray.L);
    expect(midGray.L).toBeLessThan(lightGray.L);
  });

  it('produces L=0 for black and L=1 for white', () => {
    expect(hexToOklab('#000000').L).toBeCloseTo(0, 5);
    expect(hexToOklab('#ffffff').L).toBeCloseTo(1, 5);
  });

  it('round-trips through the existing forward OKLCh pipeline within a small tolerance', () => {
    // oklchToHex(76.76, 0.184, 183.61) is already verified (Seed Theme
    // Library feature) to produce '#00d7c0'. Converting that hex back to
    // Oklab and checking its lightness matches the original L (0.7676)
    // is a genuine round-trip check against independently-sourced code,
    // not a tautology — hexToOklab never calls oklchToHex or vice versa.
    const hex = oklchToHex(76.76, 0.184, 183.61);
    const lab = hexToOklab(hex);
    expect(lab.L).toBeCloseTo(0.7676, 1);
  });

  it('matches independently-computed reference values for chromatic (non-gray) colors', () => {
    // The gray-color test above can't catch a coefficient swap within the a/b
    // rows (l'=m'=s' for gray, so which term multiplies which coefficient
    // doesn't matter). These reference values come from an independent
    // source (the culori npm library's rgb->oklab conversion) and were
    // additionally hand-verified against this file's own matrix coefficients
    // by direct arithmetic, so this pins the actual per-term wiring, not
    // just the overall gray-axis identity.
    const red = hexToOklab('#ff0000');
    expect(red.L).toBeCloseTo(0.627955, 2);
    expect(red.a).toBeCloseTo(0.224863, 2);
    expect(red.b).toBeCloseTo(0.125846, 2);

    const blue = hexToOklab('#0000ff');
    expect(blue.L).toBeCloseTo(0.452014, 2);
    expect(blue.a).toBeCloseTo(-0.032457, 2);
    expect(blue.b).toBeCloseTo(-0.311528, 2);
  });

  it('throws a clear error for a non-hex color instead of silently producing NaN', () => {
    // ThemeTokensSchema's CSS_COLOR_RE also allows rgb()/rgba()/hsl()/hsla()
    // and bare named colors — none of which this function can turn into RGB
    // channels, so it must throw rather than silently return NaN (mirrors
    // contrastChecker.ts's relativeLuminance, same underlying helper).
    expect(() => hexToOklab('rgb(255, 0, 0)')).toThrow(/rgb\(255, 0, 0\)/);
  });

  it('throws a clear error for a hex length that is not 3 or 6', () => {
    expect(() => hexToOklab('#ffff')).toThrow(/#ffff/);
  });
});

const MOCK: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'> = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
};
const FLATLY: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'> = {
  colorBackground: '#fff', colorForeground: '#212529', colorAccent: '#2c3e50', colorBorder: '#dee2e6',
};

describe('getThemeDistance', () => {
  it('returns exactly 0 for a theme compared against itself', () => {
    expect(getThemeDistance(MOCK as ThemeTokens, MOCK as ThemeTokens)).toBeCloseTo(0, 8);
  });

  it('returns a large distance for two genuinely different, real, designer-made themes', () => {
    // MOCK (dark, warm, editorial) vs FLATLY (light, cool, corporate) —
    // two real, fully-confirmed, deliberately distinct palettes.
    const distance = getThemeDistance(MOCK as ThemeTokens, FLATLY as ThemeTokens);
    expect(distance).toBeGreaterThan(SIMILARITY_THRESHOLD);
  });

  it('flags a near-identical theme (one channel shifted by a tiny amount) as too similar', () => {
    const almostMock = { ...MOCK, colorAccent: '#e8a340' }; // #e8a33d shifted by 3 in the blue channel
    const distance = getThemeDistance(MOCK as ThemeTokens, almostMock as ThemeTokens);
    expect(distance).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('flags a single-field shift that is clearly visible to a human as too similar', () => {
    // This is the exact case the pre-recalibration 0.01 threshold missed:
    // a +16/255 shift on one channel is obviously different to a human eye,
    // but is still the kind of drift two generations of "the same idea"
    // would plausibly produce, not a genuinely different design.
    const almostMock = { ...MOCK, colorAccent: '#f8b34d' }; // #e8a33d shifted +16/255 per RGB channel
    const distance = getThemeDistance(MOCK as ThemeTokens, almostMock as ThemeTokens);
    expect(distance).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('flags a moderate, independent, multi-field color drift as too similar', () => {
    // Represents the realistic "two independent LLM completions of the same
    // prompt" case: all four fields shifted by a different, moderate
    // (5-20/255) amount each rather than one tiny single-channel nudge.
    // One concrete sample from that distribution (recorded during
    // recalibration, distance ~0.048), used here as a fixed regression case.
    const drifted = {
      ...MOCK,
      colorBackground: '#172808',
      colorForeground: '#dad9d3',
      colorAccent: '#f99c48',
      colorBorder: '#353e19',
    };
    const distance = getThemeDistance(MOCK as ThemeTokens, drifted as ThemeTokens);
    expect(distance).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('does not flag two real, different, professionally-designed themes that happen to share a similar palette family', () => {
    // Real Bootswatch pair fetched live during recalibration: Flatly vs
    // Cosmo (0.0905) — both light-background/blue-accent themes, but still
    // meant to read as genuinely different designs, and the closest
    // real-different pair observed that the chosen threshold must still
    // clear.
    const COSMO: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'> = {
      colorBackground: '#fff', colorForeground: '#373a3c', colorAccent: '#2780e3', colorBorder: '#dee2e6',
    };
    const distance = getThemeDistance(FLATLY as ThemeTokens, COSMO as ThemeTokens);
    expect(distance).toBeGreaterThan(SIMILARITY_THRESHOLD);
  });
});
