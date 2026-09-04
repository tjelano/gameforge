// test/themeFileServing.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeserve-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/themes/[filename]', () => {
  it('serves a real CSS file with the correct content type', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'real.css'), ':root { --color-bg: #000; }');
    const { GET } = await import('@/app/api/themes/[filename]/route');
    const res = await GET(new NextRequest('http://localhost/api/themes/real.css'), { params: Promise.resolve({ filename: 'real.css' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(await res.text()).toContain('--color-bg: #000;');
  });

  it('404s for a filename that does not exist', async () => {
    const { GET } = await import('@/app/api/themes/[filename]/route');
    const res = await GET(new NextRequest('http://localhost/api/themes/nope.css'), { params: Promise.resolve({ filename: 'nope.css' }) });
    expect(res.status).toBe(404);
  });

  it('400s on a path-traversal filename, mirroring the images route\'s own guard', async () => {
    const { GET } = await import('@/app/api/themes/[filename]/route');
    const res = await GET(new NextRequest('http://localhost/api/themes/..%2Fsecrets.css'), { params: Promise.resolve({ filename: '../secrets.css' }) });
    expect(res.status).toBe(400);
  });
});
