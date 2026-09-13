import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';

// These 4 routes delegate entirely to GitService, whose own git logic is
// already exhaustively covered against a real temp-git-repo fixture
// elsewhere (test/gitServicePages.test.ts etc.). This file is testing the
// routes' new auth guard only, so GitService is mocked rather than
// exercising real git — no existing mock precedent for this service, but
// the alternative (a real repo fixture per route, per auth state) would
// test git behavior this file has no reason to re-verify.
const pullMock = vi.fn();
const pushMock = vi.fn();
const abortMergeMock = vi.fn();
const resolveConflictsMock = vi.fn();
vi.mock('@/lib/services/GitService', () => ({
  gitService: {
    pull: (...args: unknown[]) => pullMock(...args),
    push: (...args: unknown[]) => pushMock(...args),
    abortMerge: (...args: unknown[]) => abortMergeMock(...args),
    resolveConflicts: (...args: unknown[]) => resolveConflictsMock(...args),
  },
}));

let tempRoot: string;
let cookieHeader: string;

function request(withCookie = true): NextRequest {
  return new NextRequest('http://localhost/api/git/x', {
    method: 'POST',
    headers: withCookie ? { Cookie: cookieHeader } : undefined,
  });
}

beforeEach(async () => {
  pullMock.mockReset().mockResolvedValue({ success: true });
  pushMock.mockReset().mockResolvedValue({ success: true });
  abortMergeMock.mockReset().mockResolvedValue({ success: true });
  resolveConflictsMock.mockReset().mockResolvedValue(undefined);

  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitroutesauth-'));
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

describe('POST /api/git/pull', () => {
  it('401s when not logged in, without calling gitService', async () => {
    const { POST } = await import('@/app/api/git/pull/route');
    const res = await POST(request(false));
    expect(res.status).toBe(401);
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('200s and calls gitService.pull() when logged in', async () => {
    const { POST } = await import('@/app/api/git/pull/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/git/push', () => {
  it('401s when not logged in, without calling gitService', async () => {
    const { POST } = await import('@/app/api/git/push/route');
    const res = await POST(request(false));
    expect(res.status).toBe(401);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('200s and calls gitService.push() when logged in', async () => {
    const { POST } = await import('@/app/api/git/push/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/git/abort', () => {
  it('401s when not logged in, without calling gitService', async () => {
    const { POST } = await import('@/app/api/git/abort/route');
    const res = await POST(request(false));
    expect(res.status).toBe(401);
    expect(abortMergeMock).not.toHaveBeenCalled();
  });

  it('200s and calls gitService.abortMerge() when logged in', async () => {
    const { POST } = await import('@/app/api/git/abort/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(abortMergeMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/git/resolve', () => {
  it('401s when not logged in, without calling gitService', async () => {
    const { POST } = await import('@/app/api/git/resolve/route');
    const res = await POST(request(false));
    expect(res.status).toBe(401);
    expect(resolveConflictsMock).not.toHaveBeenCalled();
  });

  it('200s and calls gitService.resolveConflicts() when logged in', async () => {
    const { POST } = await import('@/app/api/git/resolve/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(resolveConflictsMock).toHaveBeenCalledTimes(1);
  });
});
