import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { PUT, DELETE } from '@/app/api/assets/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetownership-'));
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
  return new NextRequest('http://localhost/api/assets/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('asset ownership: admin bypass', () => {
  it("lets a non-owner admin edit someone else's asset", async () => {
    const admin = await userService.create({ name: 'Admin' }); // first user created = admin
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);

    const style = await styleService.create({ name: 'S', createdBy: other.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: other.id, assetType: 'button', prompt: "Their asset", imagePath: 'x.png' });

    const res = await PUT(putRequest({ prompt: 'Renamed by admin' }, `session=${token}`), { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.prompt).toBe('Renamed by admin');
  });

  it('still blocks a non-owner, non-admin user from editing', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);

    const style = await styleService.create({ name: 'S', createdBy: owner.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: owner.id, assetType: 'button', prompt: 'Owned', imagePath: 'x.png' });

    const res = await PUT(putRequest({ prompt: 'Should fail' }, `session=${token}`), { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(403);
  });

  it('401s an edit attempt with no session', async () => {
    const owner = await userService.create({ name: 'Owner' });
    const style = await styleService.create({ name: 'S', createdBy: owner.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: owner.id, assetType: 'button', prompt: 'Owned', imagePath: 'x.png' });

    const req = new NextRequest('http://localhost/api/assets/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(401);
  });

  it("lets the admin delete someone else's asset", async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const style = await styleService.create({ name: 'S', createdBy: other.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: other.id, assetType: 'button', prompt: 'Deletable', imagePath: 'x.png' });

    const req = new NextRequest('http://localhost/api/assets/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(200);
  });

  it('still blocks a non-owner, non-admin user from deleting', async () => {
    await userService.create({ name: 'Admin' });
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const style = await styleService.create({ name: 'S', createdBy: owner.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: owner.id, assetType: 'button', prompt: 'Owned', imagePath: 'x.png' });

    const req = new NextRequest('http://localhost/api/assets/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(403);
  });
});
