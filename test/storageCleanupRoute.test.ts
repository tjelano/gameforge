import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';

let tempRoot: string;
let cookieHeader: string;

function cleanupRequest(withCookie = true): NextRequest {
  return new NextRequest('http://localhost/api/storage/cleanup', {
    method: 'POST',
    headers: withCookie ? { Cookie: cookieHeader } : undefined,
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-storagecleanup-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  ({ cookieHeader } = await seedSession());
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('POST /api/storage/cleanup', () => {
  it('401s when not logged in', async () => {
    const { POST } = await import('@/app/api/storage/cleanup/route');
    const res = await POST(cleanupRequest(false));
    expect(res.status).toBe(401);
  });

  // storage/images and storage/themes are never created in this fixture —
  // cleanupOrphanedIn()'s readdir failure path catches ENOENT and returns 0,
  // so a logged-in call still succeeds with nothing to remove. This test
  // only needs to prove the route reaches the service calls past the guard,
  // not exercise cleanupOrphanedImages/Themes's own logic — that's already
  // covered by cleanupOrphanedImages.test.ts / cleanupOrphanedThemes.test.ts.
  it('200s and reports zero removed when logged in with nothing to clean up', async () => {
    const { POST } = await import('@/app/api/storage/cleanup/route');
    const res = await POST(cleanupRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.removed).toBe(0);
  });
});
