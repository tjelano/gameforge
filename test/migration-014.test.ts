import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration014-'));
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

describe('migration 014', () => {
  it('adds an edited_externally column to assets, defaulting to 0', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
      VALUES ('22222222-2222-2222-2222-222222222222', 'test style', 'user-1', '{}', 0, 1000, 1000)
    `).run();
    db.prepare(`
      INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
      VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'user-1', 'button', 'a button', 'x.html', 1000, 0, 'component')
    `).run();
    const row = db.prepare('SELECT edited_externally FROM assets WHERE id = ?').get('11111111-1111-1111-1111-111111111111') as any;
    expect(row.edited_externally).toBe(0);
  });
});
