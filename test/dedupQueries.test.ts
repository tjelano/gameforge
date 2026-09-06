import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-dedupqueries-'));
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

describe('assetService.getActiveThemeAssetsForStyle', () => {
  it('returns only active theme assets for the given style, excluding other styles and non-theme assets', async () => {
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });

    const themeA = await assetService.create({ styleId: styleA.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'a.css', outputKind: 'theme' });
    await assetService.create({ styleId: styleA.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'a.png', outputKind: 'image' });
    await assetService.create({ styleId: styleB.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'b.css', outputKind: 'theme' });

    const result = await assetService.getActiveThemeAssetsForStyle(styleA.id);
    expect(result.map(a => a.id)).toEqual([themeA.id]);
  });

  it('excludes soft-deleted theme assets', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const theme = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'x.css', outputKind: 'theme' });
    await assetService.softDelete(theme.id);
    const result = await assetService.getActiveThemeAssetsForStyle(style.id);
    expect(result).toEqual([]);
  });
});

describe('jobService.getByBatchId', () => {
  it('returns only jobs sharing the given batch_id', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    const batchId = '33333333-3333-3333-3333-333333333333';

    const jobInBatch = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    db.prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchId, jobInBatch.id);

    const jobOutsideBatch = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });

    const result = await jobService.getByBatchId(batchId);
    expect(result.map(j => j.id)).toEqual([jobInBatch.id]);
    expect(result.map(j => j.id)).not.toContain(jobOutsideBatch.id);
  });

  it('returns an empty array for a batch_id with no matching jobs', async () => {
    const result = await jobService.getByBatchId('00000000-0000-0000-0000-000000000000');
    expect(result).toEqual([]);
  });
});
