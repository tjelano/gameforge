import { ThemeTokensSchema, type ThemeTokens } from '@/lib/services/themeTokens';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (!/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    throw new TypeError(`hexToRgb: not a 3- or 6-digit hex color: ${JSON.stringify(hex)}`);
  }
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

const COLOR_ROW_RE = /^\|\s*`?(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})`?\s*\|\s*([^|]+?)\s*\|\s*$/gm;

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
  // Scope to header block: text before the first ## heading (or entire document if no heading)
  const firstHeadingMatch = /^## /m.exec(designMd);
  const headerBlock = firstHeadingMatch ? designMd.slice(0, firstHeadingMatch.index) : designMd;

  const modeMatch = /^-\s*\*\*Mode:\*\*\s*(.+)$/m.exec(headerBlock);
  const capturedMatch = /^-\s*\*\*Captured:\*\*\s*(.+)$/m.exec(headerBlock);
  const rawMode = modeMatch?.[1]?.trim().toLowerCase();
  return {
    mode: rawMode === 'dark' ? 'dark' : rawMode === 'light' ? 'light' : null,
    capturedAt: capturedMatch?.[1]?.trim() ?? null,
  };
}

export type FieldProvenance = Record<keyof ThemeTokens, 'css-var' | 'heuristic' | 'default'>;

export type MapDesignMdResult =
  | { success: true; tokens: ThemeTokens; provenance: FieldProvenance; lowConfidence: boolean; capturedAt: string | null }
  | { success: false; error: string };

const DEFAULT_TOKEN_VALUES: ThemeTokens = {
  colorBackground: '#ffffff',
  colorForeground: '#111111',
  colorAccent: '#3b82f6',
  colorBorder: '#e5e7eb',
  fontHeading: 'system-ui, sans-serif',
  fontBody: 'system-ui, sans-serif',
  spaceUnit: '8px',
  radiusBase: '4px',
};

function parseCssVarBlock(designMd: string): Map<string, string> {
  const out = new Map<string, string>();
  const fenceMatch = /```css\s*\n:root\s*\{([\s\S]*?)\}\s*\n```/.exec(designMd);
  if (!fenceMatch) return out;
  const body = fenceMatch[1];
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

const CSS_VAR_NAME_ALIASES: Record<keyof ThemeTokens, string[]> = {
  colorBackground: ['--bg', '--background', '--surface', '--paper'],
  colorForeground: ['--fg', '--foreground', '--text', '--ink'],
  colorAccent: ['--accent', '--primary', '--brand'],
  colorBorder: ['--border', '--outline', '--divider'],
  fontHeading: ['--font-heading', '--heading-font', '--font-display'],
  fontBody: ['--font-body', '--body-font', '--font-base'],
  spaceUnit: ['--space-unit', '--spacing', '--space'],
  radiusBase: ['--radius', '--radius-base', '--border-radius'],
};

function tryCssVarTier(cssVars: Map<string, string>, field: keyof ThemeTokens): string | null {
  for (const alias of CSS_VAR_NAME_ALIASES[field]) {
    const value = cssVars.get(alias);
    if (value === undefined) continue;
    const singleFieldSchema = ThemeTokensSchema.shape[field];
    const validated = singleFieldSchema.safeParse(value);
    if (validated.success) return validated.data as string;
  }
  return null;
}

function parseTypography(designMd: string): string[] {
  const body = sliceSection(designMd, 'Typography');
  const match = /Detected typefaces:\s*(.+)$/m.exec(body);
  if (!match) return [];
  const faces: string[] = [];
  for (const m of match[1].matchAll(/\*\*(.+?)\*\*/g)) {
    faces.push(m[1].trim());
  }
  return faces;
}

function parseSpacingBaseUnit(designMd: string): number | null {
  const body = sliceSection(designMd, 'Spacing scale');
  const match = /Base step looks like \*\*(\d+)px\*\*/.exec(body);
  return match ? Number(match[1]) : null;
}

function parseFirstRadiusPx(designMd: string): number | null {
  const body = sliceSection(designMd, 'Border radius');
  const match = /`(\d+)px`/.exec(body);
  return match ? Number(match[1]) : null;
}

function pickRoleSwatch(swatches: DesignMdColorSwatch[], role: string): string | null {
  const found = swatches.find(s => s.role === role);
  return found ? found.hex : null;
}

/**
 * mapDesignMdToTokens: turns raw DESIGN.md markdown into a validated
 * ThemeTokens object. Preference order per field, matching DESIGN.md's own
 * stated signal quality: (1) a validated CSS custom-property value from the
 * fenced :root block, if a name match happens to exist AND validate — this
 * is opportunistic, not primary, since real sites have no shared variable
 * naming convention; (2) the Colors table's heuristic role guess, always
 * available and mode-aware; (3) a fixed default. A field never fails the
 * whole import — it always resolves to SOME value, with its tier recorded
 * in `provenance`. Invariant: nothing here ever returns raw DESIGN.md prose
 * — every value that survives has already passed ThemeTokensSchema's
 * allowlist regex.
 */
export function mapDesignMdToTokens(designMd: string): MapDesignMdResult {
  const { mode, capturedAt } = parseHeaderSection(designMd);
  const swatches = parseColorsSection(designMd);
  const cssVars = parseCssVarBlock(designMd);

  const provenance = {} as FieldProvenance;
  const tokens = {} as Record<keyof ThemeTokens, string>;

  function resolve(field: keyof ThemeTokens, heuristicValue: string | null): void {
    const cssVarValue = tryCssVarTier(cssVars, field);
    if (cssVarValue !== null) {
      tokens[field] = cssVarValue;
      provenance[field] = 'css-var';
      return;
    }
    if (heuristicValue !== null) {
      const validated = ThemeTokensSchema.shape[field].safeParse(heuristicValue);
      if (validated.success) {
        tokens[field] = validated.data as string;
        provenance[field] = 'heuristic';
        return;
      }
    }
    tokens[field] = DEFAULT_TOKEN_VALUES[field];
    provenance[field] = 'default';
  }

  // guessRole() (Inspo's own algorithm) already accounts for mode internally
  // when it assigns role LABELS, but the roles it hands us here are named
  // by luminance position (lightest/darkest), not by "background"/
  // "foreground" semantics — so which physical role becomes GameForge's
  // colorBackground vs colorForeground still depends on mode: in light
  // mode the surface (lightest) role is the background; in dark mode the
  // ink (darkest) role plays that part instead.
  const surfaceHex = pickRoleSwatch(swatches, 'surface');
  const inkHex = pickRoleSwatch(swatches, 'ink');
  const backgroundHeuristic = mode === 'dark' ? inkHex : surfaceHex;
  const foregroundHeuristic = mode === 'dark' ? surfaceHex : inkHex;

  resolve('colorBackground', backgroundHeuristic);
  resolve('colorForeground', foregroundHeuristic);
  resolve('colorAccent', pickRoleSwatch(swatches, 'accent'));

  // colorBorder's contrast-picking runs against tokens.colorBackground,
  // which by this point may have resolved via the css-var tier to a
  // non-hex (but still CSS_COLOR_RE-valid) value such as rgb(...) or a
  // named color — ThemeTokensSchema allows those, contrastRatio/hexToRgb
  // do not. Guard the whole contrast comparison so a non-hex background
  // degrades this field to "no heuristic winner found" (falls through to
  // the field default below) instead of throwing out of the entire mapper.
  const borderCandidates = swatches.filter(s => s.role === 'support' || s.role === 'muted');
  let colorBorderHeuristic: string | null = null;
  if (borderCandidates.length > 0 && tokens.colorBackground) {
    try {
      let lowestContrast = Infinity;
      for (const candidate of borderCandidates) {
        const ratio = contrastRatio(candidate.hex, tokens.colorBackground);
        if (ratio < lowestContrast) {
          lowestContrast = ratio;
          colorBorderHeuristic = candidate.hex;
        }
      }
    } catch {
      colorBorderHeuristic = null;
    }
  }
  resolve('colorBorder', colorBorderHeuristic);

  const fonts = parseTypography(designMd);
  resolve('fontHeading', fonts[0] ?? null);
  resolve('fontBody', fonts[1] ?? fonts[0] ?? null);

  const baseUnit = parseSpacingBaseUnit(designMd);
  resolve('spaceUnit', baseUnit !== null ? `${baseUnit}px` : null);

  const firstRadius = parseFirstRadiusPx(designMd);
  resolve('radiusBase', firstRadius !== null ? `${firstRadius}px` : null);

  const validated = ThemeTokensSchema.safeParse(tokens);
  if (!validated.success) {
    // Should be unreachable given every field above already validates
    // before being accepted — kept as a hard boundary in case a future
    // field addition forgets to route through resolve().
    return { success: false, error: `Mapped tokens failed final validation: ${validated.error.message}` };
  }

  const defaultCount = Object.values(provenance).filter(t => t === 'default').length;
  const lowConfidence = defaultCount > 4;

  return { success: true, tokens: validated.data, provenance, lowConfidence, capturedAt };
}
