/**
 * The vendor-specific differences between otherwise-identical
 * Anthropic-Messages-API-shaped hosts: where to send the request, how
 * to authenticate, and which model name that host expects. Everything
 * else (request body shape, forced tool_choice, response parsing,
 * error handling) lives once in ClaudeApiThemeGenerator and is shared
 * across both — see that file's own comment for why this is a
 * plain profile object rather than a class per vendor.
 */
export interface ClaudeApiProvider {
  name: 'anthropic' | 'cheaperinference';
  requestUrl: string;
  model: string;
  buildAuthHeaders(apiKey: string): Record<string, string>;
}

export const ANTHROPIC_PROVIDER: ClaudeApiProvider = {
  name: 'anthropic',
  requestUrl: 'https://api.anthropic.com/v1/messages',
  model: 'claude-sonnet-5',
  buildAuthHeaders: (apiKey) => ({ 'x-api-key': apiKey }),
};

export const CHEAPERINFERENCE_PROVIDER: ClaudeApiProvider = {
  name: 'cheaperinference',
  requestUrl: 'https://api.cheaperinference.com/v1/messages',
  model: 'claude-sonnet-5',
  buildAuthHeaders: (apiKey) => ({ 'X-Api-Key': apiKey }),
};

const NOT_CONFIGURED_ERROR = "Claude isn't configured — set ANTHROPIC_API_KEY or CHEAPERINFERENCE_API_KEY, or pick an installed Ollama model instead.";

/**
 * Resolves which Claude-shaped provider + API key to use, from the same
 * THEME_API_PROVIDER env-var switch ThemeGenerator.ts/ComponentGenerator.ts/
 * PageLayoutSuggester.ts each already read -- but exported here, since this
 * is the first caller outside those three generators (the copilot route).
 * Returns an error value rather than throwing or falling back to a mock --
 * the copilot has no mock backend, so a misconfiguration must be reported
 * to the caller, not silently swallowed.
 */
export function resolveClaudeProvider(): { provider: ClaudeApiProvider; apiKey: string } | { error: string } {
  const providerName = process.env.THEME_API_PROVIDER;
  if (!providerName || providerName === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) return { error: NOT_CONFIGURED_ERROR };
    return { provider: ANTHROPIC_PROVIDER, apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (providerName === 'cheaperinference') {
    if (!process.env.CHEAPERINFERENCE_API_KEY) return { error: NOT_CONFIGURED_ERROR };
    return { provider: CHEAPERINFERENCE_PROVIDER, apiKey: process.env.CHEAPERINFERENCE_API_KEY };
  }
  return { error: `Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic" or "cheaperinference".` };
}
