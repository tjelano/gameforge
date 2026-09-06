import { describe, it, expect } from 'vitest';
import { parseThemeCss, tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';

const SAMPLE_TOKENS: ThemeTokens = {
  colorBackground: '#1a1420',
  colorForeground: '#f0e6d2',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

const OTHER_TOKENS: ThemeTokens = {
  colorBackground: '#ffffff',
  colorForeground: '#212529',
  colorAccent: '#2c3e50',
  colorBorder: '#dee2e6',
  fontHeading: "'Lato', sans-serif",
  fontBody: "'Lato', sans-serif",
  spaceUnit: '0.5rem',
  radiusBase: '0.375rem',
};

describe('parseThemeCss', () => {
  it('round-trips through tokensToCss and recovers the original tokens', () => {
    expect(parseThemeCss(tokensToCss(SAMPLE_TOKENS))).toEqual(SAMPLE_TOKENS);
    expect(parseThemeCss(tokensToCss(OTHER_TOKENS))).toEqual(OTHER_TOKENS);
  });

  it('parses a real theme.css file body directly', () => {
    const css = `:root {
  --color-bg: #0a0a0f;
  --color-fg: #e8e8f5;
  --color-accent: #ff00e6;
  --color-border: #00fff2;
  --font-heading: 'Rajdhani', 'Orbitron', sans-serif;
  --font-body: 'Inter', 'Helvetica Neue', sans-serif;
  --space-unit: 8px;
  --radius-base: 0px;
}
`;
    expect(parseThemeCss(css)).toEqual({
      colorBackground: '#0a0a0f',
      colorForeground: '#e8e8f5',
      colorAccent: '#ff00e6',
      colorBorder: '#00fff2',
      fontHeading: "'Rajdhani', 'Orbitron', sans-serif",
      fontBody: "'Inter', 'Helvetica Neue', sans-serif",
      spaceUnit: '8px',
      radiusBase: '0px',
    });
  });

  it('throws a clear error when a required variable is missing', () => {
    expect(() => parseThemeCss(':root { --color-bg: #fff; }')).toThrow(/--color-fg/);
  });

  it('throws when a value fails ThemeTokensSchema validation', () => {
    const css = tokensToCss(SAMPLE_TOKENS).replace('#1a1420', 'not-a-color');
    expect(() => parseThemeCss(css)).toThrow();
  });
});
