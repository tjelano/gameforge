import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { PixellabGenerator } from '@/lib/services/PixellabGenerator';

let tempRoot: string;

function mockPixfluxResponse() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ image: { type: 'base64', base64: Buffer.from('fake-png').toString('base64'), format: 'png' } }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pixellabrefimg-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('PixellabGenerator with a reference image', () => {
  it('includes init_image and strength in the request body when a reference image is given', async () => {
    const fetchMock = mockPixfluxResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    await generator.generate('a goblin', 'style-1', {
      referenceImage: { base64: 'ZmFrZQ==', mediaType: 'image/png' },
      referenceStrength: 300,
    });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.init_image).toBeDefined();
    expect(sentBody.strength).toBe(300);
  });

  it('omits init_image entirely when no reference image is given (unchanged existing behavior)', async () => {
    const fetchMock = mockPixfluxResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    await generator.generate('a goblin', 'style-1');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.init_image).toBeUndefined();
  });
});
