import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;
const STYLE_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-outputkind-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('JobService.create with outputKind', () => {
  it('defaults to \'image\' when outputKind is omitted', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'x' });
    expect(job.output_kind).toBe('image');
  });

  it('stores an explicit \'theme\' value', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    expect(job.output_kind).toBe('theme');
  });
});

describe('AssetService.create with outputKind', () => {
  it('defaults to \'image\' when outputKind is omitted', async () => {
    const asset = await assetService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'x.png' });
    expect(asset.output_kind).toBe('image');
  });

  it('stores an explicit \'theme\' value', async () => {
    const asset = await assetService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'x.css', outputKind: 'theme' });
    expect(asset.output_kind).toBe('theme');
  });
});

describe('POST /api/generate with outputKind', () => {
  it('threads outputKind through to the created job', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'dark fantasy', outputKind: 'theme' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.output_kind).toBe('theme');
  });

  it('defaults outputKind to \'image\' when omitted, preserving existing callers', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.data.output_kind).toBe('image');
  });

  it('rejects a theme job that also carries UI-sheet pieces options', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme',
        options: { pieces: [{ shape: 'rect', x: 0, y: 0, width: 10, height: 10 }] },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('rejects a prompt over 2000 characters', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'x'.repeat(2001) }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/assets/from-job copies output_kind through', () => {
  it('promoted asset inherits the job\'s output_kind', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?`).run('theme.css', job.id);

    const { POST } = await import('@/app/api/assets/from-job/route');
    const req = new NextRequest('http://localhost/api/assets/from-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.output_kind).toBe('theme');
  });
});
