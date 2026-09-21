import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidInspoSlug, isValidInspoIdx, getDesignMd, InspoHttpError, resetDesignMdCacheForTests, deriveThumbnailUrl } from '@/lib/services/inspoClient';

describe('deriveThumbnailUrl', () => {
  // Real live-verified shape (see app/api/inspo/search/route.ts's ground-truth
  // fixture): a template with an explanatory tail, not a bare URL.
  const REAL_TEMPLATE =
    'https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/<slug>/hero.1440.webp (also full.1440, thumb.384, mobile.384; get_screen returns exact URLs)';

  it('builds the thumb.384.webp URL for a valid template + slug', () => {
    const url = deriveThumbnailUrl(REAL_TEMPLATE, 'ecologi-com');
    expect(url).toBe('https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/ecologi-com/thumb.384.webp');
    // Confirm it actually parses as a well-formed URL, not just a matching string.
    expect(() => new URL(url as string)).not.toThrow();
  });

  it('returns null when the template has no /captures/ segment', () => {
    expect(deriveThumbnailUrl('https://example.com/nope/<slug>/hero.webp', 'ecologi-com')).toBeNull();
    expect(deriveThumbnailUrl('not a url at all', 'ecologi-com')).toBeNull();
  });

  it('returns null for a non-string template', () => {
    expect(deriveThumbnailUrl(undefined, 'ecologi-com')).toBeNull();
    expect(deriveThumbnailUrl(null, 'ecologi-com')).toBeNull();
    expect(deriveThumbnailUrl(123, 'ecologi-com')).toBeNull();
    expect(deriveThumbnailUrl({ url: REAL_TEMPLATE }, 'ecologi-com')).toBeNull();
  });

  it('returns null for a missing/empty slug', () => {
    expect(deriveThumbnailUrl(REAL_TEMPLATE, '')).toBeNull();
  });
});

describe('isValidInspoSlug', () => {
  it('accepts a plain lowercase-alnum-hyphen slug', () => {
    expect(isValidInspoSlug('acme-corp-homepage')).toBe(true);
    expect(isValidInspoSlug('a1')).toBe(true);
  });

  it('rejects traversal and injection shapes', () => {
    expect(isValidInspoSlug('../etc/passwd')).toBe(false);
    expect(isValidInspoSlug('foo%2fbar')).toBe(false);
    expect(isValidInspoSlug('foo/bar')).toBe(false);
    expect(isValidInspoSlug('foo?bar=1')).toBe(false);
    expect(isValidInspoSlug('Foo-Bar')).toBe(false); // uppercase rejected
    expect(isValidInspoSlug('')).toBe(false);
    expect(isValidInspoSlug('-leading-hyphen')).toBe(false);
    expect(isValidInspoSlug('a'.repeat(65))).toBe(false); // over length cap
  });
});

describe('isValidInspoIdx', () => {
  it('accepts a non-negative integer under the find_components limit', () => {
    expect(isValidInspoIdx(0)).toBe(true);
    expect(isValidInspoIdx(39)).toBe(true);
  });

  it('rejects negative, non-integer, or out-of-bound values', () => {
    expect(isValidInspoIdx(-1)).toBe(false);
    expect(isValidInspoIdx(40)).toBe(false); // the hard cap itself is out of range
    expect(isValidInspoIdx(1.5)).toBe(false);
    expect(isValidInspoIdx(NaN)).toBe(false);
  });
});

describe('getDesignMd', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    resetDesignMdCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fetches DESIGN.md for a valid slug and caches the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '19' }),
      body: null,
      text: () => Promise.resolve('# DESIGN.md content'),
    });
    global.fetch = fetchMock as any;

    const first = await getDesignMd('acme-corp');
    const second = await getDesignMd('acme-corp');

    expect(first).toBe('# DESIGN.md content');
    expect(second).toBe('# DESIGN.md content');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
    expect(fetchMock).toHaveBeenCalledWith('https://inspo.test/api/design/acme-corp', expect.any(Object));
  });

  it('rejects an invalid slug before ever calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    await expect(getDesignMd('../etc/passwd')).rejects.toThrow(/invalid slug/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws InspoHttpError with the status on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      body: null,
      text: () => Promise.resolve('not found'),
    }) as any;
    await expect(getDesignMd('missing-site')).rejects.toBeInstanceOf(InspoHttpError);
    await expect(getDesignMd('missing-site-2')).rejects.toMatchObject({ status: 404 });
  });
});

// Matches the shape of the real @modelcontextprotocol/sdk StreamableHTTPError
// (see node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts:
// `class StreamableHTTPError extends Error { readonly code: number | undefined; }`).
// inspoClient.ts imports this named export directly, so every mock of the
// streamableHttp module below must provide it too — Vitest's mock proxy
// throws on accessing an export the mock factory didn't return, even via a
// harmless `typeof` check.
class FakeStreamableHTTPError extends Error {
  code: number | undefined;
  constructor(code: number | undefined, message?: string) {
    super(message);
    this.code = code;
  }
}

describe('callMcpTool', () => {
  // The MCP Client/transport are mocked at the module level so these tests
  // exercise callMcpTool's own deadline/reconnect logic, not the real SDK
  // handshake (that's covered by the recorded-fixture contract test in
  // Task 4's test file, run against a real captured response shape).
  //
  // Unconditional cleanup regardless of assertion outcome: `vi.doMock`
  // registers a mock that outlives `vi.resetModules()` (that only clears the
  // module cache, not the mocks registry), and `vi.useFakeTimers()` in the
  // deadline test only reached its own `vi.useRealTimers()` on the happy
  // path — a failed assertion there would otherwise leak fake timers and
  // stale SDK mocks into every later test in this file.
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/client/streamableHttp.js');
    vi.resetModules();
  });

  it('resolves with the tool result on success', async () => {
    const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }) };
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => mockClient),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: vi.fn(() => ({})),
      StreamableHTTPError: FakeStreamableHTTPError,
    }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');
    mockClient.callTool.mockClear();
    (mockClient as any).connect = vi.fn().mockResolvedValue(undefined);

    const result = await freshCallMcpTool<{ ok: boolean }>('search_screens', { query: 'test' }, 3000);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when the call exceeds its deadline', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise(() => {});
    const mockClient = { callTool: vi.fn().mockReturnValue(neverResolves), connect: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn(() => mockClient) }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})), StreamableHTTPError: FakeStreamableHTTPError }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');

    const callPromise = freshCallMcpTool('search_screens', {}, 1000);
    const assertion = expect(callPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  });

  it('aborts the underlying request (via AbortSignal) when the deadline fires, instead of just abandoning it', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise(() => {});
    const mockClient = { callTool: vi.fn().mockReturnValue(neverResolves), connect: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn(() => mockClient) }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})), StreamableHTTPError: FakeStreamableHTTPError }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');

    const callPromise = freshCallMcpTool('search_screens', {}, 1000);
    const assertion = expect(callPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;

    expect(mockClient.callTool).toHaveBeenCalledTimes(1);
    const [, , options] = mockClient.callTool.mock.calls[0];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(true); // the in-flight request was actually cancelled, not just abandoned
  });

  it('reconnects once and retries after a session-invalid error, then succeeds', async () => {
    const sessionError = new FakeStreamableHTTPError(404, 'Session invalid or expired');
    const firstClient = {
      callTool: vi.fn().mockRejectedValue(sessionError),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondClient = {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const remainingClients = [firstClient, secondClient];
    const ClientMock = vi.fn(() => remainingClients.shift());
    const TransportMock = vi.fn(() => ({}));
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: ClientMock }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: TransportMock, StreamableHTTPError: FakeStreamableHTTPError }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');

    const result = await freshCallMcpTool<{ ok: boolean }>('search_screens', {}, 3000);

    expect(result).toEqual({ ok: true });
    expect(ClientMock).toHaveBeenCalledTimes(2); // reconnect actually constructed a fresh Client
    expect(TransportMock).toHaveBeenCalledTimes(2); // ...and a fresh transport
    expect(firstClient.callTool).toHaveBeenCalledTimes(1);
    expect(secondClient.callTool).toHaveBeenCalledTimes(1);
    expect(firstClient.close).toHaveBeenCalledTimes(1); // superseded client is closed, not leaked
  });

  it('does not loop when the post-reconnect retry also fails with a session-invalid error', async () => {
    const firstError = new FakeStreamableHTTPError(404, 'Session invalid or expired');
    const secondError = new Error('Session invalid or expired (again)');
    const firstClient = {
      callTool: vi.fn().mockRejectedValue(firstError),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondClient = {
      callTool: vi.fn().mockRejectedValue(secondError),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const remainingClients = [firstClient, secondClient];
    const ClientMock = vi.fn(() => remainingClients.shift());
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: ClientMock }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})), StreamableHTTPError: FakeStreamableHTTPError }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');

    await expect(freshCallMcpTool('search_screens', {}, 3000)).rejects.toThrow(/session invalid or expired \(again\)/i);

    expect(ClientMock).toHaveBeenCalledTimes(2); // exactly one reconnect attempt, not an infinite loop
    expect(firstClient.callTool).toHaveBeenCalledTimes(1);
    expect(secondClient.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('INSPO_TYPE_FOR_COMPONENT_TYPE', () => {
  it('maps every real GameForge component type, including the loose ones', async () => {
    const { INSPO_TYPE_FOR_COMPONENT_TYPE } = await import('@/lib/services/inspoClient');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Button).toBe('cta');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE['Nav Bar']).toBe('nav');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Card).toBe('features');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Form).toBe('cta');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Other).toBeNull();
  });
});

describe('findComponents', () => {
  it('passes through imageUrl unchanged and always reports fallback:false (the real API gives no fallback signal)', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{
            type: 'text',
            text: JSON.stringify({
              components: [{
                imageUrl: 'https://inspomcp.dev/api/component/alloy-com/3',
                siteSlug: 'alloy-com', siteTitle: 'Alloy', siteHost: 'alloy.com',
                width: 1280, height: 195, label: 'whatever', palette: [], mode: 'light',
              }],
            }),
          }],
        }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results).toEqual([{ imageUrl: 'https://inspomcp.dev/api/component/alloy-com/3', fallback: false }]);
  });

  it('drops a result whose imageUrl is missing/malformed', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{
            type: 'text',
            text: JSON.stringify({
              components: [
                { siteSlug: 'no-image', siteTitle: 'whatever', siteHost: 'whatever', width: 100, height: 100, label: 'whatever', palette: [], mode: 'light' },
                { imageUrl: 'https://inspomcp.dev/api/component/acme-corp/0', siteSlug: 'acme-corp', siteTitle: 'whatever', siteHost: 'whatever', width: 100, height: 100, label: 'whatever', palette: [], mode: 'light' },
              ],
            }),
          }],
        }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results).toHaveLength(1);
    expect(results[0].imageUrl).toContain('acme-corp');
    expect(results[0].fallback).toBe(false);
  });

  it('returns [] instead of throwing when components is not an array', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ components: 'not-an-array' }) }],
        }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results).toEqual([]);
  });

  it('returns [] instead of throwing when components is missing entirely', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({}) }],
        }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results).toEqual([]);
  });
});
