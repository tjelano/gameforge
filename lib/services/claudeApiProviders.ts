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
