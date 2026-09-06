import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration009-'));
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

describe('migration 009: batch_id on jobs', () => {
  it('adds a nullable batch_id column, defaulting to NULL for existing rows', () => {
    const db = DatabaseConnection.getInstance();
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as { name: string; notnull: number }[];
    const batchIdCol = columns.find(c => c.name === 'batch_id');
    expect(batchIdCol).toBeDefined();
    expect(batchIdCol!.notnull).toBe(0);
  });

  it('lets a job be inserted with a real batch_id and with NULL', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'x', 'user-1', '{}', 0, 1000, 1000)
    `).run();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'user-1', 'theme', 'x', 'pending', NULL, 1000, 1000, '{}', 'theme', '33333333-3333-3333-3333-333333333333')
    `).run();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
      VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'user-1', 'theme', 'x', 'pending', NULL, 1000, 1000, '{}', 'theme', NULL)
    `).run();
    const rows = db.prepare('SELECT id, batch_id FROM jobs ORDER BY id').all() as { id: string; batch_id: string | null }[];
    expect(rows).toEqual([
      { id: '22222222-2222-2222-2222-222222222222', batch_id: '33333333-3333-3333-3333-333333333333' },
      { id: '44444444-4444-4444-4444-444444444444', batch_id: null },
    ]);
  });
});
