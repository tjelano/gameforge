import { describe, it, expect } from 'vitest';
import { tokensToW3cTokens } from '@/lib/services/themeExport/w3cExporter';
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

const TOKENS: ThemeTokens = {
  colorBackground: '#ffffff',
  colorForeground: '#212529',
  colorAccent: '#2c3e50',
  colorBorder: '#dee2e6',
  fontHeading: "'Playfair Display', serif",
  fontBody: "'Lato', sans-serif",
  spaceUnit: '0.5rem',
  radiusBase: '0.375rem',
};

describe('tokensToW3cTokens', () => {
  it('produces valid Design Tokens Format Module JSON with the verified token shapes', () => {
    const doc = JSON.parse(tokensToW3cTokens(TOKENS));

    // Color: #ffffff -> components [1, 1, 1]; #212529 -> [33,37,41]/255
    expect(doc.color.background).toEqual({
      $type: 'color',
      $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 },
    });
    expect(doc.color.foreground.$type).toBe('color');
    expect(doc.color.foreground.$value.colorSpace).toBe('srgb');
    expect(doc.color.foreground.$value.components[0]).toBeCloseTo(0x21 / 255, 5);
    expect(doc.color.foreground.$value.components[1]).toBeCloseTo(0x25 / 255, 5);
    expect(doc.color.foreground.$value.components[2]).toBeCloseTo(0x29 / 255, 5);
    expect(doc.color.foreground.$value.alpha).toBe(1);

    // Font family: multiple names -> array
    expect(doc.font.heading).toEqual({ $type: 'fontFamily', $value: ['Playfair Display', 'serif'] });
    expect(doc.font.body).toEqual({ $type: 'fontFamily', $value: ['Lato', 'sans-serif'] });

    // Dimension: value + unit split out
    expect(doc.dimension['space-unit']).toEqual({ $type: 'dimension', $value: { value: 0.5, unit: 'rem' } });
    expect(doc.dimension['radius-base']).toEqual({ $type: 'dimension', $value: { value: 0.375, unit: 'rem' } });
  });

  it('handles 3-digit hex shorthand', () => {
    // #f0a expands to #ff00aa: r=0xff, g=0x00, b=0xaa
    const doc = JSON.parse(tokensToW3cTokens({ ...TOKENS, colorAccent: '#f0a' }));
    expect(doc.color.accent.$value.components[0]).toBeCloseTo(1, 5);
    expect(doc.color.accent.$value.components[1]).toBeCloseTo(0, 5);
    expect(doc.color.accent.$value.components[2]).toBeCloseTo(0xaa / 255, 5);
  });

  it('throws a clear error for a non-hex color', () => {
    expect(() => tokensToW3cTokens({ ...TOKENS, colorAccent: 'rgb(255, 0, 0)' })).toThrow(/hex/);
  });

  it('throws a clear error for an em dimension unit', () => {
    expect(() => tokensToW3cTokens({ ...TOKENS, spaceUnit: '1em' })).toThrow(/px|rem/);
  });

  it('uses a single string (not an array) for a single-name font', () => {
    const doc = JSON.parse(tokensToW3cTokens({ ...TOKENS, fontBody: 'Arial' }));
    expect(doc.font.body).toEqual({ $type: 'fontFamily', $value: 'Arial' });
  });
});
