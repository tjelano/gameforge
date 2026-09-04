/**
 * The three vendor-specific differences between otherwise-identical
 * Anthropic-Messages-API-shaped hosts: where to send the request, how
 * to authenticate, and which model name that host expects. Everything
 * else (request body shape, forced tool_choice, response parsing,
 * error handling) lives once in ClaudeApiThemeGenerator and is shared
 * across all three — see that file's own comment for why this is a
 * plain profile object rather than a class per vendor.
 */
export interface ClaudeApiProvider {
  name: 'anthropic' | 'cheaperinference' | 'kieai';
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

export const KIEAI_PROVIDER: ClaudeApiProvider = {
  name: 'kieai',
  // kie.ai's model catalog page did not fetch cleanly during research —
  // this model name matches their own naming for the official Anthropic
  // model, but is UNCONFIRMED against a real key. A wrong value here
  // fails cleanly (a real, diagnosable API error), not silently.
  model: 'claude-sonnet-5',
  requestUrl: 'https://api.kie.ai/claude/v1/messages',
  // kie.ai proxies the real Anthropic Messages API wire format, so this
  // is a normal HTTP Authorization header — NOT the ANTHROPIC_AUTH_TOKEN
  // env var name their docs use to configure the official Claude Code
  // client (that client translates it into this same header internally).
  buildAuthHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
};
