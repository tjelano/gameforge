// test/pageOwnershipAdminBypass.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { PUT, DELETE } from '@/app/api/pages/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pageadminbypass-'));
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
  return new NextRequest('http://localhost/api/pages/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

async function createPage(createdBy: string) {
  const style = await styleService.create({ name: 'S', createdBy, parameters: '{}' });
  return pageService.create({ styleId: style.id, name: 'Their Page', createdBy });
}

describe('page ownership: admin bypass', () => {
  it('lets a non-owner admin edit someone else\'s page', async () => {
    const admin = await userService.create({ name: 'Admin' }); // first user created = admin
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const page = await createPage(other.id);

    const res = await PUT(putRequest({ name: 'Renamed by admin' }, `session=${token}`), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed by admin');
  });

  it('blocks a non-owner, non-admin user from editing', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const page = await createPage(owner.id);

    const res = await PUT(putRequest({ name: 'Should fail' }, `session=${token}`), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(403);
  });

  it('lets the admin delete someone else\'s page', async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const page = await createPage(other.id);

    const req = new NextRequest('http://localhost/api/pages/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
  });

  it('blocks a non-owner, non-admin user from deleting', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const page = await createPage(owner.id);

    const req = new NextRequest('http://localhost/api/pages/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(403);
  });
});
