import { describe, it, expect } from 'vitest';
import { oklchToHex, parseOklchTriple } from '@/lib/services/seedThemes/oklch';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

describe('oklchToHex', () => {
  it('converts OKLCH white (L=100%, C=0) to pure white', () => {
    expect(oklchToHex(100, 0, 0)).toBe('#ffffff');
  });

  it('converts OKLCH black (L=0%, C=0) to pure black', () => {
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });

  it('produces a neutral R=G=B gray for any zero-chroma value, regardless of hue', () => {
    const [r1, g1, b1] = hexToRgb(oklchToHex(50, 0, 0));
    expect(r1).toBe(g1);
    expect(g1).toBe(b1);

    const [r2, g2, b2] = hexToRgb(oklchToHex(50, 0, 271));
    expect(r2).toBe(g2);
    expect(g2).toBe(b2);
    // Hue is irrelevant when chroma is 0 — same lightness must produce the same gray.
    expect(r1).toBe(r2);
  });

  it('converts a real DaisyUI OKLCH value (light theme accent) to a plausible cyan-teal hex', () => {
    // L=76.76%, C=0.184, H=183.61 — DaisyUI v4.9.0 light theme's --a (accent).
    // Hand-derived expected value #00d7c0, independently verified against the
    // culori color library. Out-of-gamut clamping (negative linear R) is expected here.
    const hex = oklchToHex(76.76, 0.184, 183.61);
    const [r, g, b] = hexToRgb(hex);
    expect(r).toBe(0); // clamped — out of sRGB gamut on the red channel
    expect(g).toBeGreaterThan(180);
    expect(b).toBeGreaterThan(150);
  });

  it('clamps out-of-gamut linear values instead of producing invalid output', () => {
    // High chroma at a mid lightness routinely goes out of gamut on at least one channel.
    const hex = oklchToHex(50, 0.3, 30);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('parseOklchTriple', () => {
  it('parses a real DaisyUI-format triple string', () => {
    expect(parseOklchTriple('76.76% 0.184 183.61')).toEqual([76.76, 0.184, 183.61]);
  });

  it('parses a triple with extra internal whitespace', () => {
    expect(parseOklchTriple('32.1785%   0.02476  255.701624')).toEqual([32.1785, 0.02476, 255.701624]);
  });

  it('throws on a malformed triple', () => {
    expect(() => parseOklchTriple('not a triple')).toThrow();
  });
});
