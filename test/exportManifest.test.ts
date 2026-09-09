import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { hashContent, readManifest, writeManifest, type ExportManifest } from '@/lib/services/ExportManifest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-manifest-'));
});

afterEach(async () => {
  if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true });
});

describe('hashContent', () => {
  it('produces the same hash for the same content and a different hash for different content', () => {
    const a = hashContent('hello');
    const b = hashContent('hello');
    const c = hashContent('world');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('writeManifest / readManifest', () => {
  const MANIFEST: ExportManifest = {
    styleId: '11111111-1111-1111-1111-111111111111',
    exportedAt: 1700000000000,
    pages: [
      { id: '22222222-2222-2222-2222-222222222222', name: 'Home', slug: '', componentAssetIds: ['33333333-3333-3333-3333-333333333333'], pageFileHash: hashContent('page content') },
    ],
    components: [
      { assetId: '33333333-3333-3333-3333-333333333333', componentName: 'HeroA3f9c1', contentHash: hashContent('component content') },
    ],
  };

  it('round-trips a manifest through disk', async () => {
    await writeManifest(tempDir, MANIFEST);
    const readBack = await readManifest(tempDir);
    expect(readBack).toEqual(MANIFEST);
  });

  it('returns null when no manifest file exists', async () => {
    const result = await readManifest(tempDir);
    expect(result).toBeNull();
  });

  it('returns null (not a throw) when the manifest file is present but not valid JSON matching the schema', async () => {
    await fsPromises.writeFile(path.join(tempDir, 'gameforge-manifest.json'), 'not valid json {');
    const result = await readManifest(tempDir);
    expect(result).toBeNull();
  });

  it('returns null when the manifest file is valid JSON but the wrong shape', async () => {
    await fsPromises.writeFile(path.join(tempDir, 'gameforge-manifest.json'), JSON.stringify({ hello: 'world' }));
    const result = await readManifest(tempDir);
    expect(result).toBeNull();
  });
});
