import { describe, it, expect } from 'vitest';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER } from '@/lib/services/claudeApiProviders';

describe('ANTHROPIC_PROVIDER', () => {
  it('points at the official Anthropic Messages endpoint with an x-api-key header', () => {
    expect(ANTHROPIC_PROVIDER.name).toBe('anthropic');
    expect(ANTHROPIC_PROVIDER.requestUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(ANTHROPIC_PROVIDER.model).toBe('claude-sonnet-5');
    expect(ANTHROPIC_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ 'x-api-key': 'fake-key' });
  });
});

describe('CHEAPERINFERENCE_PROVIDER', () => {
  it('points at cheaperinference.com\'s Anthropic-compatible endpoint with an X-Api-Key header', () => {
    expect(CHEAPERINFERENCE_PROVIDER.name).toBe('cheaperinference');
    expect(CHEAPERINFERENCE_PROVIDER.requestUrl).toBe('https://api.cheaperinference.com/v1/messages');
    expect(CHEAPERINFERENCE_PROVIDER.model).toBe('claude-sonnet-5');
    expect(CHEAPERINFERENCE_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ 'X-Api-Key': 'fake-key' });
  });
});

describe('KIEAI_PROVIDER', () => {
  it('points at kie.ai\'s Claude proxy with a Bearer Authorization header', () => {
    expect(KIEAI_PROVIDER.name).toBe('kieai');
    expect(KIEAI_PROVIDER.requestUrl).toBe('https://api.kie.ai/claude/v1/messages');
    expect(KIEAI_PROVIDER.model).toBe('claude-sonnet-5');
    expect(KIEAI_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ Authorization: 'Bearer fake-key' });
  });
});

describe('every provider', () => {
  it('has a distinct name and requestUrl (no accidental duplication)', () => {
    const providers = [ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER];
    expect(new Set(providers.map(p => p.name)).size).toBe(3);
    expect(new Set(providers.map(p => p.requestUrl)).size).toBe(3);
  });
});
