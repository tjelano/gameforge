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

  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-ollamapull-'));
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

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/ollama/models/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('POST /api/settings/ollama/models/pull', () => {
  it('401s when not logged in', async () => {
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(new NextRequest('http://localhost/api/settings/ollama/models/pull', { method: 'POST', body: JSON.stringify({ model: 'x' }) }));
    expect(res.status).toBe(401);
  });

  it('400s when no model is given', async () => {
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('forwards the request to Ollama /api/pull with stream: true and the requested model', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: new ReadableStream() });
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    await POST(req({ model: 'llama3-groq-tool-use:8b' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/pull');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'llama3-groq-tool-use:8b', stream: true });
  });

  it('returns the upstream NDJSON stream as the response body', async () => {
    const chunks = ['{"status":"pulling manifest"}\n', '{"status":"success"}\n'];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, body: stream });

    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(req({ model: 'llama3-groq-tool-use:8b' }));
    const text = await res.text();
    expect(text).toBe(chunks.join(''));
  });

  it('500s with a clear error when Ollama itself rejects the pull', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'model not found' });
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(req({ model: 'does-not-exist' }));
    expect(res.status).toBe(500);
  });
});
