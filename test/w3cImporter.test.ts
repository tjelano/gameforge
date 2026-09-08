import { describe, it, expect } from 'vitest';
import { parseW3cTokensJson } from '@/lib/services/themeImport/w3cImporter';
import { tokensToW3cTokens } from '@/lib/services/themeExport/w3cExporter';
import { ThemeTokensSchema } from '@/lib/services/themeTokens';

describe('parseW3cTokensJson', () => {
  it('round-trips GameForge\'s own exported output', () => {
    const original = {
      colorBackground: '#ffffff',
      colorForeground: '#212529',
      colorAccent: '#2c3e50',
      colorBorder: '#dee2e6',
      fontHeading: "'Playfair Display', serif",
      fontBody: 'Arial',
      spaceUnit: '0.5rem',
      radiusBase: '0.375rem',
    };
    const exported = tokensToW3cTokens(original);
    const result = parseW3cTokensJson(exported);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Colors round-trip through rgb()/rgba(), not hex - exact string equality
    // isn't expected, but the resulting value must still be a valid
    // ThemeTokens entry (same boundary this app's own generators validate
    // against) and must represent the same numeric color.
    expect(() => ThemeTokensSchema.parse(result.tokens)).not.toThrow();
    expect(result.tokens.colorBackground).toBe('rgb(255, 255, 255)');
    expect(result.tokens.colorForeground).toBe('rgb(33, 37, 41)');
    expect(result.tokens.fontHeading).toBe("'Playfair Display', serif");
    expect(result.tokens.fontBody).toBe('Arial');
    expect(result.tokens.spaceUnit).toBe('0.5rem');
    expect(result.tokens.radiusBase).toBe('0.375rem');
  });

  it('matches tokens by role-specific aliases regardless of group naming (a "foreign" file shape)', () => {
    // Deliberately NOT using GameForge's own color/font/dimension group
    // names or nesting - this is the actual point of the feature: real
    // external tool exports won't match GameForge's own vocabulary.
    const foreign = {
      colors: {
        primary: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
        surface: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 } },
        text: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 } },
        outline: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.5, 0.5, 0.5], alpha: 1 } },
      },
      typography: {
        display: { $type: 'fontFamily', $value: 'Georgia' },
        base: { $type: 'fontFamily', $value: 'Helvetica' },
      },
      sizing: {
        spacing: { $type: 'dimension', $value: { value: 8, unit: 'px' } },
        'corner-radius': { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      },
    };
    const result = parseW3cTokensJson(JSON.stringify(foreign));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.colorAccent).toBe('rgb(255, 0, 0)');
    expect(result.tokens.colorBackground).toBe('rgb(255, 255, 255)');
    expect(result.tokens.colorForeground).toBe('rgb(0, 0, 0)');
    expect(result.tokens.colorBorder).toBe('rgb(128, 128, 128)');
    expect(result.tokens.fontHeading).toBe('Georgia');
    expect(result.tokens.fontBody).toBe('Helvetica');
    expect(result.tokens.spaceUnit).toBe('8px');
    expect(result.tokens.radiusBase).toBe('4px');
  });

  it('rejects with a clear error listing exactly which roles could not be matched', () => {
    const partial = {
      color: {
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
      },
    };
    const result = parseW3cTokensJson(JSON.stringify(partial));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('colorBackground');
    expect(result.error).toContain('colorForeground');
    expect(result.error).toContain('colorBorder');
    expect(result.error).toContain('fontHeading');
    expect(result.error).toContain('fontBody');
    expect(result.error).toContain('spaceUnit');
    expect(result.error).toContain('radiusBase');
    expect(result.error).not.toContain('colorAccent,');
  });

  it('rejects malformed JSON with a clear error instead of throwing', () => {
    const result = parseW3cTokensJson('not valid json {');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/json/i);
  });

  it('handles an alpha channel other than 1 as rgba()', () => {
    const doc = {
      color: {
        background: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 } },
        foreground: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 } },
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 0.5 } },
        border: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.8, 0.8, 0.8], alpha: 1 } },
      },
      font: {
        heading: { $type: 'fontFamily', $value: 'Georgia' },
        body: { $type: 'fontFamily', $value: 'Helvetica' },
      },
      dimension: {
        'space-unit': { $type: 'dimension', $value: { value: 8, unit: 'px' } },
        'radius-base': { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      },
    };
    const result = parseW3cTokensJson(JSON.stringify(doc));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.colorAccent).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('joins a multi-name font array into a valid CSS font-family list', () => {
    const doc = {
      color: {
        background: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 } },
        foreground: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 } },
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
        border: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.8, 0.8, 0.8], alpha: 1 } },
      },
      font: {
        heading: { $type: 'fontFamily', $value: ['Playfair Display', 'serif'] },
        body: { $type: 'fontFamily', $value: ['Helvetica', 'Arial', 'sans-serif'] },
      },
      dimension: {
        'space-unit': { $type: 'dimension', $value: { value: 8, unit: 'px' } },
        'radius-base': { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      },
    };
    const result = parseW3cTokensJson(JSON.stringify(doc));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.fontHeading).toBe("'Playfair Display', serif");
    expect(result.tokens.fontBody).toBe('Helvetica, Arial, sans-serif');
    expect(() => ThemeTokensSchema.parse(result.tokens)).not.toThrow();
  });
});
