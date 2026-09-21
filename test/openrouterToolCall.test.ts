// test/openrouterToolCall.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOpenRouterMessage, callOpenRouterTool } from '@/lib/services/openrouterToolCall';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const baseParams = {
  apiKey: 'sk-or-test-key',
  model: 'deepseek/deepseek-v4-flash',
  toolName: 'navigate_to_page',
  toolDescription: 'Navigate somewhere.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  messages: [{ role: 'system', content: 'You are the GameForge copilot.' }, { role: 'user', content: 'How do themes work?' }],
  operationLabel: 'copilot message',
  truncatedMessage: 'the reply could not be completed',
};

describe('callOpenRouterMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the OpenRouter chat-completions endpoint with the model, auth header, and the one tool', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }));

    await callOpenRouterMessage(baseParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-or-test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek/deepseek-v4-flash');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'navigate_to_page', description: 'Navigate somewhere.', parameters: baseParams.inputSchema } },
    ]);
  });

  it('returns plain text when the model makes no tool call -- the normal case here', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'Generate a theme from the Themes page.' }, finish_reason: 'stop' }],
    }));
    const result = await callOpenRouterMessage(baseParams);
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('returns text and toolCall when the model calls the tool -- arguments always arrive as a JSON string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: "Here's the settings page.",
          tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":"/dashboard/settings/ollama"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const result = await callOpenRouterMessage(baseParams);
    expect(result).toEqual({
      text: "Here's the settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
    });
  });

  it('falls back to the plain text reply when the tool call argument JSON is malformed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          content: 'Generate a theme from the Themes page.',
          tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const result = await callOpenRouterMessage(baseParams);
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('treats a null content alongside a tool call as an empty-string reply, not a crash', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":"/dashboard/themes"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const result = await callOpenRouterMessage(baseParams);
    expect(result).toEqual({
      text: '',
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/themes' } },
    });
  });

  it('throws a specific error on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid model' }, false, 404));
    await expect(callOpenRouterMessage(baseParams)).rejects.toThrow(/copilot message failed \(404\)/);
  });

  it('treats finish_reason "length" as truncation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
    }));
    await expect(callOpenRouterMessage(baseParams)).rejects.toThrow('truncated');
  });
});

const toolParams = {
  apiKey: 'sk-or-test-key',
  model: 'anthropic/claude-sonnet-5',
  toolName: 'emit_theme',
  toolDescription: 'Emit a theme',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  messages: [{ role: 'user', content: 'hello' }],
  operationLabel: 'theme generation',
  truncatedMessage: 'the theme could not be generated',
};

describe('callOpenRouterTool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forces the one tool via tool_choice -- unlike Ollama, OpenRouter supports forcing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"colorBackground":"#000"}' } }] }, finish_reason: 'tool_calls' }],
    }));

    await callOpenRouterTool(toolParams);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'emit_theme' } });
  });

  it('returns the parsed tool call arguments', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"colorBackground":"#111"}' } }] }, finish_reason: 'tool_calls' }],
    }));
    const result = await callOpenRouterTool(toolParams);
    expect(result).toEqual({ colorBackground: '#111' });
  });

  it('hard-fails when the model returns no tool call at all -- forced tool_choice means this is a real error, not an expected case like Ollama', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Sure, here is a theme...' }, finish_reason: 'stop' }],
    }));
    await expect(callOpenRouterTool(toolParams)).rejects.toThrow(/no tool call/);
  });

  it('hard-fails when the tool call arguments are malformed JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"colorBackground":' } }] }, finish_reason: 'tool_calls' }],
    }));
    await expect(callOpenRouterTool(toolParams)).rejects.toThrow(/malformed/);
  });

  it('throws a specific error on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'model not found' }, false, 404));
    await expect(callOpenRouterTool(toolParams)).rejects.toThrow(/theme generation failed \(404\)/);
  });

  it('treats finish_reason "length" as truncation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
    }));
    await expect(callOpenRouterTool(toolParams)).rejects.toThrow('truncated');
  });
});
