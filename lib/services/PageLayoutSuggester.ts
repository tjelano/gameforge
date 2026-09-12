// lib/services/PageLayoutSuggester.ts
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER } from '@/lib/services/claudeApiProviders';
import { callClaudeTool } from '@/lib/services/claudeToolCall';

export interface PageLayoutComponentCandidate {
  id: string;
  assetType: string;
  prompt: string;
}

export interface PageLayoutSuggester {
  /** Ordered componentAssetIds to put on a page named `pageName`, chosen from `candidates`. */
  suggest(pageName: string, candidates: PageLayoutComponentCandidate[], signal?: AbortSignal): Promise<string[]>;
}

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    order: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Indices from the numbered component list, in the order they should appear on the page. Omit any component that does not belong on a page with this name.',
    },
  },
  required: ['order'],
};

function buildLayoutPrompt(pageName: string, candidates: PageLayoutComponentCandidate[]): string {
  const list = candidates.map((c, i) => `${i}. [${c.assetType}] ${c.prompt}`).join('\n');
  return `You are choosing which existing UI components belong on a page named "${pageName}", and in what order they should appear (e.g. a navbar first, a footer last).

Available components:
${list}

Respond by calling the emit_page_layout tool with the indices of the components that belong on this page, in display order. Only use components that make sense for a page with this name — omit ones that don't fit.`;
}

/** Real Claude Messages API implementation — mirrors ClaudeApiThemeGenerator's/ClaudeApiComponentGenerator's exact pattern (direct fetch, forced tool_choice, no SDK dependency). */
export class ClaudeApiPageLayoutSuggester implements PageLayoutSuggester {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async suggest(pageName: string, candidates: PageLayoutComponentCandidate[], signal?: AbortSignal): Promise<string[]> {
    if (candidates.length === 0) return [];

    const input = await callClaudeTool({
      provider: this.provider,
      apiKey: this.apiKey,
      toolName: 'emit_page_layout',
      toolDescription: 'Emit the ordered list of component indices that belong on this page.',
      inputSchema: TOOL_INPUT_SCHEMA,
      messages: [{ role: 'user', content: buildLayoutPrompt(pageName, candidates) }],
      maxTokens: 1024,
      signal,
      operationLabel: 'page layout suggestion',
      truncatedMessage: 'the layout could not be suggested',
    });

    // A malformed top-level shape here is an upstream AI-response problem,
    // not caller input - thrown as a plain Error (not ZodError) so the
    // route's ZodError-means-400 mapping (for its own request-body
    // validation) doesn't mislabel this as a client error. Each array
    // entry is then validated and filtered individually below rather than
    // rejecting the whole response on the first bad value, so one
    // hallucinated/out-of-range index doesn't discard an otherwise-usable
    // suggestion - same reasoning as the W3C tokens importer's
    // candidate-fallback fix (see feedback_fallback_converter_contract
    // memory).
    if (!input || typeof input !== 'object' || !Array.isArray((input as { order?: unknown }).order)) {
      throw new Error(`Anthropic response (via ${this.provider.name}) for emit_page_layout did not include an "order" array.`);
    }
    const seen = new Set<number>();
    const validIndices: number[] = [];
    for (const value of (input as { order: unknown[] }).order) {
      if (typeof value !== 'number' || !Number.isInteger(value)) continue;
      if (value < 0 || value >= candidates.length) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      validIndices.push(value);
    }
    return validIndices.map(i => candidates[i].id);
  }
}

/** No API key configured — deterministic placeholder so local dev/tests without a key still work, same role as MockThemeGenerator/MockComponentGenerator. */
export class MockPageLayoutSuggester implements PageLayoutSuggester {
  async suggest(_pageName: string, candidates: PageLayoutComponentCandidate[]): Promise<string[]> {
    return candidates.map(c => c.id);
  }
}

// Lazy, mock-vs-real singleton — same reasoning as getThemeGenerator()/
// getComponentGenerator(): ESM import hoisting would otherwise evaluate
// process.env before worker.ts's own env-loading flag has landed values in
// process.env when run as a bare `tsx worker.ts` process. Reuses
// THEME_API_PROVIDER rather than introducing a new env var, matching
// getComponentGenerator()'s own precedent of sharing that same setting.
let cachedPageLayoutSuggester: PageLayoutSuggester | undefined;

export function getPageLayoutSuggester(): PageLayoutSuggester {
  if (!cachedPageLayoutSuggester) {
    const providerName = process.env.THEME_API_PROVIDER;
    if (!providerName || providerName === 'anthropic') {
      cachedPageLayoutSuggester = process.env.ANTHROPIC_API_KEY
        ? new ClaudeApiPageLayoutSuggester(process.env.ANTHROPIC_API_KEY, ANTHROPIC_PROVIDER)
        : new MockPageLayoutSuggester();
    } else if (providerName === 'cheaperinference') {
      const apiKey = process.env.CHEAPERINFERENCE_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "cheaperinference" but CHEAPERINFERENCE_API_KEY is not configured.');
      }
      cachedPageLayoutSuggester = new ClaudeApiPageLayoutSuggester(apiKey, CHEAPERINFERENCE_PROVIDER);
    } else {
      throw new Error(`Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic" or "cheaperinference".`);
    }
  }
  return cachedPageLayoutSuggester;
}
