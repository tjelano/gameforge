import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { PixellabGenerator } from '@/lib/services/PixellabGenerator';
import { MockGenerator } from '@/lib/services/ImageGenerator';
import type { PlacedPiece } from '@/lib/utils/pieceShapes';

let tempRoot: string;

const PIECES: PlacedPiece[] = [
  { id: 'a', kind: 'rounded_rect', label: 'Inventory', x: 10, y: 10, w: 80, h: 20 },
];

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-uisheet-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('MockGenerator.generate', () => {
  it('honors requested width/height in options', async () => {
    const gen = new MockGenerator();
    const result = await gen.generate('a goblin sprite', 'style-1', { width: 128, height: 64 });

    expect(result.metadata.width).toBe(128);
    expect(result.metadata.height).toBe(64);
    const filePath = path.join(tempRoot, 'storage', 'images', result.path);
    const bytes = await fsPromises.readFile(filePath);
    // PNG signature is 8 bytes, then IHDR chunk: 4 bytes length + "IHDR" + 13 bytes data + 4 bytes CRC
    // Width is bytes 16-19, height is bytes 20-23 (big-endian)
    const pngWidth = bytes.readUInt32BE(16);
    const pngHeight = bytes.readUInt32BE(20);
    expect(pngWidth).toBe(128);
    expect(pngHeight).toBe(128); // PNG is square, using the max dimension
  });

  it('uses default placeholder size when width/height are omitted', async () => {
    const gen = new MockGenerator();
    const result = await gen.generate('a goblin sprite', 'style-1');

    expect(result.metadata.width).toBe(64);
    expect(result.metadata.height).toBe(64);
    const filePath = path.join(tempRoot, 'storage', 'images', result.path);
    const bytes = await fsPromises.readFile(filePath);
    const pngWidth = bytes.readUInt32BE(16);
    const pngHeight = bytes.readUInt32BE(20);
    expect(pngWidth).toBe(64);
    expect(pngHeight).toBe(64);
  });
});

describe('MockGenerator.generateUiAsset', () => {
  it('writes a placeholder composite sized to the requested image size', async () => {
    const gen = new MockGenerator();
    const result = await gen.generateUiAsset('a fantasy UI kit', PIECES, { width: 296, height: 224 });

    expect(result.metadata.width).toBe(296);
    expect(result.metadata.height).toBe(224);
    const filePath = path.join(tempRoot, 'storage', 'images', result.path);
    const stat = await fsPromises.stat(filePath);
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe('PixellabGenerator.generateUiAsset', () => {
  it('posts to create-ui-asset, polls ui-assets until completed, and saves the downloaded image', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ background_job_id: 'bg-1', ui_asset_id: 'ui-1', status: 'processing' }), { status: 202 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'ui-1', prompt: 'x', size: { width: 296, height: 224 }, status: 'processing', created_at: 'now' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'ui-1', prompt: 'x', size: { width: 296, height: 224 }, status: 'completed', image_url: 'https://cdn.example/sheet.png', created_at: 'now' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const gen = new PixellabGenerator('fake-key');
    const result = await gen.generateUiAsset('a fantasy UI kit', PIECES, { width: 296, height: 224 }, 'brown and gold');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.pixellab.ai/v2/create-ui-asset', expect.objectContaining({ method: 'POST' }));
    const firstCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstCallBody.description).toBe('a fantasy UI kit');
    expect(firstCallBody.color_palette).toBe('brown and gold');
    expect(firstCallBody.pieces).toEqual([{ id: 'a', kind: 'rounded_rect', label: 'Inventory', x: 10, y: 10, w: 80, h: 20, radius: 3 }]);

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.pixellab.ai/v2/ui-assets/ui-1', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://api.pixellab.ai/v2/ui-assets/ui-1', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://cdn.example/sheet.png');

    expect(result.metadata).toEqual({ width: 296, height: 224, format: 'png' });
    const filePath = path.join(tempRoot, 'storage', 'images', result.path);
    const bytes = await fsPromises.readFile(filePath);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('throws if the job reaches status failed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ background_job_id: 'bg-1', ui_asset_id: 'ui-1', status: 'processing' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ui-1', prompt: 'x', size: { width: 256, height: 256 }, status: 'failed', created_at: 'now' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const gen = new PixellabGenerator('fake-key');
    await expect(gen.generateUiAsset('x', PIECES, { width: 256, height: 256 })).rejects.toThrow(/failed/i);
  });

  it('throws if polling never reaches a terminal status before the timeout', async () => {
    // mockImplementation (not mockResolvedValue) so every poll call gets its
    // own fresh, unconsumed Response body — mockResolvedValue would hand back
    // the same instance on every call, and a second .json() on one instance
    // throws "Body is unusable", which raced against the timeout check below.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ background_job_id: 'bg-1', ui_asset_id: 'ui-1', status: 'processing' }), { status: 202 }))
      .mockImplementation(async () =>
        new Response(JSON.stringify({ id: 'ui-1', prompt: 'x', size: { width: 256, height: 256 }, status: 'processing', created_at: 'now' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const gen = new PixellabGenerator('fake-key');
    await expect(
      gen.generateUiAsset('x', PIECES, { width: 256, height: 256 }, undefined, { pollIntervalMs: 1, timeoutMs: 5 })
    ).rejects.toThrow(/timed out/i);
  });
});
