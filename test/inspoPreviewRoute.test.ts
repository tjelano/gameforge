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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-inspopreview-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookieHeader) headers['Cookie'] = cookieHeader;
  return new NextRequest('http://localhost/api/inspo/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_DESIGN_MD = [
  '- **Captured:** 2026-08-01T00:00:00Z',
  '- **Mode:** light',
  '## Colors',
  '| Hex | Role (heuristic) |',
  '|---|---|',
  '| `#ffffff` | surface |',
  '| `#111111` | ink |',
  '| `#3b82f6` | accent |',
].join('\n');

describe('POST /api/inspo/preview', () => {
  it('requires login', async () => {
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: 'acme-corp' }));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid slug with a 400 before ever fetching', async () => {
    const { cookieHeader } = await seedSession();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: '../etc/passwd' }, cookieHeader));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns mapped tokens, provenance, and lowConfidence for a valid slug', async () => {
    const { cookieHeader } = await seedSession();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Map(), text: () => Promise.resolve(VALID_DESIGN_MD) }) as any;
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: 'acme-corp' }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.tokens.colorAccent).toBe('#3b82f6');
    expect(body.data.provenance.colorAccent).toBe('heuristic');
    expect(typeof body.data.lowConfidence).toBe('boolean');
  });

  it('returns a 4xx with a distinct message when Inspo 404s', async () => {
    const { cookieHeader } = await seedSession();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') }) as any;
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: 'missing-site' }, cookieHeader));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = await res.json();
    expect(body.error).toMatch(/404|not found/i);
  });
});
