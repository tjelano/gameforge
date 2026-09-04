// lib/services/ThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { z } from 'zod';
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER } from '@/lib/services/claudeApiProviders';

// Deliberately an allowlist grammar per token type, not a full CSS value
// parser — these values are interpolated directly into a real CSS file
// that renders in a browser (see tokensToCss below), so ".min(1)" alone
// would let a value close the custom-property declaration early and
// inject arbitrary rules (e.g. a url(...) background making a network
// request). Common, real CSS values for each type all still match.
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)|hsla\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*,\s*(0|1|0?\.\d+)\s*\)|[a-zA-Z]{3,20})$/;
const CSS_FONT_RE = /^[a-zA-Z0-9\s,'"-]{1,120}$/;
const CSS_LENGTH_RE = /^\d{1,3}(\.\d+)?(px|rem|em)$/;

export const ThemeTokensSchema = z.object({
  colorBackground: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorForeground: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorAccent: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorBorder: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  fontHeading: z.string().regex(CSS_FONT_RE, 'must be a plain font-family value'),
  fontBody: z.string().regex(CSS_FONT_RE, 'must be a plain font-family value'),
  spaceUnit: z.string().regex(CSS_LENGTH_RE, 'must be a CSS length in px, rem, or em'),
  radiusBase: z.string().regex(CSS_LENGTH_RE, 'must be a CSS length in px, rem, or em'),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

export interface GeneratedTheme {
  path: string; // filename only, under storage/themes/
  prompt: string;
}

export interface ThemeGenerator {
  generate(prompt: string, styleId: string): Promise<GeneratedTheme>;
}

export function tokensToCss(tokens: ThemeTokens): string {
  return `:root {
  --color-bg: ${tokens.colorBackground};
  --color-fg: ${tokens.colorForeground};
  --color-accent: ${tokens.colorAccent};
  --color-border: ${tokens.colorBorder};
  --font-heading: ${tokens.fontHeading};
  --font-body: ${tokens.fontBody};
  --space-unit: ${tokens.spaceUnit};
  --radius-base: ${tokens.radiusBase};
}
`;
}

export function buildThemePrompt(styleParameters: string, jobPrompt: string): string {
  return `You are generating a website design token set (CSS custom properties only — colors, fonts, a base spacing unit, a base border radius). Match this aesthetic:

Style Bible parameters (JSON): ${styleParameters}

Additional direction for this generation: ${jobPrompt}

Respond by calling the emit_theme tool with concrete token values.`;
}

const FIXED_MOCK_TOKENS: ThemeTokens = {
  colorBackground: '#1c1a17',
  colorForeground: '#ede7dc',
  colorAccent: '#e8a33d',
  colorBorder: '#3c352a',
  fontHeading: "'Space Grotesk', sans-serif",
  fontBody: "'Inter', sans-serif",
  spaceUnit: '8px',
  radiusBase: '3px',
};

export class MockThemeGenerator implements ThemeGenerator {
  async generate(prompt: string, _styleId: string): Promise<GeneratedTheme> {
    const filename = `mock-theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`;
    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(FIXED_MOCK_TOKENS));
    } catch (e) {
      console.error(`Failed to write mock theme file ${filename}:`, e);
      throw e;
    }
    return { path: filename, prompt };
  }
}

// Lazy, mock-vs-real singleton — same reasoning as getImageGenerator():
// ESM import hoisting would otherwise evaluate process.env.THEME_API_PROVIDER
// and the various *_API_KEY vars before worker.ts's own env-loading flag has
// landed them in process.env.
let cachedThemeGenerator: ThemeGenerator | undefined;

export function getThemeGenerator(): ThemeGenerator {
  if (!cachedThemeGenerator) {
    const providerName = process.env.THEME_API_PROVIDER;

    if (!providerName || providerName === 'anthropic') {
      cachedThemeGenerator = process.env.ANTHROPIC_API_KEY
        ? new ClaudeApiThemeGenerator(process.env.ANTHROPIC_API_KEY, ANTHROPIC_PROVIDER)
        : new MockThemeGenerator();
    } else if (providerName === 'cheaperinference') {
      const apiKey = process.env.CHEAPERINFERENCE_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "cheaperinference" but CHEAPERINFERENCE_API_KEY is not configured.');
      }
      cachedThemeGenerator = new ClaudeApiThemeGenerator(apiKey, CHEAPERINFERENCE_PROVIDER);
    } else if (providerName === 'kieai') {
      const apiKey = process.env.KIEAI_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "kieai" but KIEAI_API_KEY is not configured.');
      }
      cachedThemeGenerator = new ClaudeApiThemeGenerator(apiKey, KIEAI_PROVIDER);
    } else {
      throw new Error(`Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic", "cheaperinference", or "kieai".`);
    }
  }
  return cachedThemeGenerator;
}
