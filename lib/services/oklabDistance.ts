// Verified against Björn Ottosson's own page (bottosson.github.io/posts/oklab/)
// during planning — linear_srgb_to_oklab is a genuinely separate, independently
// published function from the forward (oklab_to_linear_srgb) direction already
// shipped in lib/services/seedThemes/oklch.ts, not a hand-derived matrix inverse.

import type { ThemeTokens } from '@/lib/services/ThemeGenerator';
import { linearizeChannel, normalizeHex6 } from '@/lib/services/hexColor';

export function hexToOklab(hex: string): { L: number; a: number; b: number } {
  // Expand 3-digit shorthand (e.g. Bootswatch Flatly's '#fff') to 6 digits
  // and reject anything else — same fix already applied for the same reason
  // in contrastChecker.ts (see lib/services/hexColor.ts), since
  // ThemeTokensSchema's CSS_COLOR_RE permits hex of any length 3-8,
  // rgb()/rgba()/hsl()/hsla(), and bare named colors, none of which this
  // function can turn into RGB channels — silently computing NaN here would
  // never flag as similar/different correctly, it would just misbehave.
  // Callers (getThemeDistance's own callers, in the similarity route) must
  // catch this and degrade to "not flagged", per this feature's spec.
  const clean = normalizeHex6(hex, 'Cannot compute an OKLab distance for color');
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

// Recalibrated empirically (throwaway scratch script, not committed) after
// the original 0.01 threshold was found to be calibrated only against
// near-exact-duplicate synthetic shifts and one maximally-different real
// pair — it never fired on the realistic "two independently-generated
// candidates a human would call similar" zone. This pass fetched 5 more
// real, live Bootswatch v5 themes (Darkly, Cosmo, Superhero, Litera, Yeti —
// via https://bootswatch.com/api/5.json, same extraction as
// seedThemes/bootswatchMapper.ts) and computed real getThemeDistance values
// between every pair, plus more realistic near-duplicate shifts. Observed:
//
//   Trivial single-channel shifts (delta 1/3/5/10 of 255):      0.00018 / 0.00054 / 0.00092 / 0.00191
//   Uniform +3/255 shift, all 4 fields (barely perceptible):    0.0107
//   Single-field +16/255 shift (clearly visible to a human):    0.0122
//   All 4 fields independently shifted by a random 5-20/255
//     each — the drift two independent LLM completions of the
//     SAME prompt would plausibly produce (20 trials):          0.029 - 0.063
//   Worst constructed case of the above (full 20/255 on all 4): 0.0714
//   Real, different, professionally-designed theme pairs —
//     closest observed (Cosmo vs Litera, both light/blue-accent): 0.0125
//     next closest (Cosmo vs Yeti / Litera vs Yeti / Flatly vs Yeti): 0.0432 / 0.0506 / 0.0678
//     next (Flatly vs Cosmo / Flatly vs Litera):                 0.0905 / 0.0985
//     everything else (different design language — dark vs
//     light, distinct hue families), MOCK vs Flatly included:   0.11 - 0.62
//
// The "independently-generated near-duplicate" zone (up to ~0.07) and the
// closest real-but-different theme pairs (from ~0.01) genuinely overlap —
// some different Bootswatch themes are objectively closer to each other by
// this metric than some synthetic "regenerate the same idea" shifts are to
// their own origin, because they share the same light-background/dark-text/
// blue-accent family. No threshold perfectly separates every case. 0.08 sits
// just above the observed near-duplicate/drift ceiling (0.0714) and just
// below the closest pair this calibration is confident is meant to read as
// genuinely different (Flatly vs Cosmo, 0.0905) — erring toward catching
// realistic near-duplicates (the documented failure of the old threshold),
// at the cost of occasionally flagging two different-but-visually-similar
// real themes as similar too.
export const SIMILARITY_THRESHOLD = 0.08;
