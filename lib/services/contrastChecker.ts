// Verified against the real WCAG 2.1 Success Criterion 1.4.3 formula
// (w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) during planning.
// Only handles 3-digit and 6-digit hex. ThemeTokensSchema's CSS_COLOR_RE
// (lib/services/ThemeGenerator.ts) actually permits hex of any length 3-8,
// rgb()/rgba()/hsl()/hsla(), and bare named colors — none of those are hex
// luminance can be computed from here, so relativeLuminance throws for
// anything outside 3-digit/6-digit hex rather than silently returning NaN
// (NaN would JSON-serialize as null and crash the client on `.toFixed()`).
// Callers (see app/api/assets/[id]/contrast/route.ts) must catch this.

function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map(c => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Cannot compute contrast for color "${hex}" — only 3-digit or 6-digit hex colors are supported.`);
  }
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
