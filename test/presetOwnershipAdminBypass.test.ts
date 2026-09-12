// test/presetOwnershipAdminBypass.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { PUT, DELETE } from '@/app/api/presets/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetadminbypass-'));
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
  return new NextRequest('http://localhost/api/presets/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

function createPreset(createdBy: string) {
  return presetService.create({
    name: 'Their Preset',
    createdBy,
    prompt: 'x',
    techStackTags: '[]',
    themePrompt: null,
    components: '[]',
  });
}

describe('preset ownership: admin bypass', () => {
  it('lets a non-owner admin edit someone else\'s preset', async () => {
    const admin = await userService.create({ name: 'Admin' }); // first user created = admin
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const preset = await createPreset(other.id);

    const res = await PUT(putRequest({ name: 'Renamed by admin' }, `session=${token}`), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed by admin');
  });

  it('blocks a non-owner, non-admin user from editing', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const preset = await createPreset(owner.id);

    const res = await PUT(putRequest({ name: 'Should fail' }, `session=${token}`), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(403);
  });

  it('lets the admin delete someone else\'s preset', async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const preset = await createPreset(other.id);

    const req = new NextRequest('http://localhost/api/presets/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(200);
  });

  it('blocks a non-owner, non-admin user from deleting', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const preset = await createPreset(owner.id);

    const req = new NextRequest('http://localhost/api/presets/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(403);
  });
});
