import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { GET } from '@/app/api/components/[filename]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-componentroute-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/components/[filename]', () => {
  it('serves a stored component file as text/html with a restrictive CSP header', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'test.html'), '<!DOCTYPE html><html><body>hi</body></html>');
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'test.html' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('hi');
  });

  it('rejects a path-traversal filename', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: '../../etc/passwd' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent file', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'nope.html' }) });
    expect(res.status).toBe(404);
  });
});
