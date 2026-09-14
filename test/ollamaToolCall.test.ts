// test/ollamaToolCall.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOllamaTool, callOllamaMessage, OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

const baseParams = {
  host: 'http://localhost:11434',
  model: 'llama3-groq-tool-use:8b',
  toolName: 'emit_theme',
  toolDescription: 'Emit a theme',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  messages: [{ role: 'user', content: 'hello' }],
  operationLabel: 'theme generation',
  truncatedMessage: 'the theme could not be generated',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('callOllamaTool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the native /api/chat endpoint, non-streaming, with the one tool and num_ctx set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: { colorBackground: '#000' } } }] },
    }));

    await callOllamaTool(baseParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'emit_theme', description: 'Emit a theme', parameters: baseParams.inputSchema } },
    ]);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(8192);
  });

  it('returns the tool call arguments directly when already structured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: { colorBackground: '#111' } } }] },
    }));
    const result = await callOllamaTool(baseParams);
    expect(result).toEqual({ colorBackground: '#111' });
  });

  it('JSON.parses a stringified nested argument', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"order":[1,2,3]}' } }] },
    }));
    const result = await callOllamaTool(baseParams);
    expect(result).toEqual({ order: [1, 2, 3] });
  });

  it('hard-fails with the shared error prefix when a stringified argument is malformed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"order":[1,2' } }] },
    }));
    await expect(callOllamaTool(baseParams)).rejects.toThrow(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX);
  });

  it('hard-fails with the shared error prefix when the model returns no tool call at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { role: 'assistant', content: 'Sure, here is a theme for you...' },
    }));
    await expect(callOllamaTool(baseParams)).rejects.toThrow(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX);
  });

  it('treats prompt_eval_count reaching num_ctx as truncation, not a clean response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: {} } }] },
      prompt_eval_count: 8192,
    }));
    await expect(callOllamaTool(baseParams)).rejects.toThrow('truncated');
  });

  it('throws a specific error on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'model not found' }, false, 404));
    await expect(callOllamaTool(baseParams)).rejects.toThrow(/theme generation failed \(404\)/);
  });

  it('serializes concurrent calls -- the second fetch does not fire until the first resolves', async () => {
    // Both mock behaviors are queued up front, before either call starts --
    // queuing the second one later (e.g. between two `await`s) would race
    // against exactly when the second call's own fetch actually fires.
    let resolveFirst!: (value: Response) => void;
    const successResponse = jsonResponse({ message: { tool_calls: [{ function: { name: 'emit_theme', arguments: {} } }] } });
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve; }));
    fetchMock.mockResolvedValueOnce(successResponse);

    const first = callOllamaTool(baseParams);
    const second = callOllamaTool(baseParams);

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call hasn't fired its fetch yet

    resolveFirst(successResponse);
    await first;
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const baseMessageParams = {
  host: 'http://localhost:11434',
  model: 'llama3-groq-tool-use:8b',
  toolName: 'navigate_to_page',
  toolDescription: 'Navigate somewhere.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  messages: [{ role: 'system', content: 'You are the GameForge copilot.' }, { role: 'user', content: 'How do themes work?' }],
  operationLabel: 'copilot message',
  truncatedMessage: 'the reply could not be completed',
};

describe('callOllamaMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns plain text when the model makes no tool call -- the normal case here', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { role: 'assistant', content: 'Generate a theme from the Themes page.' },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('returns text and toolCall when the model calls the tool', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: {
        role: 'assistant',
        content: "Here's the Ollama settings page.",
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/settings/ollama' } } }],
      },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result).toEqual({
      text: "Here's the Ollama settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
    });
  });

  it('JSON.parses a stringified tool call argument', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":"/dashboard/themes"}' } }],
      },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result.toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/themes' } });
  });

  it('falls back to the plain text reply when a stringified tool call argument is malformed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: {
        content: 'Generate a theme from the Themes page.',
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":' } }],
      },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('still throws on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'model not found' }, false, 404));
    await expect(callOllamaMessage(baseMessageParams)).rejects.toThrow(/copilot message failed \(404\)/);
  });

  it('still treats prompt_eval_count reaching num_ctx as truncation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { content: 'cut off' },
      prompt_eval_count: 8192,
    }));
    await expect(callOllamaMessage(baseMessageParams)).rejects.toThrow('truncated');
  });
});
