import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { styleService } from '@/lib/services/StyleService';
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER } from '@/lib/services/claudeApiProviders';

export interface ComponentTokens {
  html: string;
  css: string;
}

export interface GeneratedComponent {
  path: string; // filename only, under storage/components/
  prompt: string;
}

export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string): Promise<GeneratedComponent>;
}

const STYLE_OPEN = '<style>';
const STYLE_CLOSE = '</style>';
const BODY_OPEN = '<body>';
const BODY_CLOSE = '</body>';

export function combineComponentHtml(tokens: ComponentTokens): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${STYLE_OPEN}
${tokens.css}
${STYLE_CLOSE}
</head>
${BODY_OPEN}
${tokens.html}
${BODY_CLOSE}
</html>
`;
}

export function parseComponentHtml(document: string): ComponentTokens {
  const styleStart = document.indexOf(STYLE_OPEN);
  const styleEnd = document.indexOf(STYLE_CLOSE);
  const bodyStart = document.indexOf(BODY_OPEN);
  const bodyEnd = document.indexOf(BODY_CLOSE);
  if (styleStart === -1 || styleEnd === -1 || bodyStart === -1 || bodyEnd === -1) {
    throw new Error('Component document is missing a <style> or <body> section.');
  }
  return {
    css: document.slice(styleStart + STYLE_OPEN.length, styleEnd).trim(),
    html: document.slice(bodyStart + BODY_OPEN.length, bodyEnd).trim(),
  };
}

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    html: { type: 'string', description: 'The component\'s HTML markup only (no <html>/<head>/<body> wrapper) — just the element(s) that make up this one component.' },
    css: { type: 'string', description: 'CSS rules styling the component, referencing the Style Bible\'s theme variables (var(--color-accent), var(--color-bg), var(--color-fg), var(--color-border), var(--font-heading), var(--font-body), var(--space-unit), var(--radius-base)) rather than hardcoded values. Never use url(...) — no external resource references are supported.' },
  },
  required: ['html', 'css'],
};

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60_000;

function buildComponentPrompt(styleParameters: string, jobPrompt: string, componentType?: string): string {
  const typeHint = componentType ? `Component type: ${componentType}.\n\n` : '';
  return `You are generating a single, reusable website UI component as plain HTML and CSS (no React, no JavaScript). ${typeHint}Style Bible parameters (JSON): ${styleParameters}

Description: ${jobPrompt}

Respond by calling the emit_component tool with the component's html and css.`;
}

/** Real Claude Messages API implementation — mirrors ClaudeApiThemeGenerator's exact pattern (direct fetch, forced tool_choice, no SDK dependency). */
export class ClaudeApiComponentGenerator implements ComponentGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string, componentType?: string): Promise<GeneratedComponent> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildComponentPrompt(style?.parameters ?? '{}', prompt, componentType);

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
            name: 'emit_component',
            description: 'Emit a single website UI component as HTML and CSS.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_component' },
        messages: [{ role: 'user', content: fullPrompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic component generation failed via ${this.provider.name} (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    if (data.stop_reason === 'max_tokens') {
      throw new Error(`Anthropic response (via ${this.provider.name}) was truncated (stop_reason: max_tokens) before completing the tool call — the component could not be generated.`);
    }
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error(`Anthropic response (via ${this.provider.name}) contained no tool_use block for emit_component.`);
    }

    const raw = toolUse.input as ComponentTokens;
    const tokens: ComponentTokens = {
      html: sanitizeComponentHtml(raw.html),
      css: sanitizeComponentCss(raw.css),
    };

    const filename = `component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`;
    const componentsDir = path.join(getProjectRoot(), 'storage', 'components');
    try {
      await fsPromises.mkdir(componentsDir, { recursive: true });
      await fsPromises.writeFile(path.join(componentsDir, filename), combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write component file ${filename}:`, e);
      throw e;
    }

    return { path: filename, prompt };
  }
}

export class MockComponentGenerator implements ComponentGenerator {
  async generate(prompt: string, _styleId: string): Promise<GeneratedComponent> {
    const tokens: ComponentTokens = {
      html: '<button class="btn-primary">Buy now</button>',
      css: '.btn-primary { background: var(--color-accent); color: var(--color-bg); padding: calc(var(--space-unit) * 1.5) calc(var(--space-unit) * 3); border: none; border-radius: var(--radius-base); font-family: var(--font-body); }',
    };
    const filename = `mock-component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`;
    const componentsDir = path.join(getProjectRoot(), 'storage', 'components');
    try {
      await fsPromises.mkdir(componentsDir, { recursive: true });
      await fsPromises.writeFile(path.join(componentsDir, filename), combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write mock component file ${filename}:`, e);
      throw e;
    }
    return { path: filename, prompt };
  }
}

// Lazy, mock-vs-real singleton — same reasoning as getThemeGenerator()/
// getImageGenerator(): ESM import hoisting would otherwise evaluate
// process.env before worker.ts's own env-loading flag has landed values
// in process.env when run as a bare `tsx worker.ts` process.
let cachedComponentGenerator: ComponentGenerator | undefined;

export function getComponentGenerator(): ComponentGenerator {
  if (!cachedComponentGenerator) {
    const providerName = process.env.THEME_API_PROVIDER;
    if (!providerName || providerName === 'anthropic') {
      cachedComponentGenerator = process.env.ANTHROPIC_API_KEY
        ? new ClaudeApiComponentGenerator(process.env.ANTHROPIC_API_KEY, ANTHROPIC_PROVIDER)
        : new MockComponentGenerator();
    } else if (providerName === 'cheaperinference') {
      const apiKey = process.env.CHEAPERINFERENCE_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "cheaperinference" but CHEAPERINFERENCE_API_KEY is not configured.');
      }
      cachedComponentGenerator = new ClaudeApiComponentGenerator(apiKey, CHEAPERINFERENCE_PROVIDER);
    } else {
      throw new Error(`Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic" or "cheaperinference".`);
    }
  }
  return cachedComponentGenerator;
}
