import { describe, it, expect, vi, afterEach } from 'vitest';
import { callClaudeTool } from '@/lib/services/claudeToolCall';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

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
