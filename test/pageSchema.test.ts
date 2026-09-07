// test/pageSchema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { PageSchema } from '@/lib/database/schema';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pageschema-'));
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

describe('pages table + PageSchema', () => {
  it('accepts a full row with an ordered component_asset_ids array', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO pages (id, style_id, name, created_by, component_asset_ids, is_deleted, created_at, updated_at)
      VALUES (?, ?, 'Landing Page', 'user-1', '["c1","c2"]', 0, ?, ?)
    `).run('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', now, now);

    const row = db.prepare('SELECT * FROM pages WHERE id = ?').get('11111111-1111-1111-1111-111111111111');
    const parsed = PageSchema.parse(row);
    expect(JSON.parse(parsed.component_asset_ids)).toEqual(['c1', 'c2']);
  });

  it('defaults component_asset_ids to an empty-array JSON when omitted', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO pages (id, style_id, name, created_by, is_deleted, created_at, updated_at)
      VALUES (?, ?, 'Bare', 'user-1', 0, ?, ?)
    `).run('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', now, now);

    const row = db.prepare('SELECT * FROM pages WHERE id = ?').get('33333333-3333-3333-3333-333333333333');
    const parsed = PageSchema.parse(row);
    expect(JSON.parse(parsed.component_asset_ids)).toEqual([]);
  });
});
