// test/tailwindExporter.test.ts
import { describe, it, expect } from 'vitest';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

const TOKENS: ThemeTokens = {
  colorBackground: '#1a1420',
  colorForeground: '#f0e6d2',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

describe('tokensToTailwindTheme', () => {
  it('produces an @theme block with the verified Tailwind v4 variable names', () => {
    const css = tokensToTailwindTheme(TOKENS);
    expect(css).toBe(`@theme {
  --color-background: #1a1420;
  --color-foreground: #f0e6d2;
  --color-accent: #e8a33d;
  --color-border: #4a3728;
  --font-heading: 'Cinzel', serif;
  --font-body: 'EB Garamond', serif;
  --spacing: 8px;
  --radius-base: 4px;
}
`);
  });
});
