import { describe, it, expect } from 'vitest';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  FONT_OPTIONS,
  DEFAULT_RADIUS,
  isValidHex,
  parseRadiusPx,
  formatRadiusPx,
  normalizeHex,
  serializeTokensToCss,
  type DesignPreviewTokenState,
} from '@/lib/utils/designPreviewTokens';

describe('isValidHex', () => {
  it('accepts a 6-digit hex color', () => {
    expect(isValidHex('#0A0A0A')).toBe(true);
    expect(isValidHex('#8ea885')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidHex('')).toBe(false);
    expect(isValidHex('#12')).toBe(false);
    expect(isValidHex('not-a-color')).toBe(false);
    expect(isValidHex('rgb(10, 10, 10)')).toBe(false);
  });
});

describe('parseRadiusPx', () => {
  it('parses a computed px string into a number', () => {
    expect(parseRadiusPx('7px')).toBe(7);
    expect(parseRadiusPx('12px')).toBe(12);
  });

  it('falls back to the default for an empty or unparseable value', () => {
    expect(parseRadiusPx('')).toBe(DEFAULT_RADIUS);
    expect(parseRadiusPx('not-a-number')).toBe(DEFAULT_RADIUS);
  });
});

describe('formatRadiusPx', () => {
  it('formats a number as a px string', () => {
    expect(formatRadiusPx(12)).toBe('12px');
  });

  it('formats a numeric string as a px string', () => {
    expect(formatRadiusPx('9')).toBe('9px');
  });

  it('falls back to the default for an empty or non-numeric value', () => {
    expect(formatRadiusPx('')).toBe(`${DEFAULT_RADIUS}px`);
    expect(formatRadiusPx('abc')).toBe(`${DEFAULT_RADIUS}px`);
  });
});

describe('normalizeHex', () => {
  it('uppercases a hex color and trims whitespace', () => {
    expect(normalizeHex('#8ea885')).toBe('#8EA885');
    expect(normalizeHex(' #0a0a0a ')).toBe('#0A0A0A');
  });
});

function makeState(overrides: Partial<DesignPreviewTokenState> = {}): DesignPreviewTokenState {
  const base = {} as DesignPreviewTokenState;
  for (const t of COLOR_TOKENS) base[t.key] = '#000000';
  base.radius = '7';
  base.fontDisplay = FONT_OPTIONS[0].value;
  base.fontBody = FONT_OPTIONS[1].value;
  base.fontMono = FONT_OPTIONS[2].value;
  return { ...base, ...overrides };
}

describe('serializeTokensToCss', () => {
  it('emits all 20 tokens in the same order as globals.css\'s own :root block', () => {
    const css = serializeTokensToCss(makeState());
    const varNames = css.split('\n').slice(1, -1).map(line => line.trim().split(':')[0]);
    expect(varNames).toEqual([
      '--bg', '--surface', '--surface-raised', '--border',
      '--ink', '--ink-dim', '--ink-faint',
      '--accent', '--accent-bright', '--accent-dim', '--accent-2', '--accent-ink',
      '--keeper', '--keeper-dim', '--reject', '--reject-dim',
      '--radius', '--font-display', '--font-body', '--font-mono',
    ]);
  });

  it('normalizes hex color casing on output', () => {
    const css = serializeTokensToCss(makeState({ bg: '#abcdef' }));
    expect(css).toContain('--bg: #ABCDEF;');
  });

  it('serializes font tokens as their literal var() chains, not just a label', () => {
    const css = serializeTokensToCss(makeState());
    expect(css).toContain(`--font-display: ${FONT_OPTIONS[0].value};`);
    expect(css).toContain(`--font-body: ${FONT_OPTIONS[1].value};`);
    expect(css).toContain(`--font-mono: ${FONT_OPTIONS[2].value};`);
  });

  it('falls back to the default radius when the state value is empty', () => {
    const css = serializeTokensToCss(makeState({ radius: '' }));
    expect(css).toContain(`--radius: ${DEFAULT_RADIUS}px;`);
  });

  it('has exactly 16 color tokens and 3 font tokens/options', () => {
    expect(COLOR_TOKENS).toHaveLength(16);
    expect(FONT_TOKENS).toHaveLength(3);
    expect(FONT_OPTIONS).toHaveLength(3);
  });
});

describe('token list drift guard', () => {
  it('matches every custom property actually declared in globals.css\'s :root block', async () => {
    const fsPromises = await import('fs/promises');
    const path = await import('path');
    const cssPath = path.resolve(__dirname, '..', 'app', 'globals.css');
    const css = await fsPromises.readFile(cssPath, 'utf-8');
    const rootBlock = css.match(/:root\s*\{([^}]*)\}/);
    if (!rootBlock) throw new Error('Could not find a :root block in app/globals.css');
    const realVarNames = new Set(
      [...rootBlock[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])
    );
    const moduleVarNames = new Set([
      ...COLOR_TOKENS.map(t => t.cssVar),
      '--radius',
      ...FONT_TOKENS.map(t => t.cssVar),
    ]);
    expect(moduleVarNames).toEqual(realVarNames);
  });
});
