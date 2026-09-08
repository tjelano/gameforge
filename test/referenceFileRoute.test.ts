import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { GET } from '@/app/api/references/[filename]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-refroute-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'references'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/references/[filename]', () => {
  it('serves a stored reference image as image/png', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', 'reference-1.png'), Buffer.from('fake-bytes'));
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-1.png' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('fake-bytes');
  });

  it('serves .jpg as image/jpeg and .webp as image/webp', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', 'reference-2.jpg'), Buffer.from('x'));
    const jpegRes = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-2.jpg' }) });
    expect(jpegRes.headers.get('Content-Type')).toBe('image/jpeg');

    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', 'reference-3.webp'), Buffer.from('x'));
    const webpRes = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-3.webp' }) });
    expect(webpRes.headers.get('Content-Type')).toBe('image/webp');
  });

  it('returns 404 for a missing file', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-missing.png' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a path-traversal filename, never touching the filesystem', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: '../../etc/passwd' }) });
    expect(res.status).toBe(400);
  });
});
