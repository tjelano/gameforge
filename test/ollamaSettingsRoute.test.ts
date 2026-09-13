import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';

let tempRoot: string;
let cookieHeader: string;

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/ollama', {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-ollamasettings-'));
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

describe('GET/PUT /api/settings/ollama', () => {
  it('401s when not logged in', async () => {
    const { GET } = await import('@/app/api/settings/ollama/route');
    const res = await GET(new NextRequest('http://localhost/api/settings/ollama'));
    expect(res.status).toBe(401);
  });

  it('GET returns the default host when nothing has been saved', async () => {
    const { GET } = await import('@/app/api/settings/ollama/route');
    const res = await GET(req('GET'));
    const body = await res.json();
    expect(body.data.host).toBe('http://localhost:11434');
  });

  it('PUT saves the host, and a subsequent GET returns it', async () => {
    const { GET, PUT } = await import('@/app/api/settings/ollama/route');
    await PUT(req('PUT', { host: 'http://192.168.1.50:11434' }));
    const res = await GET(req('GET'));
    const body = await res.json();
    expect(body.data.host).toBe('http://192.168.1.50:11434');
  });

  it('PUT rejects a host with no http/https scheme', async () => {
    const { PUT } = await import('@/app/api/settings/ollama/route');
    const res = await PUT(req('PUT', { host: 'localhost:11434' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/settings/ollama/test-connection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports reachable: true when /api/tags responds ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
    const { POST } = await import('@/app/api/settings/ollama/test-connection/route');
    const res = await POST(req('POST'));
    const body = await res.json();
    expect(body.data.reachable).toBe(true);
  });

  it('reports reachable: false when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { POST } = await import('@/app/api/settings/ollama/test-connection/route');
    const res = await POST(req('POST'));
    const body = await res.json();
    expect(body.data.reachable).toBe(false);
  });
});
