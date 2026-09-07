// test/presetsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { GET as listPresets, POST as createPreset } from '@/app/api/presets/route';
import { GET as getPreset, PUT as updatePreset, DELETE as deletePreset } from '@/app/api/presets/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetsroute-'));
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

function req(method: string, body?: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/presets/x', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('preset CRUD routes', () => {
  it('POST /api/presets requires login', async () => {
    const res = await createPreset(req('POST', { name: 'x', prompt: 'x' }));
    expect(res.status).toBe(401);
  });

  it('POST then GET list then GET one then PUT then DELETE, full round trip', async () => {
    const { cookieHeader } = await seedSession();

    const createRes = await createPreset(req('POST', {
      name: 'SaaS Landing',
      prompt: 'minimalist SaaS landing page',
      techStackTags: ['Tailwind'],
      themePrompt: 'dark, indigo accent',
      components: [{ assetType: 'nav bar', prompt: 'a nav bar' }],
    }, cookieHeader));
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()).data;
    expect(created.name).toBe('SaaS Landing');

    const listRes = await listPresets();
    const list = (await listRes.json()).data;
    expect(list.map((p: any) => p.id)).toContain(created.id);

    const getRes = await getPreset(req('GET'), { params: Promise.resolve({ id: created.id }) });
    expect((await getRes.json()).data.id).toBe(created.id);

    const putRes = await updatePreset(req('PUT', { name: 'Renamed' }, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    expect((await putRes.json()).data.name).toBe('Renamed');

    const deleteRes = await deletePreset(req('DELETE', undefined, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    expect(deleteRes.status).toBe(200);

    const listAfterDelete = (await (await listPresets()).json()).data;
    expect(listAfterDelete.map((p: any) => p.id)).not.toContain(created.id);
  });

  it('PUT requires login', async () => {
    const { cookieHeader } = await seedSession();
    const createRes = await createPreset(req('POST', { name: 'x', prompt: 'x' }, cookieHeader));
    const created = (await createRes.json()).data;

    const res = await updatePreset(req('PUT', { name: 'y' }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(401);
  });

  it('GET /api/presets/[id] returns 404 for a nonexistent id', async () => {
    const res = await getPreset(req('GET'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
