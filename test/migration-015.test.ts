import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration015-'));
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

describe('migration 015', () => {
  it('adds a nullable error_message column to jobs', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
      VALUES ('33333333-3333-3333-3333-333333333333', 'test style', 'user-1', '{}', 0, 1000, 1000)
    `).run();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
      VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'user-1', 'sprite', 'a goblin', 'pending', NULL, 1000, 1000, '{}')
    `).run();
    const row = db.prepare('SELECT error_message FROM jobs WHERE id = ?').get('44444444-4444-4444-4444-444444444444') as any;
    expect(row.error_message).toBeNull();

    db.prepare('UPDATE jobs SET error_message = ? WHERE id = ?').run('boom', '44444444-4444-4444-4444-444444444444');
    const updated = db.prepare('SELECT error_message FROM jobs WHERE id = ?').get('44444444-4444-4444-4444-444444444444') as any;
    expect(updated.error_message).toBe('boom');
  });
});
