import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { saveReferenceImage, loadReferenceImage } from '@/lib/services/referenceImage';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-refimg-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('saveReferenceImage / loadReferenceImage', () => {
  it('round-trips a png payload through storage/references/', async () => {
    const original = { base64: Buffer.from('fake-png-bytes').toString('base64'), mediaType: 'image/png' as const };
    const filename = await saveReferenceImage(original);
    expect(filename).toMatch(/^reference-.*\.png$/);

    const filePath = path.join(tempRoot, 'storage', 'references', filename);
    const onDisk = await fsPromises.readFile(filePath);
    expect(onDisk.toString()).toBe('fake-png-bytes');

    const loaded = await loadReferenceImage(filename);
    expect(loaded).toEqual(original);
  });

  it('round-trips a jpeg payload with the correct extension', async () => {
    const original = { base64: Buffer.from('fake-jpeg-bytes').toString('base64'), mediaType: 'image/jpeg' as const };
    const filename = await saveReferenceImage(original);
    expect(filename).toMatch(/\.jpg$/);
    const loaded = await loadReferenceImage(filename);
    expect(loaded?.mediaType).toBe('image/jpeg');
  });

  it('returns null for an undefined filename', async () => {
    expect(await loadReferenceImage(undefined)).toBeNull();
  });

  it('returns null for a missing file instead of throwing', async () => {
    expect(await loadReferenceImage('reference-nonexistent.png')).toBeNull();
  });

  it('returns null and does not read the filesystem for a path-traversal filename', async () => {
    expect(await loadReferenceImage('../../etc/passwd')).toBeNull();
    expect(await loadReferenceImage('sub/dir.png')).toBeNull();
  });
});
