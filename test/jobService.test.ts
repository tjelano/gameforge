import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;
const STYLE_ID = '55555555-5555-5555-5555-555555555555';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobservice-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

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
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('JobService.resetForRetry', () => {
  it('clears result_path and sets status back to pending', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'failed', result_path = 'some-old-file.png' WHERE id = ?`).run(job.id);

    const reset = await jobService.resetForRetry(job.id);
    expect(reset?.status).toBe('pending');
    expect(reset?.result_path).toBeNull();
  });
});

describe('JobService.delete', () => {
  it('removes the row entirely (a hard delete, not a soft-delete)', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' });

    await jobService.delete(job.id);

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT id FROM jobs WHERE id = ?').get(job.id);
    expect(row).toBeUndefined();
    expect(await jobService.getById(job.id)).toBeNull();
  });
});

describe('JobService.getByBatchId', () => {
  it('returns only the jobs sharing that batch id, not sibling jobs from a different batch', async () => {
    const db = DatabaseConnection.getInstance();
    const batchA = '66666666-6666-6666-6666-666666666666';
    const batchB = '77777777-7777-7777-7777-777777777777';

    const jobA1 = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a' });
    const jobA2 = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'b' });
    const jobB1 = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'c' });

    db.prepare('UPDATE jobs SET batch_id = ? WHERE id IN (?, ?)').run(batchA, jobA1.id, jobA2.id);
    db.prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchB, jobB1.id);

    const batchAJobs = await jobService.getByBatchId(batchA);
    expect(batchAJobs.map(j => j.id).sort()).toEqual([jobA1.id, jobA2.id].sort());
    expect(batchAJobs.map(j => j.id)).not.toContain(jobB1.id);
  });
});
