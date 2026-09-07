// test/pagesRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { seedSession } from './helpers/testSession';
import { GET as listPages, POST as createPage } from '@/app/api/styles/[id]/pages/route';
import { GET as getPage, PUT as updatePage, DELETE as deletePage } from '@/app/api/pages/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pagesroute-'));
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
  return new NextRequest('http://localhost/api/pages/x', {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('page CRUD routes', () => {
  it('POST /api/styles/[id]/pages requires login', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const res = await createPage(req('POST', { name: 'Landing' }), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('POST then GET list then GET one then PUT then DELETE, full round trip', async () => {
    const { cookieHeader } = await seedSession();
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });

    const createRes = await createPage(req('POST', { name: 'Landing Page' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()).data;
    expect(created.name).toBe('Landing Page');
    expect(JSON.parse(created.component_asset_ids)).toEqual([]);

    const listRes = await listPages(req('GET'), { params: Promise.resolve({ id: style.id }) });
    const list = (await listRes.json()).data;
    expect(list.map((p: any) => p.id)).toEqual([created.id]);

    const getRes = await getPage(req('GET'), { params: Promise.resolve({ id: created.id }) });
    expect((await getRes.json()).data.id).toBe(created.id);

    const putRes = await updatePage(req('PUT', { name: 'Renamed', componentAssetIds: ['c1', 'c2'] }, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    const updated = (await putRes.json()).data;
    expect(updated.name).toBe('Renamed');
    expect(JSON.parse(updated.component_asset_ids)).toEqual(['c1', 'c2']);

    const deleteRes = await deletePage(req('DELETE', undefined, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    expect(deleteRes.status).toBe(200);

    const listAfterDelete = (await (await listPages(req('GET'), { params: Promise.resolve({ id: style.id }) })).json()).data;
    expect(listAfterDelete).toEqual([]);
  });

  it('list only returns pages for the given style', async () => {
    const { cookieHeader } = await seedSession();
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });
    await createPage(req('POST', { name: 'In A' }, cookieHeader), { params: Promise.resolve({ id: styleA.id }) });
    await createPage(req('POST', { name: 'In B' }, cookieHeader), { params: Promise.resolve({ id: styleB.id }) });

    const listRes = await listPages(req('GET'), { params: Promise.resolve({ id: styleA.id }) });
    const list = (await listRes.json()).data;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('In A');
  });

  it('PUT requires login', async () => {
    const { cookieHeader } = await seedSession();
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const createRes = await createPage(req('POST', { name: 'x' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    const created = (await createRes.json()).data;

    const res = await updatePage(req('PUT', { name: 'y' }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(401);
  });

  it('GET /api/pages/[id] returns 404 for a nonexistent id', async () => {
    const res = await getPage(req('GET'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
