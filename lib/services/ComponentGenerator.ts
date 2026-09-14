import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { sanitizeComponentHtml, sanitizeComponentCss, assignElementIds } from '@/lib/services/componentSanitize';
import { styleService } from '@/lib/services/StyleService';
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER } from '@/lib/services/claudeApiProviders';
import { callClaudeTool } from '@/lib/services/claudeToolCall';
import { callOllamaTool, type OllamaProviderOverride } from '@/lib/services/ollamaToolCall';
import { combineComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';

// Re-exported so every existing server-side caller of this module keeps
// working unchanged — the pure document assembly/parsing logic itself now
// lives in componentDocument.ts (see that file for why: a 'use client'
// component needs it without pulling in this file's Node-only imports).
export { combineComponentHtml, parseComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';

export interface GeneratedComponent {
  path: string; // filename only, under storage/components/
  prompt: string;
}

export interface PatchedElement {
  html: string; // replacement outerHTML fragment, sanitized
  cssDeclarations: string | null; // raw, UNSANITIZED declaration list (no selector) — the caller is
    // responsible for wrapping these in a real selector and running sanitizeComponentCss on the
    // result before using them; sanitizeComponentCss needs real CSS syntax to parse, which a bare
    // declaration list isn't, so that step can't happen here
}

export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent>;
  patchElement(elementOuterHtml: string, instruction: string, currentDeclarations: string | null, styleId: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<PatchedElement>;
}

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    html: { type: 'string', description: 'The component\'s HTML markup only (no <html>/<head>/<body> wrapper) — just the element(s) that make up this one component.' },
    css: { type: 'string', description: 'CSS rules styling the component, referencing the Style Bible\'s theme variables (var(--color-accent), var(--color-bg), var(--color-fg), var(--color-border), var(--font-heading), var(--font-body), var(--space-unit), var(--radius-base)) rather than hardcoded values. Never use url(...) — no external resource references are supported.' },
  },
  required: ['html', 'css'],
};

const PATCH_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    html: { type: 'string', description: 'The complete replacement outerHTML for this one element — the same tag or a different one, preserving its data-gf-id attribute and any other attributes not relevant to the requested change.' },
    cssDeclarations: {
      type: 'string',
      description: 'CSS declarations only (e.g. "color: blue; font-weight: bold;") — never a selector or rule braces, the caller wraps this itself. Omit entirely if the request does not require a style change. Must be the COMPLETE desired declaration set: this replaces any existing patch declarations for this element wholesale, it does not merge with them — if the element was already patched to be bold and this request only changes color, the response must still include font-weight: bold, not just the color change, or the earlier change is silently lost.',
    },
  },
  required: ['html'],
};

function buildComponentPrompt(styleParameters: string, jobPrompt: string, componentType?: string, basedOnContent?: string): string {
  const typeHint = componentType ? `Component type: ${componentType}.\n\n` : '';
  const basedOnSection = basedOnContent
    ? `\n\nHere is the current version's HTML+CSS, to use as your starting point for the requested change:\n${basedOnContent}`
    : '';
  return `You are generating a single, reusable website UI component as plain HTML and CSS (no React, no JavaScript). ${typeHint}Style Bible parameters (JSON): ${styleParameters}

Description: ${jobPrompt}${basedOnSection}

Respond by calling the emit_component tool with the component's html and css.`;
}

/** Real Claude Messages API implementation — mirrors ClaudeApiThemeGenerator's exact pattern (direct fetch, forced tool_choice, no SDK dependency). */
export class ClaudeApiComponentGenerator implements ComponentGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildComponentPrompt(style?.parameters ?? '{}', prompt, componentType, basedOnContent);

    const content: string | Array<Record<string, unknown>> = referenceImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: referenceImage.mediaType, data: referenceImage.base64 } },
          { type: 'text', text: fullPrompt },
        ]
      : fullPrompt;

    const toolInput = providerOverride
      ? await callOllamaTool({
          host: providerOverride.host,
          model: providerOverride.model,
          toolName: 'emit_component',
          toolDescription: 'Emit a single website UI component as HTML and CSS.',
          inputSchema: TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: providerOverride.correctionRequested
            ? `${fullPrompt}\n\nYou did not call the emit_component tool last time -- you must call it now with valid arguments matching its schema.`
            : content }],
          signal,
          operationLabel: 'component generation',
          truncatedMessage: 'the component could not be generated',
        })
      : await callClaudeTool({
          provider: this.provider,
          apiKey: this.apiKey,
          toolName: 'emit_component',
          toolDescription: 'Emit a single website UI component as HTML and CSS.',
          inputSchema: TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content }],
          signal,
          operationLabel: 'component generation',
          truncatedMessage: 'the component could not be generated',
        });

    const raw = z.object({ html: z.string(), css: z.string() }).parse(toolInput);
    const tokens: ComponentTokens = {
      html: assignElementIds(sanitizeComponentHtml(raw.html)),
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

  async patchElement(
    elementOuterHtml: string,
    instruction: string,
    currentDeclarations: string | null,
    styleId: string,
    signal?: AbortSignal,
    providerOverride?: OllamaProviderOverride,
  ): Promise<PatchedElement> {
    const style = await styleService.getById(styleId);
    const declarationsSection = currentDeclarations
      ? `\n\nIts current effective styling (already includes any prior patch to this element, layered over its base styling):\n${currentDeclarations}`
      : '\n\nIt has no element-specific styling currently applied beyond its base stylesheet rules.';
    const fullPrompt = `You are patching ONE element inside an existing website UI component. Change only what the instruction asks — do not restructure the element beyond what's needed, do not touch anything outside it. Style Bible parameters (JSON): ${style?.parameters ?? '{}'}

The element's current HTML:
${elementOuterHtml}${declarationsSection}

Instruction: ${instruction}

Respond by calling the emit_element_patch tool with the element's complete replacement html and, if a style change is requested, the COMPLETE desired css declaration list (not a diff — see the tool's own description).`;

    const toolInput = providerOverride
      ? await callOllamaTool({
          host: providerOverride.host,
          model: providerOverride.model,
          toolName: 'emit_element_patch',
          toolDescription: 'Emit a patched replacement for one HTML element, and optionally its complete CSS declaration list.',
          inputSchema: PATCH_TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: providerOverride.correctionRequested
            ? `${fullPrompt}\n\nYou did not call the emit_element_patch tool last time -- you must call it now with valid arguments matching its schema.`
            : fullPrompt }],
          signal,
          operationLabel: 'element patch',
          truncatedMessage: 'the element patch could not be generated',
        })
      : await callClaudeTool({
          provider: this.provider,
          apiKey: this.apiKey,
          toolName: 'emit_element_patch',
          toolDescription: 'Emit a patched replacement for one HTML element, and optionally its complete CSS declaration list.',
          inputSchema: PATCH_TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: fullPrompt }],
          signal,
          operationLabel: 'element patch',
          truncatedMessage: 'the element patch could not be generated',
        });

    const raw = z.object({ html: z.string(), cssDeclarations: z.string().optional() }).parse(toolInput);
    return {
      html: sanitizeComponentHtml(raw.html),
      cssDeclarations: raw.cssDeclarations ?? null,
    };
  }
}

export class MockComponentGenerator implements ComponentGenerator {
  async generate(prompt: string, _styleId: string, _componentType?: string, _referenceImage?: ReferenceImagePayload, _basedOnContent?: string, _signal?: AbortSignal, _providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent> {
    if (_providerOverride) {
      throw new Error('Ollama was requested but no real generator is configured (ANTHROPIC_API_KEY unset), so the mock generator is active.');
    }
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

  async patchElement(
    elementOuterHtml: string,
    _instruction: string,
    _currentDeclarations: string | null,
    _styleId: string,
    _signal?: AbortSignal,
    _providerOverride?: OllamaProviderOverride,
  ): Promise<PatchedElement> {
    if (_providerOverride) {
      throw new Error('Ollama was requested but no real generator is configured (ANTHROPIC_API_KEY unset), so the mock generator is active.');
    }
    return { html: elementOuterHtml, cssDeclarations: null };
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
