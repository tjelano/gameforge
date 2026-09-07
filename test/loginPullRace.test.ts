// test/loginPullRace.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { gitService } from '@/lib/services/GitService';
import { POST as login } from '@/app/api/auth/login/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-loginpullrace-'));
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

function loginRequest(body: unknown) {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('login create-first-account path after a git import', () => {
  it('rejects create-first-account once importFromJson has brought in an existing admin', async () => {
    // Simulate "Alice already exists on the synced repo" by writing an
    // exported user file directly, the same shape exportToJson() produces,
    // then importing it — mirroring what a real `git pull` would leave on
    // disk before Bob's first login attempt.
    const usersDir = path.join(tempRoot, 'data', 'users');
    await fsPromises.mkdir(usersDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(usersDir, 'user-11111111-1111-1111-1111-111111111111.json'),
      JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', name: 'Alice', is_admin: 1, created_at: Date.now() })
    );
    await gitService.importFromJson();

    // Bob's local `users` table is no longer empty — the create-first path must be rejected.
    const res = await login(loginRequest({ name: 'Bob' }));
    expect(res.status).toBe(403);

    const admins = (await userService.getAll()).filter(u => u.is_admin === 1);
    expect(admins.length).toBe(1);
    expect(admins[0].name).toBe('Alice');
  });
});
