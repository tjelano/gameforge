import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { getRecentActivity } from '@/lib/services/recentActivity';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-recentactivity-'));
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

describe('getRecentActivity', () => {
  it('returns an empty array when there is nothing to show', async () => {
    expect(await getRecentActivity()).toEqual([]);
  });

  it('merges resolved jobs and created styles, newest first', async () => {
    const style = await styleService.create({ name: 'Forest', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE styles SET created_at = ? WHERE id = ?').run(2000, style.id);

    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' });
    db.prepare(`UPDATE jobs SET status = 'promoted', updated_at = ? WHERE id = ?`).run(3000, job.id);

    const result = await getRecentActivity();
    expect(result.map(item => item.kind)).toEqual(['job', 'style']);
    expect(result[0].label).toContain('a goblin');
    expect(result[1].label).toContain('Forest');
  });

  it('caps the merged result at 8 items', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    for (let i = 0; i < 10; i++) {
      const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: `job ${i}` });
      db.prepare(`UPDATE jobs SET status = 'promoted', updated_at = ? WHERE id = ?`).run(1000 + i, job.id);
    }
    const result = await getRecentActivity();
    expect(result).toHaveLength(8);
  });
});
