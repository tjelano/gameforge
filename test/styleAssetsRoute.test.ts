// test/styleAssetsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { GET } from '@/app/api/styles/[id]/assets/route';

let tempRoot: string;
const STYLE_A = '11111111-1111-1111-1111-111111111111';
const STYLE_B = '22222222-2222-2222-2222-222222222222';
const ASSET_A1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const ASSET_A2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const ASSET_A3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const ASSET_B1 = 'bbbbbbbb-0000-0000-0000-000000000001';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-styleassets-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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
     VALUES (?, 'style A', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_A);
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style B', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_B);

  const insertAsset = db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES (?, ?, 'user-1', 'button', ?, ?, 1000, ?, ?)`
  );
  insertAsset.run(ASSET_A1, STYLE_A, 'a theme', 'theme.css', 0, 'theme');
  insertAsset.run(ASSET_A2, STYLE_A, 'a component', 'comp.html', 0, 'component');
  insertAsset.run(ASSET_A3, STYLE_A, 'a deleted image', 'img.png', 1, 'image'); // soft-deleted, must be excluded
  insertAsset.run(ASSET_B1, STYLE_B, 'other style asset', 'other.png', 0, 'image');
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/styles/[id]/assets', () => {
  it('returns only active assets scoped to the given style, mixing output_kind', async () => {
    const res = await GET(new NextRequest('http://localhost/api/styles/x/assets'), {
      params: Promise.resolve({ id: STYLE_A }),
    });
    const body = await res.json();

    expect(body.success).toBe(true);
    const ids = body.data.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([ASSET_A1, ASSET_A2].sort());
  });

  it('returns an empty array for a style with no assets', async () => {
    const res = await GET(new NextRequest('http://localhost/api/styles/x/assets'), {
      params: Promise.resolve({ id: 'no-such-style' }),
    });
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });
});
