// test/styleOwnershipAdminBypass.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { PUT, DELETE } from '@/app/api/styles/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-adminbypass-'));
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

function putRequest(body: unknown, cookieHeader: string) {
  return new NextRequest('http://localhost/api/styles/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('style ownership: admin bypass', () => {
  it('lets a non-owner admin edit someone else\'s style', async () => {
    const admin = await userService.create({ name: 'Admin' }); // first user created = admin
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);

    const style = await styleService.create({ name: 'Their Style', createdBy: other.id, parameters: '{}' });

    const res = await PUT(putRequest({ name: 'Renamed by admin' }, `session=${token}`), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed by admin');
  });

  it('still blocks a non-owner, non-admin user', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);

    const style = await styleService.create({ name: 'Owned', createdBy: owner.id, parameters: '{}' });

    const res = await PUT(putRequest({ name: 'Should fail' }, `session=${token}`), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(403);
  });

  it('lets the admin delete someone else\'s style', async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const style = await styleService.create({ name: 'Deletable', createdBy: other.id, parameters: '{}' });

    const req = new NextRequest('http://localhost/api/styles/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);
  });
});
