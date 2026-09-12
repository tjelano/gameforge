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
