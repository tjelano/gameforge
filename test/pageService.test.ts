// test/pageService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pageservice-'));
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

describe('PageService', () => {
  it('creates a page (empty component list) and reads it back', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Landing Page', createdBy: 'user-1' });
    expect(page.name).toBe('Landing Page');
    expect(JSON.parse(page.component_asset_ids)).toEqual([]);
    expect(page.is_deleted).toBe(0);

    const fetched = await pageService.getById(page.id);
    expect(fetched?.id).toBe(page.id);
  });

  it('getActivePagesForStyle scopes to one style and excludes soft-deleted pages, newest first', async () => {
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });
    const first = await pageService.create({ styleId: styleA.id, name: 'First', createdBy: 'user-1' });
    const second = await pageService.create({ styleId: styleA.id, name: 'Second', createdBy: 'user-1' });
    await pageService.create({ styleId: styleB.id, name: 'Other style', createdBy: 'user-1' });
    await pageService.softDelete(first.id);

    const active = await pageService.getActivePagesForStyle(styleA.id);
    expect(active.map(p => p.id)).toEqual([second.id]);
  });

  it('update() sets name and component_asset_ids, with no ownership check', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Original', createdBy: 'user-1' });
    const updated = await pageService.update(page.id, {
      name: 'Renamed by someone else',
      componentAssetIds: JSON.stringify(['c1', 'c2', 'c3']),
    });
    expect(updated?.name).toBe('Renamed by someone else');
    expect(JSON.parse(updated!.component_asset_ids)).toEqual(['c1', 'c2', 'c3']);
  });

  it('update() with only a name patch leaves component_asset_ids untouched', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify(['c1']) });
    const updated = await pageService.update(page.id, { name: 'Renamed' });
    expect(JSON.parse(updated!.component_asset_ids)).toEqual(['c1']);
  });

  it('update() returns null for a nonexistent page', async () => {
    const result = await pageService.update('00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(result).toBeNull();
  });

  it('softDelete() flips is_deleted to 1', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.softDelete(page.id);
    const fetched = await pageService.getById(page.id);
    expect(fetched?.is_deleted).toBe(1);
  });
});
