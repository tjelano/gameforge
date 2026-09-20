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
    await pageService.softDelete(first.id, 'user-1');

    const active = await pageService.getActivePagesForStyle(styleA.id);
    expect(active.map(p => p.id)).toEqual([second.id]);
  });

  it('update() sets name and component_asset_ids for the creator', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Original', createdBy: 'user-1' });
    const updated = await pageService.update(page.id, 'user-1', {
      name: 'Renamed',
      componentAssetIds: JSON.stringify(['c1', 'c2', 'c3']),
    });
    if ('error' in updated) throw new Error(`Unexpected error: ${updated.error}`);
    expect(updated.name).toBe('Renamed');
    expect(JSON.parse(updated.component_asset_ids)).toEqual(['c1', 'c2', 'c3']);
  });

  it('update() blocks a non-owner, non-admin requester', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Original', createdBy: 'user-1' });
    const result = await pageService.update(page.id, 'user-2', { name: 'Should fail' });
    expect(result).toEqual({ error: 'FORBIDDEN' });
  });

  it('update() lets an admin edit someone else\'s page', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Original', createdBy: 'user-1' });
    const result = await pageService.update(page.id, 'user-2', { name: 'Renamed by admin' }, true);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.name).toBe('Renamed by admin');
  });

  it('update() with only a name patch leaves component_asset_ids untouched', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify(['c1']) });
    const updated = await pageService.update(page.id, 'user-1', { name: 'Renamed' });
    if ('error' in updated) throw new Error(`Unexpected error: ${updated.error}`);
    expect(JSON.parse(updated.component_asset_ids)).toEqual(['c1']);
  });

  it('update() returns NOT_FOUND for a nonexistent page', async () => {
    const result = await pageService.update('00000000-0000-0000-0000-000000000000', 'user-1', { name: 'x' });
    expect(result).toEqual({ error: 'NOT_FOUND' });
  });

  it('softDelete() flips is_deleted to 1', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.softDelete(page.id, 'user-1');
    const fetched = await pageService.getById(page.id);
    expect(fetched?.is_deleted).toBe(1);
  });

  it('softDelete() blocks a non-owner, non-admin requester', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    const result = await pageService.softDelete(page.id, 'user-2');
    expect(result).toEqual({ error: 'FORBIDDEN' });
    const fetched = await pageService.getById(page.id);
    expect(fetched?.is_deleted).toBe(0);
  });

  describe('findPagesReferencingAsset', () => {
    it('finds a page whose component_asset_ids includes the target', async () => {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const page = await pageService.create({ styleId: style.id, name: 'Landing', createdBy: 'user-1' });
      await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify(['a1', 'a2']) });

      const found = await pageService.findPagesReferencingAsset('a1');
      expect(found.map(p => p.id)).toEqual([page.id]);
    });

    it('excludes a page that references a different asset', async () => {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const page = await pageService.create({ styleId: style.id, name: 'Landing', createdBy: 'user-1' });
      await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify(['a1']) });

      const found = await pageService.findPagesReferencingAsset('a2');
      expect(found).toEqual([]);
    });

    it('excludes a soft-deleted page even if it still references the asset', async () => {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const page = await pageService.create({ styleId: style.id, name: 'Landing', createdBy: 'user-1' });
      await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify(['a1']) });
      await pageService.softDelete(page.id, 'user-1');

      const found = await pageService.findPagesReferencingAsset('a1');
      expect(found).toEqual([]);
    });

    it('finds the target id among several other ids on the same page', async () => {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const page = await pageService.create({ styleId: style.id, name: 'Landing', createdBy: 'user-1' });
      await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify(['a0', 'a1', 'a2']) });

      const found = await pageService.findPagesReferencingAsset('a1');
      expect(found.map(p => p.id)).toEqual([page.id]);
    });

    it('returns multiple matching pages, newest first', async () => {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const pageOlder = await pageService.create({ styleId: style.id, name: 'Older', createdBy: 'user-1' });
      const pageNewer = await pageService.create({ styleId: style.id, name: 'Newer', createdBy: 'user-1' });
      await pageService.update(pageOlder.id, 'user-1', { componentAssetIds: JSON.stringify(['shared']) });
      await pageService.update(pageNewer.id, 'user-1', { componentAssetIds: JSON.stringify(['shared']) });
      // Force distinct, unambiguous timestamps — two pageService.create() calls in the same test
      // can land in the same millisecond, which would make an order assertion flaky rather than
      // actually prove the ORDER BY clause.
      const db = DatabaseConnection.getInstance();
      db.prepare('UPDATE pages SET created_at = ? WHERE id = ?').run(1000, pageOlder.id);
      db.prepare('UPDATE pages SET created_at = ? WHERE id = ?').run(2000, pageNewer.id);

      const found = await pageService.findPagesReferencingAsset('shared');
      expect(found.map(p => p.id)).toEqual([pageNewer.id, pageOlder.id]);
    });

    it('breaks a created_at tie deterministically by id, per the ORDER BY clause', async () => {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const pageA = await pageService.create({ styleId: style.id, name: 'A', createdBy: 'user-1' });
      const pageB = await pageService.create({ styleId: style.id, name: 'B', createdBy: 'user-1' });
      await pageService.update(pageA.id, 'user-1', { componentAssetIds: JSON.stringify(['shared']) });
      await pageService.update(pageB.id, 'user-1', { componentAssetIds: JSON.stringify(['shared']) });
      const db = DatabaseConnection.getInstance();
      const tiedTimestamp = 5000;
      db.prepare('UPDATE pages SET created_at = ? WHERE id = ?').run(tiedTimestamp, pageA.id);
      db.prepare('UPDATE pages SET created_at = ? WHERE id = ?').run(tiedTimestamp, pageB.id);

      const found = await pageService.findPagesReferencingAsset('shared');
      expect(found.map(p => p.id)).toEqual([pageA.id, pageB.id].sort());
    });

    it('returns an empty array when nothing references the asset', async () => {
      const found = await pageService.findPagesReferencingAsset('nonexistent');
      expect(found).toEqual([]);
    });
  });
});
