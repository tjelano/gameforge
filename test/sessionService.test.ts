import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-sessionservice-'));
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

describe('sessionService', () => {
  it('creates a session and resolves it back to the right user', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    const resolved = await sessionService.getUserByToken(token);
    expect(resolved?.id).toBe(alice.id);
  });

  it('returns null for an unknown token', async () => {
    expect(await sessionService.getUserByToken('not-a-real-token')).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('expired-token', alice.id, Date.now() - 1000, Date.now() - 2000);
    expect(await sessionService.getUserByToken('expired-token')).toBeNull();
  });

  it('destroy() removes the session so it no longer resolves', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    await sessionService.destroy(token);
    expect(await sessionService.getUserByToken(token)).toBeNull();
  });

  it('produces a token with real entropy, not a predictable value', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const a = await sessionService.create(alice.id);
    const b = await sessionService.create(alice.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(64); // 32 bytes hex-encoded
  });
});
