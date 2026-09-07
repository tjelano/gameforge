import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { getCurrentUser } from '@/lib/utils/session';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-getcurrentuser-'));
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

describe('getCurrentUser', () => {
  it('returns the user for a valid session cookie', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    const req = new NextRequest('http://localhost/x', { headers: { Cookie: `session=${token}` } });
    const user = await getCurrentUser(req);
    expect(user?.id).toBe(alice.id);
  });

  it('returns null when there is no session cookie at all', async () => {
    const req = new NextRequest('http://localhost/x');
    expect(await getCurrentUser(req)).toBeNull();
  });

  it('returns null for a session cookie that does not match any session', async () => {
    const req = new NextRequest('http://localhost/x', { headers: { Cookie: 'session=bogus' } });
    expect(await getCurrentUser(req)).toBeNull();
  });
});
