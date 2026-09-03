import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;
let imagesDir: string;

const STYLE_ID = '11111111-1111-1111-1111-111111111111';

async function writeImage(name: string) {
  await fsPromises.writeFile(path.join(imagesDir, name), 'fake-png-bytes');
}

function insertAsset(id: string, imagePath: string | null, isDeleted: 0 | 1) {
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'sprite', 'p', ?, 1000, ?)`
  ).run(id, STYLE_ID, imagePath, isDeleted);
}

function insertJob(id: string, resultPath: string | null, status: string) {
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
     VALUES (?, ?, 'user-1', 'sprite', 'p', ?, ?, 1000, 1000, '{}')`
  ).run(id, STYLE_ID, status, resultPath);
}

beforeEach(async () => {
  process.env.IO_WRITE_BATCH_SIZE = '2'; // force multi-chunk batching with a handful of files
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-cleanup-'));
  imagesDir = path.join(tempRoot, 'storage', 'images');

  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(imagesDir, { recursive: true });

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);

  await writeImage('.gitkeep');
});

afterEach(async () => {
  delete process.env.IO_WRITE_BATCH_SIZE;
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('AssetService.cleanupOrphanedImages()', () => {
  it('protects images referenced by an active asset, a soft-deleted asset, and pending/processing/complete jobs, while removing genuine orphans', async () => {
    await writeImage('active-asset.png');
    insertAsset('asset-active', 'active-asset.png', 0);

    await writeImage('deleted-asset.png');
    insertAsset('asset-deleted', 'deleted-asset.png', 1);

    await writeImage('pending-job.png');
    insertJob('job-pending', 'pending-job.png', 'pending');

    await writeImage('processing-job.png');
    insertJob('job-processing', 'processing-job.png', 'processing');

    await writeImage('complete-job.png');
    insertJob('job-complete', 'complete-job.png', 'complete');

    // Genuine orphans: no asset, no in-flight job references them.
    await writeImage('orphan-1.png');
    await writeImage('orphan-2.png');
    await writeImage('orphan-3.png');

    // A promoted job's leftover image with no matching asset row is
    // also a genuine orphan — 'promoted' isn't in the protected set.
    await writeImage('promoted-job.png');
    insertJob('job-promoted', 'promoted-job.png', 'promoted');

    const removed = await assetService.cleanupOrphanedImages();

    expect(removed).toBe(4); // orphan-1, orphan-2, orphan-3, promoted-job

    const remaining = new Set(await fsPromises.readdir(imagesDir));
    expect(remaining).toEqual(new Set([
      '.gitkeep',
      'active-asset.png',
      'deleted-asset.png',
      'pending-job.png',
      'processing-job.png',
      'complete-job.png',
    ]));
  });

  it('never deletes .gitkeep', async () => {
    const removed = await assetService.cleanupOrphanedImages();
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(imagesDir, '.gitkeep'))).toBe(true);
  });

  it('does not log an error, and does not crash the pass, when a file vanishes between listing and delete (ENOENT)', async () => {
    await writeImage('vanishing.png');
    await writeImage('normal-orphan.png');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realUnlink = fsPromises.unlink;
    const unlinkSpy = vi.spyOn(fsPromises, 'unlink').mockImplementation(async (target: any) => {
      if (typeof target === 'string' && target.includes('vanishing.png')) {
        const err: any = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return realUnlink(target);
    });

    const removed = await assetService.cleanupOrphanedImages();

    expect(removed).toBe(1); // only normal-orphan.png actually got deleted by us
    expect(errorSpy).not.toHaveBeenCalled();

    unlinkSpy.mockRestore();
  });
});
