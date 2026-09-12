// test/exportRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { seedSession } from '@/test/helpers/testSession';
import { POST } from '@/app/api/export/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-exportroute-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

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

function postRequest(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/export', () => {
  it('401s when not logged in', async () => {
    const res = await POST(postRequest({ styleId: '99999999-9999-9999-9999-999999999999', subdir: 'godot' }));
    expect(res.status).toBe(401);
  });

  it('400s when styleId is missing', async () => {
    const { cookieHeader } = await seedSession();
    const res = await POST(postRequest({ subdir: 'godot' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('rejects a path-traversal subdir instead of exporting to it', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await POST(postRequest({ styleId: style.id, subdir: '../escape' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('exports the given style and returns counts', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await POST(postRequest({ styleId: style.id, subdir: 'godot-route-test' }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.exported).toBe(0); // no assets for this style, but a valid, scoped export
  });

  it('maps a subdir collision to a 400 with ALREADY_EXISTS', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    await POST(postRequest({ styleId: style.id, subdir: 'godot-route-collide' }, cookieHeader));
    const res = await POST(postRequest({ styleId: style.id, subdir: 'godot-route-collide' }, cookieHeader));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('ALREADY_EXISTS');
  });

  it('maps a soft-deleted style to a 404 with STYLE_NOT_FOUND', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    await styleService.softDelete(style.id, userId);
    const res = await POST(postRequest({ styleId: style.id, subdir: 'godot-route-deleted-style' }, cookieHeader));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('STYLE_NOT_FOUND');
  });
});
