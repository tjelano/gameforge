// Verified against the real WCAG 2.1 Success Criterion 1.4.3 formula
// (w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) during planning.
// Only handles 3-digit and 6-digit hex. ThemeTokensSchema's CSS_COLOR_RE
// (lib/services/ThemeGenerator.ts) actually permits hex of any length 3-8,
// rgb()/rgba()/hsl()/hsla(), and bare named colors — none of which this
// function can compute a luminance from, so anything other than 3-digit or
// 6-digit hex throws a clear error (see lib/services/hexColor.ts) instead of
// silently producing a wrong or NaN result (NaN would JSON-serialize as null
// and crash the client on `.toFixed()`).
// Callers (see app/api/assets/[id]/contrast/route.ts) must catch this.
//
// Deliberately stricter than themeExport/w3cExporter.ts's hex handling: that
// exporter drops the alpha byte from 4/8-digit hex and treats the color as
// opaque, which is fine for recording a token's base RGB value. For contrast
// computation specifically, silently ignoring alpha would compute a ratio
// against the wrong effective color (the real rendered result depends on
// what's behind a semi-transparent color) — so 4/8-digit hex is rejected
// here (via normalizeHex6) rather than silently mishandled.

import { linearizeChannel, normalizeHex6 } from '@/lib/services/hexColor';

function relativeLuminance(hex: string): number {
  const clean = normalizeHex6(hex, 'Cannot compute contrast for color');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

export function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsWcagAA(ratio: number): boolean {
  return ratio >= 4.5;
}
