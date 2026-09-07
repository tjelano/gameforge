import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { UserSchema } from '@/lib/database/schema';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-userschema-'));
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

describe('users/sessions tables', () => {
  it('creates a user row and parses it with UserSchema', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run('11111111-1111-1111-1111-111111111111', 'Alice', 1, Date.now());
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('11111111-1111-1111-1111-111111111111');
    expect(() => UserSchema.parse(row)).not.toThrow();
  });

  it('enforces a unique name constraint', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run('11111111-1111-1111-1111-111111111111', 'Alice', 1, Date.now());
    expect(() =>
      db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
        .run('22222222-2222-2222-2222-222222222222', 'Alice', 0, Date.now())
    ).toThrow();
  });

  it('creates a session row referencing a user', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run('11111111-1111-1111-1111-111111111111', 'Alice', 1, Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('sometoken', '11111111-1111-1111-1111-111111111111', Date.now() + 1000, Date.now());
    const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get('sometoken');
    expect(row).toBeTruthy();
  });
});
