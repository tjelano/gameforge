import { describe, it, expect, vi, afterEach } from 'vitest';
import { callClaudeTool, callClaudeMessage } from '@/lib/services/claudeToolCall';
import { ANTHROPIC_PROVIDER, resolveClaudeProvider } from '@/lib/services/claudeApiProviders';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function baseParams(overrides: Partial<Parameters<typeof callClaudeTool>[0]> = {}) {
  return {
    provider: ANTHROPIC_PROVIDER,
    apiKey: 'fake-key',
    toolName: 'emit_theme',
    toolDescription: 'x',
    inputSchema: {},
    messages: [{ role: 'user', content: 'hi' }],
    operationLabel: 'theme generation',
    truncatedMessage: 'the theme could not be generated',
    ...overrides,
  };
}

describe('callClaudeTool retry on transient failures', () => {
  it('retries on 429 twice then succeeds on the 3rd attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 't1', name: 'emit_theme', input: { ok: true } }],
        stop_reason: 'tool_use',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = callClaudeTool(baseParams());
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await pending).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws immediately after exactly one call on a non-retryable 400', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callClaudeTool(baseParams())).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the last response error after exhausting all retries on persistent 429s', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited 1', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited 2', { status: 500 }))
      .mockResolvedValueOnce(new Response('rate limited 3', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = callClaudeTool(baseParams());
    const assertion = expect(pending).rejects.toThrow(/rate limited 3/);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('resolveClaudeProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves Anthropic when THEME_API_PROVIDER is unset and ANTHROPIC_API_KEY is present', () => {
    delete process.env.THEME_API_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key';
    const result = resolveClaudeProvider();
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.provider.name).toBe('anthropic');
      expect(result.apiKey).toBe('fake-anthropic-key');
    }
  });

  it('resolves cheaperinference when THEME_API_PROVIDER is set to it and the key is present', () => {
    process.env.THEME_API_PROVIDER = 'cheaperinference';
    process.env.CHEAPERINFERENCE_API_KEY = 'fake-ci-key';
    const result = resolveClaudeProvider();
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.provider.name).toBe('cheaperinference');
      expect(result.apiKey).toBe('fake-ci-key');
    }
  });

  it('returns an error, not a throw, when no key is configured', () => {
    delete process.env.THEME_API_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    const result = resolveClaudeProvider();
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/isn't configured/);
    }
  });
});

function baseMessageParams(overrides: Partial<Parameters<typeof callClaudeMessage>[0]> = {}) {
  return {
    provider: ANTHROPIC_PROVIDER,
    apiKey: 'fake-key',
    toolName: 'navigate_to_page',
    toolDescription: 'Navigate somewhere.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
    messages: [{ role: 'user', content: 'How do themes work?' }],
    operationLabel: 'copilot message',
    truncatedMessage: 'the reply could not be completed',
    ...overrides,
  };
}

describe('callClaudeMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns text with no toolCall when the model replies with plain text', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Generate a theme from the Themes page.' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callClaudeMessage(baseMessageParams());
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('returns both text and toolCall when the model does both in one turn', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [
        { type: 'text', text: "Here's the Ollama settings page." },
        { type: 'tool_use', id: 't1', name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
      ],
      stop_reason: 'tool_use',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callClaudeMessage(baseMessageParams());
    expect(result).toEqual({
      text: "Here's the Ollama settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
    });
  });

  it('sends tool_choice auto and the system prompt as a top-level field, not a message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await callClaudeMessage(baseMessageParams({ system: 'You are the GameForge copilot.' }));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toBe('You are the GameForge copilot.');
    expect(body.messages).toEqual([{ role: 'user', content: 'How do themes work?' }]);
  });
});
