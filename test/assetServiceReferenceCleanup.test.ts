// test/assetServiceReferenceCleanup.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-refcleanup-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'references'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

async function writeReferenceFile(filename: string) {
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', filename), 'x');
}

describe('AssetService.cleanupOrphanedReferences', () => {
  it('keeps a reference image belonging to a pending job', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'x',
      options: { referenceImageFilename: 'reference-a.png' },
    });
    await writeReferenceFile('reference-a.png');

    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(0);
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'references', 'reference-a.png'))).resolves.not.toThrow();
  });

  it('removes a reference image belonging to a failed job (matches every other job artifact\'s real existing behavior - failed jobs are never protected)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'x',
      options: { referenceImageFilename: 'reference-b.png' },
    });
    DatabaseConnection.getInstance().prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(job.id);
    await writeReferenceFile('reference-b.png');

    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(1);
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'references', 'reference-b.png'))).rejects.toThrow();
  });

  it('removes a reference image with no matching job at all', async () => {
    await writeReferenceFile('reference-orphan.png');
    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(1);
  });

  it('does not throw when a job row has malformed options JSON (json_extract would otherwise error on invalid JSON)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'x',
    });
    // Simulate a corrupted row directly - jobService.create() always writes
    // valid JSON, so this is the only way to get a malformed value into the
    // column for this test, matching worker.ts's own explicit handling of
    // exactly this case (a job whose options fails JSON.parse).
    DatabaseConnection.getInstance().prepare(`UPDATE jobs SET options = 'not valid json {' WHERE id = ?`).run(job.id);
    await writeReferenceFile('reference-c.png');

    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(1);
  });

  it('removes a file whose protecting job has a non-string referenceImageFilename (valid JSON, wrong type - json_type guard, not just json_valid)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'x',
    });
    // Valid JSON overall, but referenceImageFilename is a number, not a
    // string - json_extract would happily return 123 here, which could
    // never .has()-match a real filename string anyway, but the point is
    // this row must not be treated as protecting reference-d.png.
    DatabaseConnection.getInstance().prepare(`UPDATE jobs SET options = '{"referenceImageFilename": 123}' WHERE id = ?`).run(job.id);
    await writeReferenceFile('reference-d.png');

    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(1);
  });
});
