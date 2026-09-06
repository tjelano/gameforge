// Verified against Björn Ottosson's own page (bottosson.github.io/posts/oklab/)
// during planning — linear_srgb_to_oklab is a genuinely separate, independently
// published function from the forward (oklab_to_linear_srgb) direction already
// shipped in lib/services/seedThemes/oklch.ts, not a hand-derived matrix inverse.

function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function hexToOklab(hex: string): { L: number; a: number; b: number } {
  const clean = hex.replace('#', '');
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
