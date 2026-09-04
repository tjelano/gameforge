// test/assetSafetyOutputKind.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { deleteFileIfSafe, deleteFileIfSafeSync } from '@/lib/services/shared/assetSafety';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetsafety-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('deleteFileIfSafe with outputKind', () => {
  it('deletes an unreferenced theme file from storage/themes/, not storage/images/', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'orphan.css'), ':root {}');
    await deleteFileIfSafe('orphan.css', 'theme');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'themes', 'orphan.css'))).rejects.toThrow();
  });

  it('still deletes an unreferenced image file from storage/images/ (regression)', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'orphan.png'), 'fake-png');
    await deleteFileIfSafe('orphan.png', 'image');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'images', 'orphan.png'))).rejects.toThrow();
  });

  it('does not touch storage/images/ when deleting a theme filename that happens to collide with an image filename there', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'same-name.css'), 'do-not-delete-me');
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'same-name.css'), ':root {}');
    await deleteFileIfSafe('same-name.css', 'theme');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'images', 'same-name.css'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'themes', 'same-name.css'))).rejects.toThrow();
  });
});

describe('deleteFileIfSafeSync with outputKind', () => {
  it('deletes an unreferenced theme file from storage/themes/', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'orphan-sync.css'), ':root {}');
    deleteFileIfSafeSync('orphan-sync.css', 'theme');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'themes', 'orphan-sync.css'))).rejects.toThrow();
  });
});
