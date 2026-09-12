import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { PixellabGenerator } from '@/lib/services/PixellabGenerator';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pixellabgen-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('PixellabGenerator.generate() timeout', () => {
  it('aborts and throws when the request exceeds the internal timeout, even with no caller signal', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);

    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const pending = generator.generate('a goblin', 'style-1');
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe('PixellabGenerator.generate() caller-supplied signal', () => {
  it('combines a caller-supplied signal with the internal timeout, so aborting it aborts the request', async () => {
    const controller = new AbortController();

    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const pending = generator.generate('a goblin', 'style-1', { signal: controller.signal });

    // Assert the signal passed to fetch is not aborted before we abort the controller
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(false);

    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe('PixellabGenerator.generate() response shape validation', () => {
  it('throws a specific error when the response is missing image.base64, not a raw TypeError', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ usage: { type: 'generation' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const error = await generator.generate('a goblin', 'style-1').catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toMatch(/unexpected response shape|image\.base64/i);
  });
});

describe('PixellabGenerator.generate() retry on transient failures', () => {
  it('retries on 429 twice then succeeds on the 3rd attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ image: { type: 'base64', base64: Buffer.from('ok').toString('base64'), format: 'png' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const pending = generator.generate('a goblin', 'style-1');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    const result = await pending;
    expect(result.path).toMatch(/\.png$/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws immediately after exactly one call on a non-retryable 400', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    await expect(generator.generate('a goblin', 'style-1')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the last response error after exhausting all retries on persistent 5xx/429s', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('server exploded 1', { status: 500 }))
      .mockResolvedValueOnce(new Response('server exploded 2', { status: 429 }))
      .mockResolvedValueOnce(new Response('server exploded 3', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const pending = generator.generate('a goblin', 'style-1');
    const assertion = expect(pending).rejects.toThrow(/server exploded 3/);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
