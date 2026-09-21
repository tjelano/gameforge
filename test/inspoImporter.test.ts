import { describe, it, expect } from 'vitest';
import { contrastRatio, parseColorsSection, parseHeaderSection, mapDesignMdToTokens } from '@/lib/services/themeImport/inspoImporter';

describe('contrastRatio', () => {
  it('returns the maximum ratio (21) for pure black vs pure white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#111111', '#eeeeee')).toBeCloseTo(contrastRatio('#eeeeee', '#111111'), 5);
  });

  it('throws a clear error for non-hex input', () => {
    expect(() => contrastRatio('rgb(255, 255, 255)', '#000000')).toThrow(/not a 3- or 6-digit hex color/);
  });
});

describe('parseHeaderSection', () => {
  it('extracts mode and captured date from the Header lines', () => {
    const md = [
      '# DESIGN.md',
      '- **Source:** https://acme.example',
      '- **Captured:** 2026-08-01T00:00:00Z',
      '- **Mode:** dark',
      '- **Macrostructure:** marketing',
      '',
      '## Tone',
    ].join('\n');
    expect(parseHeaderSection(md)).toEqual({ mode: 'dark', capturedAt: '2026-08-01T00:00:00Z' });
  });

  it('returns nulls when the Header lines are absent', () => {
    expect(parseHeaderSection('## Colors\n')).toEqual({ mode: null, capturedAt: null });
  });

  it('ignores a Mode line that appears after a ## heading (body section)', () => {
    const md = [
      '# DESIGN.md',
      '- **Source:** https://acme.example',
      '- **Captured:** 2026-08-01T00:00:00Z',
      '- **Mode:** dark',
      '',
      '## Colors',
      '- **Mode:** light', // stray mode line in body section
      '| Hex | Role |',
    ].join('\n');
    // Should return the header's real mode (dark), not the stray one (light)
    expect(parseHeaderSection(md)).toEqual({ mode: 'dark', capturedAt: '2026-08-01T00:00:00Z' });
  });
});

describe('parseColorsSection', () => {
  it('parses hex + role rows out of the Colors table', () => {
    const md = [
      '## Colors',
      '',
      '| Hex | Role (heuristic) |',
      '|---|---|',
      '| `#ffffff` | surface |',
      '| `#111111` | ink |',
      '| `#3b82f6` | accent |',
      '| `#e5e7eb` | support |',
      '',
      '## Typography',
    ].join('\n');
    expect(parseColorsSection(md)).toEqual([
      { hex: '#ffffff', role: 'surface' },
      { hex: '#111111', role: 'ink' },
      { hex: '#3b82f6', role: 'accent' },
      { hex: '#e5e7eb', role: 'support' },
    ]);
  });

  it('returns an empty array when the Colors section is absent', () => {
    expect(parseColorsSection('## Tone\nsomething\n')).toEqual([]);
  });

  it('does not read past the next section heading', () => {
    const md = [
      '## Colors',
      '| Hex | Role (heuristic) |',
      '|---|---|',
      '| `#ffffff` | surface |',
      '## Typography',
      '| `#000000` | ink |', // malformed table row that happens to appear after the next heading
    ].join('\n');
    expect(parseColorsSection(md)).toEqual([{ hex: '#ffffff', role: 'surface' }]);
  });

  it('silently drops color rows with invalid hex lengths (e.g. 4-digit)', () => {
    const md = [
      '## Colors',
      '| Hex | Role (heuristic) |',
      '|---|---|',
      '| `#fff` | valid-3digit |',
      '| `#abcd` | invalid-4digit |',
      '| `#ffffff` | valid-6digit |',
      '',
      '## Typography',
    ].join('\n');
    // Only 3-digit and 6-digit hex are captured; 4-digit is silently dropped
    expect(parseColorsSection(md)).toEqual([
      { hex: '#fff', role: 'valid-3digit' },
      { hex: '#ffffff', role: 'valid-6digit' },
    ]);
  });
});

const RICH_LIGHT_MODE_DESIGN_MD = [
  '# DESIGN.md',
  '- **Source:** https://acme.example',
  '- **Captured:** 2026-08-01T00:00:00Z',
  '- **Mode:** light',
  '',
  '## Colors',
  '| Hex | Role (heuristic) |',
  '|---|---|',
  '| `#ffffff` | surface |',
  '| `#111111` | ink |',
  '| `#3b82f6` | accent |',
  '| `#e5e7eb` | support |',
  '| `#9ca3af` | muted |',
  '',
  '## Typography',
  'Detected typefaces: **Inter**, **Georgia**',
  '',
  '## Spacing scale',
  '`4px` · `8px` · `16px` · `24px`',
  'Base step looks like **8px**.',
  '',
  '## Border radius',
  '`6px` · `12px`',
].join('\n');

const DARK_MODE_DESIGN_MD = RICH_LIGHT_MODE_DESIGN_MD.replace('**Mode:** light', '**Mode:** dark');

const MOSTLY_EMPTY_DESIGN_MD = '# DESIGN.md\n- **Source:** https://empty.example\n';

const ONE_FONT_DESIGN_MD = RICH_LIGHT_MODE_DESIGN_MD.replace('Detected typefaces: **Inter**, **Georgia**', 'Detected typefaces: **Inter**');

// Injects a css-var override for colorBackground that resolves to a valid
// but NON-hex CSS_COLOR_RE value (rgb()), while still providing support/muted
// swatches for the colorBorder heuristic to consider. Exercises the case
// where contrastRatio(candidate.hex, tokens.colorBackground) would throw
// (hexToRgb rejects non-hex input) if colorBorder's contrast-picking loop
// didn't guard against it.
const NON_HEX_BG_DESIGN_MD = [
  '# DESIGN.md',
  '- **Source:** https://acme.example',
  '- **Captured:** 2026-08-01T00:00:00Z',
  '- **Mode:** light',
  '',
  '```css',
  ':root {',
  '  --bg: rgb(250, 250, 250);',
  '}',
  '```',
  '',
  '## Colors',
  '| Hex | Role (heuristic) |',
  '|---|---|',
  '| `#ffffff` | surface |',
  '| `#111111` | ink |',
  '| `#3b82f6` | accent |',
  '| `#cccccc` | support |',
  '| `#888888` | muted |',
].join('\n');

describe('mapDesignMdToTokens', () => {
  it('maps a rich light-mode DESIGN.md using the heuristic color roles', () => {
    const result = mapDesignMdToTokens(RICH_LIGHT_MODE_DESIGN_MD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.colorBackground).toBe('#ffffff');
    expect(result.tokens.colorForeground).toBe('#111111');
    expect(result.tokens.colorAccent).toBe('#3b82f6');
    expect(result.tokens.fontHeading).toBe('Inter');
    expect(result.tokens.fontBody).toBe('Georgia');
    expect(result.tokens.spaceUnit).toBe('8px');
    expect(result.tokens.radiusBase).toBe('6px');
    expect(result.lowConfidence).toBe(false);
    expect(result.capturedAt).toBe('2026-08-01T00:00:00Z');
    expect(result.provenance.colorBackground).toBe('heuristic');
  });

  it('inverts background/foreground role assignment in dark mode', () => {
    const light = mapDesignMdToTokens(RICH_LIGHT_MODE_DESIGN_MD);
    const dark = mapDesignMdToTokens(DARK_MODE_DESIGN_MD);
    if (!light.success || !dark.success) throw new Error('setup failed');
    // Same swatches, opposite mode -> opposite background/foreground pick.
    expect(dark.tokens.colorBackground).toBe(light.tokens.colorForeground);
    expect(dark.tokens.colorForeground).toBe(light.tokens.colorBackground);
  });

  it('picks the lowest-contrast support/muted swatch for colorBorder, not the first one', () => {
    // support (#e5e7eb) has lower contrast against white than muted (#9ca3af) here,
    // so colorBorder should be the support swatch, not simply "first listed".
    const result = mapDesignMdToTokens(RICH_LIGHT_MODE_DESIGN_MD);
    if (!result.success) throw new Error('setup failed');
    expect(result.tokens.colorBorder).toBe('#e5e7eb');
  });

  it('reuses a single detected font for both heading and body', () => {
    const result = mapDesignMdToTokens(ONE_FONT_DESIGN_MD);
    if (!result.success) throw new Error('setup failed');
    expect(result.tokens.fontHeading).toBe('Inter');
    expect(result.tokens.fontBody).toBe('Inter');
  });

  it('sets lowConfidence when more than half the fields default', () => {
    const result = mapDesignMdToTokens(MOSTLY_EMPTY_DESIGN_MD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.lowConfidence).toBe(true);
    expect(Object.values(result.provenance).filter(t => t === 'default').length).toBeGreaterThan(4);
  });

  it('never lets raw DESIGN.md prose reach the returned tokens (untrusted-text invariant)', () => {
    const maliciousProse = "'; } body { background: url(https://evil.example/steal) } .x {";
    const md = RICH_LIGHT_MODE_DESIGN_MD + `\n## Tone\n${maliciousProse}\n`;
    const result = mapDesignMdToTokens(md);
    if (!result.success) throw new Error('setup failed');
    const serialized = JSON.stringify(result.tokens);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('background:');
  });

  it('falls back to the default colorBorder without crashing when colorBackground resolves to a non-hex CSS color', () => {
    // css-var tier resolves colorBackground to "rgb(250, 250, 250)" (valid
    // per CSS_COLOR_RE, but not hex-shaped). The colorBorder heuristic then
    // calls contrastRatio(candidate.hex, tokens.colorBackground) for each
    // support/muted swatch, which would throw (hexToRgb rejects non-hex
    // input) — this must be caught, not crash the whole mapper, and must
    // fall through to colorBorder's default rather than a stray value.
    const result = mapDesignMdToTokens(NON_HEX_BG_DESIGN_MD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.colorBackground).toBe('rgb(250, 250, 250)');
    expect(result.provenance.colorBackground).toBe('css-var');
    // Falls all the way through to the field default (not one of the
    // #cccccc/#888888 candidate swatches, and not a thrown exception).
    expect(result.tokens.colorBorder).toBe('#e5e7eb');
    expect(result.provenance.colorBorder).toBe('default');
  });
});
