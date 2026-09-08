// test/gitServicePages.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitpages-'));
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

describe('GitService pages sync', () => {
  it('exportToJson() writes one JSON file per page under data/pages/', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await gitService.exportToJson();
    const filePath = path.join(tempRoot, 'data', 'pages', `page-${page.id}.json`);
    const content = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
    expect(content.name).toBe('Home');
    expect(content.style_id).toBe(style.id);
  });

  it('importFromJson() brings a style + its page into a fresh database without FK-failing', async () => {
    // Pages have a real FK (style_id REFERENCES styles(id)) - this proves
    // importFromJson()'s ordering (styles before pages) actually holds, not
    // just that a page can round-trip in isolation.
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify(['some-asset-id']) });
    await gitService.exportToJson();

    // Simulate a second machine: fresh DB, same exported data/ directory.
    DatabaseConnection.resetForTests();
    await expect(gitService.importFromJson()).resolves.not.toThrow();

    const importedPage = await pageService.getById(page.id);
    expect(importedPage?.name).toBe('Home');
    expect(importedPage?.style_id).toBe(style.id);
    expect(importedPage?.component_asset_ids).toBe(JSON.stringify(['some-asset-id']));

    const importedStyle = await styleService.getById(style.id);
    expect(importedStyle).not.toBeNull();
  });

  it('a soft-deleted page still exports and imports (deletes propagate across machines)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Gone', createdBy: 'user-1' });
    await pageService.softDelete(page.id);
    await gitService.exportToJson();

    DatabaseConnection.resetForTests();
    await gitService.importFromJson();

    const imported = await pageService.getById(page.id);
    expect(imported?.is_deleted).toBe(1);
  });
});
