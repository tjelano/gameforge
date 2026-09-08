// lib/services/ThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER } from '@/lib/services/claudeApiProviders';
import { ThemeTokensSchema, tokensToCss, type ThemeTokens } from '@/lib/services/themeTokens';
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';

// Re-exported so every existing server-side caller of this module keeps
// working unchanged — the pure schema/serialization logic itself now
// lives in themeTokens.ts (see that file for why: a 'use client'
// component needs it without pulling in this file's Node-only imports).
export { ThemeTokensSchema, tokensToCss, parseThemeCss, type ThemeTokens } from '@/lib/services/themeTokens';

export interface GeneratedTheme {
  path: string; // filename only, under storage/themes/
  prompt: string;
}

export interface ThemeGenerator {
  generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string): Promise<GeneratedTheme>;
}

export function buildThemePrompt(styleParameters: string, jobPrompt: string, avoidColors: string[] = [], basedOnContent?: string): string {
  const steering = avoidColors.length > 0
    ? `\n\nAvoid producing a palette close to these existing colors already used by this Style Bible: ${avoidColors.join(', ')}. Aim for a genuinely different combination.`
    : '';
  const basedOnSection = basedOnContent
    ? `\n\nHere is the current version's CSS, to use as your starting point for the requested change:\n${basedOnContent}`
    : '';
  return `You are generating a website design token set (CSS custom properties only — colors, fonts, a base spacing unit, a base border radius). Match this aesthetic:

Style Bible parameters (JSON): ${styleParameters}

Additional direction for this generation: ${jobPrompt}${steering}${basedOnSection}

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
  async generate(prompt: string, _styleId: string, _referenceImage?: ReferenceImagePayload, _basedOnContent?: string): Promise<GeneratedTheme> {
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
    } else {
      throw new Error(`Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic" or "cheaperinference".`);
    }
  }
  return cachedThemeGenerator;
}
