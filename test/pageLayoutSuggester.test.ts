// test/pageLayoutSuggester.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClaudeApiPageLayoutSuggester,
  MockPageLayoutSuggester,
  type PageLayoutComponentCandidate,
} from '@/lib/services/PageLayoutSuggester';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

const CANDIDATES: PageLayoutComponentCandidate[] = [
  { id: 'aaaaaaaa-0000-0000-0000-000000000000', assetType: 'navbar', prompt: 'A dark navbar with a logo and links.' },
  { id: 'bbbbbbbb-0000-0000-0000-000000000000', assetType: 'hero', prompt: 'A hero section with a heading and CTA.' },
  { id: 'cccccccc-0000-0000-0000-000000000000', assetType: 'footer', prompt: 'A footer with copyright text.' },
];

function mockFetchOnce(order: unknown) {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{ type: 'tool_use', id: 'tool_1', name: 'emit_page_layout', input: { order } }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockPageLayoutSuggester', () => {
  it('returns every candidate id, in the given order', async () => {
    const suggester = new MockPageLayoutSuggester();
    const result = await suggester.suggest('Home', CANDIDATES);
    expect(result).toEqual(CANDIDATES.map(c => c.id));
  });

  it('returns an empty array for an empty candidate list', async () => {
    const suggester = new MockPageLayoutSuggester();
    const result = await suggester.suggest('Home', []);
    expect(result).toEqual([]);
  });
});

describe('ClaudeApiPageLayoutSuggester', () => {
  it('maps a valid order of indices to the matching component ids', async () => {
    vi.stubGlobal('fetch', mockFetchOnce([1, 2, 0]));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    const result = await suggester.suggest('Home', CANDIDATES);
    expect(result).toEqual([CANDIDATES[1].id, CANDIDATES[2].id, CANDIDATES[0].id]);
  });

  it('returns [] immediately, without calling fetch, when given no candidates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    const result = await suggester.suggest('Home', []);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops out-of-range indices (negative and >= length) rather than crashing or including a wrong id', async () => {
    vi.stubGlobal('fetch', mockFetchOnce([-1, 0, 99, 2]));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    const result = await suggester.suggest('Home', CANDIDATES);
    expect(result).toEqual([CANDIDATES[0].id, CANDIDATES[2].id]);
  });

  it('drops non-integer values (strings, floats, null) from the response, keeping only real indices', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(['1', 1.5, null, 1, true]));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    const result = await suggester.suggest('Home', CANDIDATES);
    // Only the real integer 1 survives - '1' (string), 1.5 (non-integer),
    // null, and true (not a number) must all be rejected rather than
    // coerced, the same class of bug this codebase already fixed once in
    // the W3C tokens importer (see feedback_fallback_converter_contract).
    expect(result).toEqual([CANDIDATES[1].id]);
  });

  it('de-duplicates a repeated index, keeping only its first occurrence', async () => {
    vi.stubGlobal('fetch', mockFetchOnce([0, 1, 0, 2]));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    const result = await suggester.suggest('Home', CANDIDATES);
    expect(result).toEqual([CANDIDATES[0].id, CANDIDATES[1].id, CANDIDATES[2].id]);
  });

  it('throws a clear error when the HTTP response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('server exploded', { status: 500 })));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    await expect(suggester.suggest('Home', CANDIDATES)).rejects.toThrow(/500/);
  });

  it('throws when the response was truncated before completing the tool call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [], stop_reason: 'max_tokens' }), { status: 200 })
    ));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    await expect(suggester.suggest('Home', CANDIDATES)).rejects.toThrow(/max_tokens/);
  });

  it('throws when the response contains no tool_use block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'oops' }], stop_reason: 'end_turn' }), { status: 200 })
    ));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    await expect(suggester.suggest('Home', CANDIDATES)).rejects.toThrow(/tool_use/);
  });

  it('throws a plain Error (not a ZodError) when the tool_use input has no "order" array', async () => {
    // A caller (the suggest-layout route) maps ZodError specifically to a
    // 400 "bad client request" response for ITS OWN input validation - a
    // malformed shape here is an upstream AI-response problem, not a client
    // error, so this must not throw the same exception type or it gets
    // mislabeled.
    vi.stubGlobal('fetch', mockFetchOnce(undefined));
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    const error = await suggester.suggest('Home', CANDIDATES).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.constructor.name).not.toBe('ZodError');
    expect(error.message).toMatch(/order/);
  });

  it('combines a caller-supplied signal with the internal request timeout', async () => {
    const fetchMock = mockFetchOnce([0]);
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    await suggester.suggest('Home', CANDIDATES, controller.signal);

    const sentSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(sentSignal.aborted).toBe(false);
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });
});

describe('getPageLayoutSuggester() provider selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('defaults to MockPageLayoutSuggester when THEME_API_PROVIDER and ANTHROPIC_API_KEY are both unset', async () => {
    const { getPageLayoutSuggester, MockPageLayoutSuggester: Mock } = await import('@/lib/services/PageLayoutSuggester');
    expect(getPageLayoutSuggester()).toBeInstanceOf(Mock);
  });

  it('routes to the official Anthropic endpoint when THEME_API_PROVIDER is unset but ANTHROPIC_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-anthropic-key');
    const fetchMock = mockFetchOnce([0]);
    vi.stubGlobal('fetch', fetchMock);
    const { getPageLayoutSuggester } = await import('@/lib/services/PageLayoutSuggester');
    await getPageLayoutSuggester().suggest('Home', CANDIDATES);
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.anything());
  });

  it('throws a clear error when THEME_API_PROVIDER=cheaperinference but CHEAPERINFERENCE_API_KEY is missing', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'cheaperinference');
    // Explicitly force "missing" rather than relying on ambient absence - see
    // getThemeGeneratorSelection.test.ts's identical note on why.
    vi.stubEnv('CHEAPERINFERENCE_API_KEY', '');
    const { getPageLayoutSuggester } = await import('@/lib/services/PageLayoutSuggester');
    expect(() => getPageLayoutSuggester()).toThrow(/CHEAPERINFERENCE_API_KEY/);
  });
});
