import { describe, it, expect } from 'vitest';
import { contrastRatio, parseColorsSection, parseHeaderSection } from '@/lib/services/themeImport/inspoImporter';

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
