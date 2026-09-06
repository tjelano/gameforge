import { describe, it, expect } from 'vitest';
import { hexToOklab } from '@/lib/services/oklabDistance';
import { oklchToHex } from '@/lib/services/seedThemes/oklch';

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
});
