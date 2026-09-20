import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidInspoSlug, isValidInspoIdx, getDesignMd, InspoHttpError, resetDesignMdCacheForTests } from '@/lib/services/inspoClient';

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

describe('callMcpTool', () => {
  // The MCP Client/transport are mocked at the module level so these tests
  // exercise callMcpTool's own deadline/reconnect logic, not the real SDK
  // handshake (that's covered by the recorded-fixture contract test in
  // Task 4's test file, run against a real captured response shape).
  it('resolves with the tool result on success', async () => {
    const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }) };
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => mockClient),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: vi.fn(() => ({})),
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
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');

    const callPromise = freshCallMcpTool('search_screens', {}, 1000);
    const assertion = expect(callPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
    vi.useRealTimers();
  });
});
