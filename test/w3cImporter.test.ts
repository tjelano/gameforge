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

  it('accepts a plain hex string as a color value, a common real-world format alongside the structured DTCG object shape', () => {
    const doc = {
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        accent: { $type: 'color', $value: '#ff0000' },
        border: { $type: 'color', $value: '#cccccc' },
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
    expect(result.tokens.colorAccent).toBe('#ff0000');
    expect(() => ThemeTokensSchema.parse(result.tokens)).not.toThrow();
  });

  it('falls back past a hex color candidate with a non-standard length (5 or 7 digits), rather than accepting invalid CSS', () => {
    const doc = {
      colorGroupA: {
        accent: { $type: 'color', $value: '#12345' }, // 5 hex digits - not valid CSS
      },
      colorGroupB: {
        accent: { $type: 'color', $value: '#1234567' }, // 7 hex digits - not valid CSS
      },
      colorGroupC: {
        accent: { $type: 'color', $value: '#ff0000' },
      },
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        border: { $type: 'color', $value: '#cccccc' },
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
    expect(result.tokens.colorAccent).toBe('#ff0000');
  });

  it('falls back past a font-family candidate whose name mixes single and double quotes, rather than emitting an unescaped quote', () => {
    const doc = {
      fontGroupA: {
        // Wrapping this in either quote style alone breaks the CSS string -
        // must fail conversion and let the fallback loop try the next
        // candidate below.
        heading: { $type: 'fontFamily', $value: [`Rock'n'Roll "One"`] },
      },
      fontGroupB: {
        heading: { $type: 'fontFamily', $value: [`Rock'n'Roll One`] }, // single quote only - valid once wrapped in double quotes
      },
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        accent: { $type: 'color', $value: '#ff0000' },
        border: { $type: 'color', $value: '#cccccc' },
      },
      font: {
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
    expect(result.tokens.fontHeading).toBe(`"Rock'n'Roll One"`);
    expect(() => ThemeTokensSchema.parse(result.tokens)).not.toThrow();
  });

  it('falls back to a later alias-matching candidate when an earlier one fails to convert', () => {
    // Two tokens both alias to colorAccent's "accent" - the first one in
    // tree order is malformed (a $value with no components), the second
    // is valid. The valid one must still be found, not silently skipped
    // just because it wasn't first.
    const doc = {
      colorGroupA: {
        accent: { $type: 'color', $value: { colorSpace: 'srgb' } }, // malformed - no components
      },
      colorGroupB: {
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
      },
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        border: { $type: 'color', $value: '#cccccc' },
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
    expect(result.tokens.colorAccent).toBe('rgb(255, 0, 0)');
  });

  it('falls back past a color candidate with an out-of-range alpha or non-finite component, rather than getting stuck on it', () => {
    const doc = {
      colorGroupA: {
        // Truthy-shaped but invalid: alpha out of the 0-1 range, and a
        // NaN-producing component. Neither should be treated as "found" -
        // both must fall through to the valid candidate below.
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 5 } },
      },
      colorGroupB: {
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: ['not-a-number', 0, 0], alpha: 1 } },
      },
      colorGroupC: {
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
      },
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        border: { $type: 'color', $value: '#cccccc' },
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
    expect(result.tokens.colorAccent).toBe('rgb(255, 0, 0)');
  });

  it('falls back past a dimension candidate with an unsupported unit, rather than getting stuck on it', () => {
    const doc = {
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        accent: { $type: 'color', $value: '#ff0000' },
        border: { $type: 'color', $value: '#cccccc' },
      },
      font: {
        heading: { $type: 'fontFamily', $value: 'Georgia' },
        body: { $type: 'fontFamily', $value: 'Helvetica' },
      },
      sizeGroupA: {
        spacing: { $type: 'dimension', $value: { value: 50, unit: '%' } }, // unsupported unit
      },
      sizeGroupB: {
        spacing: { $type: 'dimension', $value: { value: 8, unit: 'px' } },
      },
      dimension: {
        'radius-base': { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      },
    };
    const result = parseW3cTokensJson(JSON.stringify(doc));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.spaceUnit).toBe('8px');
  });

  it('falls back past a color candidate whose alpha is null (or another non-number type), rather than coercing it to a false 0', () => {
    const doc = {
      colorGroupA: {
        // null coerces via Number(null) === 0, a finite in-range value -
        // must be rejected explicitly by type, not silently treated as
        // fully-transparent (alpha 0).
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: null } },
      },
      colorGroupB: {
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
      },
      color: {
        background: { $type: 'color', $value: '#ffffff' },
        foreground: { $type: 'color', $value: '#000000' },
        border: { $type: 'color', $value: '#cccccc' },
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
    expect(result.tokens.colorAccent).toBe('rgb(255, 0, 0)');
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

  it('rejects a font value crafted to close the CSS custom-property declaration early, instead of writing it to disk', () => {
    // tokensToCss() interpolates these strings directly into a real CSS
    // file; a naive converter with no schema check would let this value
    // close :root{} early and inject an arbitrary rule. ThemeTokensSchema's
    // CSS_FONT_RE only allows [a-zA-Z0-9\s,'"-], so this must be rejected
    // as a whole import, not silently written.
    const malicious = {
      color: {
        background: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 } },
        foreground: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 } },
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 1 } },
        border: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.8, 0.8, 0.8], alpha: 1 } },
      },
      font: {
        heading: { $type: 'fontFamily', $value: "Arial'; } body { background: url(https://evil.example/steal) } .x { color: red" },
        body: { $type: 'fontFamily', $value: 'Helvetica' },
      },
      dimension: {
        'space-unit': { $type: 'dimension', $value: { value: 8, unit: 'px' } },
        'radius-base': { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      },
    };
    const result = parseW3cTokensJson(JSON.stringify(malicious));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/valid CSS|fontHeading/);
  });

  it('rejects an out-of-range alpha value rather than emitting invalid CSS', () => {
    const doc = {
      color: {
        background: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 } },
        foreground: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 1 } },
        accent: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0], alpha: 5 } }, // out of the valid 0-1 range
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
    expect(result.success).toBe(false);
  });

  it('does not crash on a pathologically deeply-nested (but validly-parsed) JSON document', () => {
    // A ~5,000-level-deep object crashes a naive unbounded-recursion walker
    // with a real RangeError (verified directly) - this must resolve to a
    // clean {success:false}, not throw. Built as a raw string via
    // repetition, not JSON.stringify(deeplyNestedObject) - V8's own
    // JSON.stringify also recurses per object-graph level and hits the
    // exact same stack limit on the *test's* construction step, which
    // would make this test crash regardless of whether collectTokens's
    // own depth guard works. JSON.parse, by contrast, really does handle
    // deep nesting fine (confirmed separately), so parsing this string is
    // a clean test of collectTokens alone.
    const deepJson = '{"nested":'.repeat(5000)
      + '{"$type":"color","$value":{"colorSpace":"srgb","components":[1,0,0],"alpha":1}}'
      + '}'.repeat(5000);
    expect(() => parseW3cTokensJson(deepJson)).not.toThrow();
    const result = parseW3cTokensJson(deepJson);
    expect(result.success).toBe(false);
  });
});
