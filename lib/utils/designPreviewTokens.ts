export type ColorTokenKey =
  | 'bg' | 'surface' | 'surfaceRaised' | 'border'
  | 'ink' | 'inkDim' | 'inkFaint'
  | 'accent' | 'accentBright' | 'accentDim' | 'accent2' | 'accentInk'
  | 'keeper' | 'keeperDim' | 'reject' | 'rejectDim';

export type FontTokenKey = 'fontDisplay' | 'fontBody' | 'fontMono';

export interface DesignPreviewTokenState extends Record<ColorTokenKey, string> {
  radius: string;
  fontDisplay: string;
  fontBody: string;
  fontMono: string;
}

export const COLOR_TOKENS: { key: ColorTokenKey; cssVar: string; label: string }[] = [
  { key: 'bg', cssVar: '--bg', label: 'Background' },
  { key: 'surface', cssVar: '--surface', label: 'Surface' },
  { key: 'surfaceRaised', cssVar: '--surface-raised', label: 'Surface (raised)' },
  { key: 'border', cssVar: '--border', label: 'Border' },
  { key: 'ink', cssVar: '--ink', label: 'Ink' },
  { key: 'inkDim', cssVar: '--ink-dim', label: 'Ink (dim)' },
  { key: 'inkFaint', cssVar: '--ink-faint', label: 'Ink (faint)' },
  { key: 'accent', cssVar: '--accent', label: 'Accent' },
  { key: 'accentBright', cssVar: '--accent-bright', label: 'Accent (bright)' },
  { key: 'accentDim', cssVar: '--accent-dim', label: 'Accent (dim)' },
  { key: 'accent2', cssVar: '--accent-2', label: 'Accent 2' },
  { key: 'accentInk', cssVar: '--accent-ink', label: 'Accent ink' },
  { key: 'keeper', cssVar: '--keeper', label: 'Keeper' },
  { key: 'keeperDim', cssVar: '--keeper-dim', label: 'Keeper (dim)' },
  { key: 'reject', cssVar: '--reject', label: 'Reject' },
  { key: 'rejectDim', cssVar: '--reject-dim', label: 'Reject (dim)' },
];

export const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: "var(--font-sentient), Georgia, serif", label: 'Sentient' },
  { value: "var(--font-satoshi), -apple-system, 'Segoe UI', sans-serif", label: 'Satoshi' },
  { value: "var(--font-plex-mono), 'IBM Plex Mono', monospace", label: 'IBM Plex Mono' },
];

export const FONT_TOKENS: { key: FontTokenKey; cssVar: string; label: string; defaultValue: string }[] = [
  { key: 'fontDisplay', cssVar: '--font-display', label: 'Display (headings)', defaultValue: FONT_OPTIONS[0].value },
  { key: 'fontBody', cssVar: '--font-body', label: 'Body', defaultValue: FONT_OPTIONS[1].value },
  { key: 'fontMono', cssVar: '--font-mono', label: 'Mono', defaultValue: FONT_OPTIONS[2].value },
];

export const DEFAULT_RADIUS = 7;

export function isValidHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function parseRadiusPx(computed: string): number {
  const n = parseInt(computed, 10);
  return Number.isNaN(n) ? DEFAULT_RADIUS : n;
}

export function formatRadiusPx(value: string | number): string {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return `${Number.isNaN(n) ? DEFAULT_RADIUS : n}px`;
}

export function normalizeHex(value: string): string {
  return value.trim().toUpperCase();
}

export function serializeTokensToCss(state: DesignPreviewTokenState): string {
  const lines: string[] = [':root {'];
  for (const t of COLOR_TOKENS) {
    lines.push(`  ${t.cssVar}: ${normalizeHex(state[t.key])};`);
  }
  lines.push(`  --radius: ${formatRadiusPx(state.radius)};`);
  for (const t of FONT_TOKENS) {
    lines.push(`  ${t.cssVar}: ${state[t.key]};`);
  }
  lines.push('}');
  return lines.join('\n');
}
