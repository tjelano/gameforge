// lib/services/ClaudeApiThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import {
  ThemeTokensSchema,
  tokensToCss,
  buildThemePrompt,
  parseThemeCss,
  type ThemeGenerator,
  type GeneratedTheme,
} from '@/lib/services/ThemeGenerator';

const ANTHROPIC_VERSION = '2023-06-01';
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
    spaceUnit: { type: 'string', description: 'Base spacing unit as a CSS length in px or rem, e.g. "8px".' },
    radiusBase: { type: 'string', description: 'Base border-radius as a CSS length in px or rem, e.g. "4px".' },
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
 * Real Claude Messages API, called directly via fetch (no
 * @anthropic-ai/sdk dependency — matches PixellabGenerator's own
 * direct-fetch convention). Forces a single tool call so the response
 * is reliably structured, rather than asking for JSON in prose.
 *
 * Parameterized by a ClaudeApiProvider profile (see
 * lib/services/claudeApiProviders.ts) rather than hardcoding Anthropic's
 * own host — cheaperinference.com proxies the same underlying Messages
 * API shape, so everything below this line (request body, forced
 * tool_choice, response parsing, ThemeTokensSchema validation, CSS
 * writing, error diagnosis) is genuinely shared across both, not just
 * the official API.
 */
export class ClaudeApiThemeGenerator implements ThemeGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    let existingThemes: Awaited<ReturnType<typeof assetService.getActiveThemeAssetsForStyle>> = [];
    try {
      existingThemes = await assetService.getActiveThemeAssetsForStyle(styleId);
    } catch (e) {
      // A DB-level failure here (e.g. a malformed asset row failing Zod
      // validation) shouldn't block generation either — steering is
      // best-effort, same reasoning as the per-file read/parse loop below.
      console.error(`Failed to load existing theme assets for style ${styleId}, generating without dedup steering:`, e);
    }
    const avoidColors: string[] = [];
    for (const asset of existingThemes.slice(0, 10)) {
      if (!asset.image_path) continue;
      // Same guard as app/api/jobs/[id]/similarity/route.ts's readThemeTokens
      // and app/api/assets/[id]/contrast|export/route.ts — image_path comes
      // from the database, never user-typed paths, but is defense-in-depth
      // against a corrupted/hostile git-synced import setting it to something
      // unexpected.
      if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
        continue;
      }
      try {
        const css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', asset.image_path), 'utf-8');
        const tokens = parseThemeCss(css);
        // Skip any color that's already part of this style's own declared
        // aesthetic (style.parameters) — for a seed-imported Style Bible,
        // parameters IS that theme's own token JSON, so its promoted asset's
        // colors and its own "match this aesthetic" colors are the same
        // values. Telling the model to both match and avoid the same color
        // is contradictory steering, not useful dedup pressure.
        for (const color of [tokens.colorBackground, tokens.colorAccent]) {
          if (!style?.parameters?.includes(color)) {
            avoidColors.push(color);
          }
        }
      } catch {
        // A single unreadable/unparseable existing theme shouldn't block generation — steering is best-effort.
      }
    }
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt, avoidColors);

    const res = await fetch(this.provider.requestUrl, {
      method: 'POST',
      headers: {
        ...this.provider.buildAuthHeaders(this.apiKey),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.provider.model,
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
      throw new Error(`Anthropic theme generation failed via ${this.provider.name} (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    if (data.stop_reason === 'max_tokens') {
      throw new Error(
        `Anthropic response (via ${this.provider.name}) was truncated (stop_reason: max_tokens) before completing the tool call — the theme could not be generated.`
      );
    }
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error(`Anthropic response (via ${this.provider.name}) contained no tool_use block for emit_theme.`);
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
