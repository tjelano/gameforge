// lib/services/ClaudeApiThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';
import { callClaudeTool } from '@/lib/services/claudeToolCall';
import { callOllamaTool } from '@/lib/services/ollamaToolCall';
import { callOpenRouterTool, resolveOpenRouterApiKey } from '@/lib/services/openrouterToolCall';
import type { ProviderOverride } from '@/lib/services/providerOverride';
import {
  ThemeTokensSchema,
  tokensToCss,
  buildThemePrompt,
  parseThemeCss,
  type ThemeGenerator,
  type GeneratedTheme,
} from '@/lib/services/ThemeGenerator';

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

  async generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: ProviderOverride): Promise<GeneratedTheme> {
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
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt, avoidColors, basedOnContent);

    const content: string | Array<Record<string, unknown>> = referenceImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: referenceImage.mediaType, data: referenceImage.base64 } },
          { type: 'text', text: fullPrompt },
        ]
      : fullPrompt;

    const correctedContent = providerOverride?.correctionRequested
      ? `${fullPrompt}\n\nYou did not call the emit_theme tool last time -- you must call it now with valid arguments matching its schema.`
      : content;
    const toolInput = providerOverride?.type === 'ollama'
      ? await callOllamaTool({
          host: providerOverride.host,
          model: providerOverride.model,
          toolName: 'emit_theme',
          toolDescription: 'Emit a website design token set matching the requested aesthetic.',
          inputSchema: TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: correctedContent }],
          signal,
          operationLabel: 'theme generation',
          truncatedMessage: 'the theme could not be generated',
        })
      : providerOverride?.type === 'openrouter'
      ? await callOpenRouterTool({
          apiKey: resolveOpenRouterApiKey(),
          model: providerOverride.model,
          toolName: 'emit_theme',
          toolDescription: 'Emit a website design token set matching the requested aesthetic.',
          inputSchema: TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: correctedContent }],
          signal,
          operationLabel: 'theme generation',
          truncatedMessage: 'the theme could not be generated',
        })
      : await callClaudeTool({
          provider: this.provider,
          apiKey: this.apiKey,
          toolName: 'emit_theme',
          toolDescription: 'Emit a website design token set matching the requested aesthetic.',
          inputSchema: TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content }],
          signal,
          operationLabel: 'theme generation',
          truncatedMessage: 'the theme could not be generated',
        });

    const tokens = ThemeTokensSchema.parse(toolInput);
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
