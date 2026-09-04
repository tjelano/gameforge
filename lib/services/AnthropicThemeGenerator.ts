// lib/services/AnthropicThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import {
  ThemeTokensSchema,
  tokensToCss,
  buildThemePrompt,
  type ThemeGenerator,
  type GeneratedTheme,
} from '@/lib/services/ThemeGenerator';

const API_BASE = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';
const REQUEST_TIMEOUT_MS = 60_000;

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    colorBackground: { type: 'string', description: 'Primary page background color as a hex code, e.g. "#1a1420".' },
    colorForeground: { type: 'string', description: 'Primary text color as a hex code, readable against colorBackground.' },
    colorAccent: { type: 'string', description: 'Accent color for buttons, links, highlights, as a hex code.' },
    colorBorder: { type: 'string', description: 'Border/divider color as a hex code.' },
    fontHeading: { type: 'string', description: 'A CSS font-family value for headings, e.g. "\'Cinzel\', serif".' },
    fontBody: { type: 'string', description: 'A CSS font-family value for body text.' },
    spaceUnit: { type: 'string', description: 'Base spacing unit as a CSS length in px, rem, or em, e.g. "8px".' },
    radiusBase: { type: 'string', description: 'Base border-radius as a CSS length in px, rem, or em, e.g. "4px".' },
  },
  required: ['colorBackground', 'colorForeground', 'colorAccent', 'colorBorder', 'fontHeading', 'fontBody', 'spaceUnit', 'radiusBase'],
};

type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

/**
 * Real Anthropic Messages API, called directly via fetch (no
 * @anthropic-ai/sdk dependency — matches PixellabGenerator's own
 * direct-fetch convention). Forces a single tool call so the response
 * is reliably structured, rather than asking for JSON in prose.
 */
export class AnthropicThemeGenerator implements ThemeGenerator {
  constructor(private apiKey: string) {}

  async generate(prompt: string, styleId: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt);

    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        tools: [
          {
            name: 'emit_theme',
            description: 'Emit a website design token set matching the requested aesthetic.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_theme' },
        messages: [{ role: 'user', content: fullPrompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic theme generation failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    if (data.stop_reason === 'max_tokens') {
      throw new Error(
        'Anthropic response was truncated (stop_reason: max_tokens) before completing the tool call — the theme could not be generated.'
      );
    }
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error('Anthropic response contained no tool_use block for emit_theme.');
    }

    const tokens = ThemeTokensSchema.parse(toolUse.input);
    const filename = `theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`;

    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(tokens));
    } catch (e) {
      console.error(`Failed to write theme file ${filename}:`, e);
      throw e;
    }

    return { path: filename, prompt };
  }
}
