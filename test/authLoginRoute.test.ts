import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { POST } from '@/app/api/auth/login/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-authlogin-'));
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

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/login', () => {
  it('creates the first account and marks it admin when no users exist yet', async () => {
    const res = await POST(postRequest({ name: 'Alice' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.isAdmin).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  it('rejects the name/create path once a user already exists', async () => {
    await userService.create({ name: 'Alice' });
    const res = await POST(postRequest({ name: 'Bob' }));
    expect(res.status).toBe(403);
  });

  it('logs an existing user in by userId', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const res = await POST(postRequest({ userId: alice.id }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.id).toBe(alice.id);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  it('returns 404 for an unknown userId', async () => {
    const res = await POST(postRequest({ userId: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed body', async () => {
    const res = await POST(postRequest({ nonsense: true }));
    expect(res.status).toBe(400);
  });
});
