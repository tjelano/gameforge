import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobrecentlyresolved-'));
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

async function makeJobWithStatus(styleId: string, status: string, updatedAt: number) {
  const job = await jobService.create({ styleId, createdBy: 'user-1', assetType: 'sprite', prompt: `a ${status} job` });
  const db = DatabaseConnection.getInstance();
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, job.id);
  return job.id;
}

describe('JobService.getRecentlyResolved', () => {
  it('returns only promoted/discarded/failed jobs, not pending/processing/complete', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const promotedId = await makeJobWithStatus(style.id, 'promoted', 3000);
    await makeJobWithStatus(style.id, 'pending', 4000);
    await makeJobWithStatus(style.id, 'processing', 5000);
    await makeJobWithStatus(style.id, 'complete', 6000);

    const result = await jobService.getRecentlyResolved(10);
    expect(result.map(j => j.id)).toEqual([promotedId]);
  });

  it('orders newest updated_at first', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const older = await makeJobWithStatus(style.id, 'failed', 1000);
    const newer = await makeJobWithStatus(style.id, 'discarded', 2000);

    const result = await jobService.getRecentlyResolved(10);
    expect(result.map(j => j.id)).toEqual([newer, older]);
  });

  it('respects the limit', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await makeJobWithStatus(style.id, 'promoted', 1000);
    await makeJobWithStatus(style.id, 'promoted', 2000);
    await makeJobWithStatus(style.id, 'promoted', 3000);

    const result = await jobService.getRecentlyResolved(2);
    expect(result).toHaveLength(2);
  });
});
