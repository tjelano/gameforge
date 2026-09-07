import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { assetService } from '@/lib/services/AssetService';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;
const STYLE_ID = '99999999-9999-9999-9999-999999999999';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themecleanup-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  const themesDir = path.join(tempRoot, 'storage', 'themes');
  await fsPromises.mkdir(themesDir, { recursive: true });
  await fsPromises.writeFile(path.join(themesDir, '.gitkeep'), '');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('AssetService.cleanupOrphanedThemes', () => {
  it('removes a .css file referenced by nothing, keeps .gitkeep', async () => {
    const themesDir = path.join(tempRoot, 'storage', 'themes');
    await fsPromises.writeFile(path.join(themesDir, 'orphan.css'), ':root {}');

    const removed = await assetService.cleanupOrphanedThemes();
    expect(removed).toBe(1);
    await expect(fsPromises.access(path.join(themesDir, 'orphan.css'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(themesDir, '.gitkeep'))).resolves.toBeUndefined();
  });

  it('keeps a .css file referenced by an active asset', async () => {
    const themesDir = path.join(tempRoot, 'storage', 'themes');
    await fsPromises.writeFile(path.join(themesDir, 'keep.css'), ':root {}');
    await assetService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'keep.css', outputKind: 'theme' });

    const removed = await assetService.cleanupOrphanedThemes();
    expect(removed).toBe(0);
    await expect(fsPromises.access(path.join(themesDir, 'keep.css'))).resolves.toBeUndefined();
  });

  it('keeps a .css file referenced by a pending/processing/complete job', async () => {
    const themesDir = path.join(tempRoot, 'storage', 'themes');
    await fsPromises.writeFile(path.join(themesDir, 'inflight.css'), ':root {}');
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES ('job-1', ?, 'user-1', 'theme', 'x', 'complete', 'inflight.css', 1000, 1000, '{}', 'theme')`
    ).run(STYLE_ID);

    const removed = await assetService.cleanupOrphanedThemes();
    expect(removed).toBe(0);
  });
});

describe('cleanupOrphanedComponents', () => {
  it('removes an orphaned component file but keeps one referenced by an active job', async () => {
    const componentsDir = path.join(tempRoot, 'storage', 'components');
    await fsPromises.mkdir(componentsDir, { recursive: true });
    await fsPromises.writeFile(path.join(componentsDir, 'orphan.html'), '<html></html>');
    await fsPromises.writeFile(path.join(componentsDir, 'kept.html'), '<html></html>');

    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'component', prompt: 'x', outputKind: 'component' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'complete', result_path = 'kept.html' WHERE style_id = ?`).run(style.id);

    const removed = await assetService.cleanupOrphanedComponents();

    expect(removed).toBe(1);
    await expect(fsPromises.access(path.join(componentsDir, 'orphan.html'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(componentsDir, 'kept.html'))).resolves.toBeUndefined();
  });
});
