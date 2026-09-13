import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { GET } from '@/app/api/auth/me/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-authme-'));
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

describe('GET /api/auth/me', () => {
  it('returns the logged-in user', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    const req = new NextRequest('http://localhost/api/auth/me', { headers: { Cookie: `session=${token}` } });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Alice');
  });

  it('returns null data when logged out', async () => {
    const req = new NextRequest('http://localhost/api/auth/me');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
  });

  it('returns a clean 500 instead of crashing when the session lookup throws', async () => {
    const { sessionService } = await import('@/lib/services/SessionService');
    const spy = vi.spyOn(sessionService, 'getUserByToken').mockRejectedValueOnce(new Error('db exploded'));
    const req = new NextRequest('http://localhost/api/auth/me', { headers: { Cookie: 'session=whatever' } });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    spy.mockRestore();
  });
});
