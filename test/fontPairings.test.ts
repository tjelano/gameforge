// test/fontPairings.test.ts
import { describe, it, expect } from 'vitest';
import { DAISYUI_THEME_NAMES, BOOTSWATCH_THEME_NAMES, getFontPairing } from '@/lib/services/seedThemes/fontPairings';

describe('getFontPairing', () => {
  it('has a font pairing for every real DaisyUI theme name', () => {
    for (const name of DAISYUI_THEME_NAMES) {
      const pairing = getFontPairing(name);
      expect(pairing.fontHeading.length).toBeGreaterThan(0);
      expect(pairing.fontBody.length).toBeGreaterThan(0);
    }
  });

  it('has a font pairing for every real Bootswatch theme name', () => {
    for (const name of BOOTSWATCH_THEME_NAMES) {
      const pairing = getFontPairing(name);
      expect(pairing.fontHeading.length).toBeGreaterThan(0);
      expect(pairing.fontBody.length).toBeGreaterThan(0);
    }
  });

  it('throws a clear error for an unknown theme name', () => {
    expect(() => getFontPairing('not-a-real-theme')).toThrow(/not-a-real-theme/);
  });

  it('lists exactly 32 DaisyUI names and 26 Bootswatch names', () => {
    expect(DAISYUI_THEME_NAMES.length).toBe(32);
    expect(BOOTSWATCH_THEME_NAMES.length).toBe(26);
  });
});
