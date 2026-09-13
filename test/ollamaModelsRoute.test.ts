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
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-ollamamodels-'));
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
  vi.unstubAllGlobals();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(): NextRequest {
  return new NextRequest('http://localhost/api/settings/ollama/models', { headers: { Cookie: cookieHeader } });
}

describe('GET /api/settings/ollama/models', () => {
  it('401s when not logged in', async () => {
    const { GET } = await import('@/app/api/settings/ollama/models/route');
    const res = await GET(new NextRequest('http://localhost/api/settings/ollama/models'));
    expect(res.status).toBe(401);
  });

  it('returns the installed model names from /api/tags, plus the host they came from', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3-groq-tool-use:8b' }, { name: 'qwen2.5:7b' }] }),
    });
    const { GET } = await import('@/app/api/settings/ollama/models/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.data.models).toEqual(['llama3-groq-tool-use:8b', 'qwen2.5:7b']);
    expect(body.data.host).toBe('http://localhost:11434');
  });

  it('returns an empty list (not an error) when the host is unreachable, but still reports the configured host', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { GET } = await import('@/app/api/settings/ollama/models/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.models).toEqual([]);
    expect(body.data.host).toBe('http://localhost:11434');
  });
});
