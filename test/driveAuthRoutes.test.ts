import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';

let tempRoot: string;
let cookieHeader: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-driveauthroutes-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
  ({ cookieHeader } = await seedSession());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/drive/connect', () => {
  it('redirects to a Google consent URL', async () => {
    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('accounts.google.com');
  });

  it('redirects to /login?reason=expired when not logged in', async () => {
    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect');
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?reason=expired');
  });

  it('redirects with an error indicator instead of crashing when the session lookup throws', async () => {
    const { sessionService } = await import('@/lib/services/SessionService');
    const spy = vi.spyOn(sessionService, 'getUserByToken').mockRejectedValueOnce(new Error('db exploded'));
    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=');
    spy.mockRestore();
  });
});

describe('GET /api/drive/status', () => {
  it('reports not connected before any token is stored', async () => {
    const { GET } = await import('@/app/api/drive/status/route');
    const req = new NextRequest('http://localhost/api/drive/status', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    const body = await res.json();
    expect(body.data.connected).toBe(false);
  });

  it('returns a clean 500 instead of crashing when the Drive check throws', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    const spy = vi.spyOn(driveService, 'isConnected').mockRejectedValueOnce(new Error('drive unreachable'));
    const { GET } = await import('@/app/api/drive/status/route');
    const req = new NextRequest('http://localhost/api/drive/status', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    spy.mockRestore();
  });
});

describe('GET /api/drive/callback', () => {
  it('exchanges the code, stores the token, and redirects to the settings page', async () => {
    const { OAuth2Client } = await import('google-auth-library');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'a-real-looking-refresh-token' },
      res: null,
    } as any);

    const { GET } = await import('@/app/api/drive/callback/route');
    const req = new NextRequest('http://localhost/api/drive/callback?code=fake-code', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard/settings/google-drive');

    const { driveService } = await import('@/lib/services/DriveService');
    expect(await driveService.isConnected()).toBe(true);
  });

  it('redirects with an error indicator if no code is present', async () => {
    const { GET } = await import('@/app/api/drive/callback/route');
    const req = new NextRequest('http://localhost/api/drive/callback', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=');
  });

  it('redirects with an error indicator instead of crashing when the session lookup throws', async () => {
    const { sessionService } = await import('@/lib/services/SessionService');
    const spy = vi.spyOn(sessionService, 'getUserByToken').mockRejectedValueOnce(new Error('db exploded'));
    const { GET } = await import('@/app/api/drive/callback/route');
    const req = new NextRequest('http://localhost/api/drive/callback?code=fake-code', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=');
    spy.mockRestore();
  });
});
