import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-insposearch-'));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/inspo/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/inspo/search', () => {
  it('requires login', async () => {
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'editorial' }));
    expect(res.status).toBe(401);
  });

  it('rejects a brief over the length cap', async () => {
    const { cookieHeader } = await seedSession();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'recommend', brief: 'a'.repeat(5001) }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('proxies a search request and returns Inspo\'s result', async () => {
    const { cookieHeader } = await seedSession();
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, searchScreens: vi.fn().mockResolvedValue({ results: [{ slug: 'acme-corp' }] }) };
    });
    vi.resetModules();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'editorial' }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.results[0].slug).toBe('acme-corp');
  });

  it('rejects a query over the length cap', async () => {
    const { cookieHeader } = await seedSession();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'a'.repeat(501) }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('passes a real search_screens field (e.g. color) through to searchScreens', async () => {
    const { cookieHeader } = await seedSession();
    const searchScreens = vi.fn().mockResolvedValue({ results: [] });
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, searchScreens };
    });
    vi.resetModules();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'editorial', color: 'warm' }, cookieHeader));
    expect(res.status).toBe(200);
    expect(searchScreens).toHaveBeenCalledWith(expect.objectContaining({ query: 'editorial', color: 'warm' }));
  });

  it('rejects an unknown top-level field like a raw filters object', async () => {
    const { cookieHeader } = await seedSession();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'editorial', filters: { query: 'malicious' } }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('never lets another accepted field override the validated query', async () => {
    const { cookieHeader } = await seedSession();
    const searchScreens = vi.fn().mockResolvedValue({ results: [] });
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, searchScreens };
    });
    vi.resetModules();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'safe', color: 'malicious', style: 'malicious' }, cookieHeader));
    expect(res.status).toBe(200);
    expect(searchScreens).toHaveBeenCalledWith(expect.objectContaining({ query: 'safe' }));
  });
});
