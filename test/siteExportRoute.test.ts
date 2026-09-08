import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { seedSession } from '@/test/helpers/testSession';
import { POST } from '@/app/api/styles/[id]/site-export/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-siteexportroute-'));
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

describe('POST /api/styles/[id]/site-export', () => {
  it('returns 401 when not logged in', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ subdir: 'test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('exports when logged in and returns page/component counts', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: 'route-test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.pagesExported).toBe(1);
  });

  it('rejects an invalid subdir', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: '../escape' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a style with no pages', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: 'empty-test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 400 (not 500) for a malformed JSON body', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: '{not valid json',
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
