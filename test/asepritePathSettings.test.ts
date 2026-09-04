import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { GET as getPath, PUT as putPath } from '@/app/api/settings/aseprite-path/route';

let tempRoot: string;

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/aseprite-path', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-asepritesettings-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

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

describe('GET/PUT /api/settings/aseprite-path', () => {
  it('GET returns an empty path when nothing has been saved', async () => {
    const res = await getPath();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.path).toBe('');
  });

  it('PUT saves the path, and a subsequent GET returns it', async () => {
    const putRes = await putPath(putRequest({ path: 'C:\\Aseprite\\Aseprite.exe' }));
    const putBody = await putRes.json();
    expect(putBody.success).toBe(true);
    expect(putBody.data.path).toBe('C:\\Aseprite\\Aseprite.exe');

    const getRes = await getPath();
    const getBody = await getRes.json();
    expect(getBody.data.path).toBe('C:\\Aseprite\\Aseprite.exe');
  });

  it('PUT accepts an empty path — this is how the setting gets cleared', async () => {
    await putPath(putRequest({ path: 'C:\\Aseprite\\Aseprite.exe' }));
    const res = await putPath(putRequest({ path: '' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.path).toBe('');

    const getRes = await getPath();
    const getBody = await getRes.json();
    expect(getBody.data.path).toBe('');
  });

  it('PUT rejects a missing path field with a 400', async () => {
    const res = await putPath(putRequest({}));
    expect(res.status).toBe(400);
  });

  it('PUT rejects a non-string path with a 400', async () => {
    const res = await putPath(putRequest({ path: 123 }));
    expect(res.status).toBe(400);
  });

  it('PUT rejects a relative path with a 400', async () => {
    const res = await putPath(putRequest({ path: 'Aseprite.exe' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('PUT trims surrounding whitespace before validating and saving', async () => {
    const res = await putPath(putRequest({ path: '  C:\\Aseprite\\Aseprite.exe  ' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe('C:\\Aseprite\\Aseprite.exe');
  });

  it('PUT rejects a UNC path with a 400 — round 3 review finding: a UNC path is absolute but not local', async () => {
    const res = await putPath(putRequest({ path: '\\\\attacker-server\\share\\aseprite.exe' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
