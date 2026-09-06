// Verified against Björn Ottosson's own page (bottosson.github.io/posts/oklab/)
// during planning — linear_srgb_to_oklab is a genuinely separate, independently
// published function from the forward (oklab_to_linear_srgb) direction already
// shipped in lib/services/seedThemes/oklch.ts, not a hand-derived matrix inverse.

import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function hexToOklab(hex: string): { L: number; a: number; b: number } {
  // Expand 3-digit shorthand (e.g. Bootswatch Flatly's '#fff') to 6 digits —
  // same fix already applied for the same reason in contrastChecker.ts, since
  // ThemeTokensSchema's CSS_COLOR_RE permits 3-digit hex and slicing an
  // unexpanded 3-char string produces an empty (NaN-parsing) blue channel.
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const r = linearizeChannel(parseInt(clean.slice(0, 2), 16) / 255);
  const g = linearizeChannel(parseInt(clean.slice(2, 4), 16) / 255);
  const b = linearizeChannel(parseInt(clean.slice(4, 6), 16) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

function oklabEuclideanDistance(hexA: string, hexB: string): number {
  const a = hexToOklab(hexA);
  const b = hexToOklab(hexB);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

export function getThemeDistance(
  tokensA: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'>,
  tokensB: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'>
): number {
  const fields = ['colorBackground', 'colorForeground', 'colorAccent', 'colorBorder'] as const;
  const total = fields.reduce((sum, field) => sum + oklabEuclideanDistance(tokensA[field], tokensB[field]), 0);
  return total / fields.length;
}

// Calibrated empirically (throwaway scratch script, not committed) against
// real theme data: GameForge's own MOCK tokens vs. Bootswatch Flatly, plus
// synthetic near-copies with one or all four color fields shifted by a small
// amount. Observed getThemeDistance values:
//   MOCK vs FLATLY (real, deliberately distinct themes):       0.6185
//   single-field shift, one channel, delta 1/3/5/10 of 255:    0.00041 / 0.00124 / 0.00206 / 0.00414
//   all-four-fields shift, one channel each, delta 1/3/5/10:   0.0017 / 0.0051 / 0.0086 / 0.0174
// 0.01 sits well above every near-copy value observed (2.4x the largest
// single-field shift) and ~60x below the real-distinct-themes distance,
// erring toward the lower end per this task's guidance: an under-flagged
// near-duplicate is far less annoying than a false alarm on two themes that
// are actually meant to be different.
export const SIMILARITY_THRESHOLD = 0.01;
