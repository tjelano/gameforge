import { describe, it, expect } from 'vitest';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER } from '@/lib/services/claudeApiProviders';

describe('ANTHROPIC_PROVIDER', () => {
  it('points at the official Anthropic Messages endpoint with an x-api-key header', () => {
    expect(ANTHROPIC_PROVIDER.name).toBe('anthropic');
    expect(ANTHROPIC_PROVIDER.requestUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(ANTHROPIC_PROVIDER.model).toBe('claude-sonnet-5');
    expect(ANTHROPIC_PROVIDER.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(ANTHROPIC_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ 'x-api-key': 'fake-key' });
  });
});

describe('CHEAPERINFERENCE_PROVIDER', () => {
  it('points at cheaperinference.com\'s Anthropic-compatible endpoint with an X-Api-Key header', () => {
    expect(CHEAPERINFERENCE_PROVIDER.name).toBe('cheaperinference');
    expect(CHEAPERINFERENCE_PROVIDER.requestUrl).toBe('https://api.cheaperinference.com/v1/messages');
    expect(CHEAPERINFERENCE_PROVIDER.apiKeyEnvVar).toBe('CHEAPERINFERENCE_API_KEY');
    expect(CHEAPERINFERENCE_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ 'X-Api-Key': 'fake-key' });
  });
});

describe('KIEAI_PROVIDER', () => {
  it('points at kie.ai\'s Claude proxy with an ANTHROPIC_AUTH_TOKEN header', () => {
    expect(KIEAI_PROVIDER.name).toBe('kieai');
    expect(KIEAI_PROVIDER.requestUrl).toBe('https://api.kie.ai/claude/v1/messages');
    expect(KIEAI_PROVIDER.apiKeyEnvVar).toBe('KIEAI_API_KEY');
    expect(KIEAI_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ ANTHROPIC_AUTH_TOKEN: 'fake-key' });
  });
});

describe('every provider', () => {
  it('has a distinct name, requestUrl, and apiKeyEnvVar (no accidental duplication)', () => {
    const providers = [ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER];
    expect(new Set(providers.map(p => p.name)).size).toBe(3);
    expect(new Set(providers.map(p => p.requestUrl)).size).toBe(3);
    expect(new Set(providers.map(p => p.apiKeyEnvVar)).size).toBe(3);
  });
});
