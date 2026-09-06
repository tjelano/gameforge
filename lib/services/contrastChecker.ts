// Verified against the real WCAG 2.1 Success Criterion 1.4.3 formula
// (w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) during planning.
// Only handles 6-digit hex — the only shape any theme generator in this
// codebase actually produces (mock, AI-generated, and all seed themes).

function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
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
