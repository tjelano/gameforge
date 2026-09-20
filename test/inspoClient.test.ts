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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('# DESIGN.md content') });
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
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') }) as any;
    await expect(getDesignMd('missing-site')).rejects.toBeInstanceOf(InspoHttpError);
    await expect(getDesignMd('missing-site-2')).rejects.toMatchObject({ status: 404 });
  });
});
