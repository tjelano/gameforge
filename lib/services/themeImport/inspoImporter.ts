function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function srgbChannelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** Standard WCAG contrast ratio (1 to 21) between two hex colors. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface DesignMdColorSwatch {
  hex: string;
  role: string;
}

/** Slices the body of a `## <heading>` markdown section out of a full DESIGN.md, stopping at the next `## ` heading (or end of document). Returns '' if the heading isn't present. */
function sliceSection(designMd: string, heading: string): string {
  const headingRe = new RegExp(`^## ${heading}\\s*$`, 'm');
  const match = headingRe.exec(designMd);
  if (!match) return '';
  const startOfBody = match.index + match[0].length;
  const rest = designMd.slice(startOfBody);
  const nextHeadingMatch = /^## /m.exec(rest);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

const COLOR_ROW_RE = /^\|\s*`?(#[0-9a-fA-F]{3,8})`?\s*\|\s*([^|]+?)\s*\|\s*$/gm;

export function parseColorsSection(designMd: string): DesignMdColorSwatch[] {
  const body = sliceSection(designMd, 'Colors');
  if (!body) return [];
  const out: DesignMdColorSwatch[] = [];
  for (const match of body.matchAll(COLOR_ROW_RE)) {
    out.push({ hex: match[1].toLowerCase(), role: match[2].trim().toLowerCase() });
  }
  return out;
}

export function parseHeaderSection(designMd: string): { mode: 'light' | 'dark' | null; capturedAt: string | null } {
  const modeMatch = /^-\s*\*\*Mode:\*\*\s*(.+)$/m.exec(designMd);
  const capturedMatch = /^-\s*\*\*Captured:\*\*\s*(.+)$/m.exec(designMd);
  const rawMode = modeMatch?.[1]?.trim().toLowerCase();
  return {
    mode: rawMode === 'dark' ? 'dark' : rawMode === 'light' ? 'light' : null,
    capturedAt: capturedMatch?.[1]?.trim() ?? null,
  };
}
