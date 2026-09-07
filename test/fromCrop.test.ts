import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { POST as fromCrop } from '@/app/api/assets/from-crop/route';
import { seedSession } from './helpers/testSession';

let tempRoot: string;
let cookieHeader: string;
const STYLE_ID = '99999999-9999-9999-9999-999999999999';

// A real, tiny valid PNG (1x1 transparent), base64-encoded — same bytes
// used as the mock placeholder elsewhere in this project.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assets/from-crop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-fromcrop-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  ({ cookieHeader } = await seedSession());
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
  // Create a job for the source_job_id foreign key constraint
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, created_at, updated_at)
     VALUES (?, ?, 'user-1', 'ui_element', 'test', 'complete', 1000, 1000)`
  ).run('11111111-1111-1111-1111-111111111111', STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('POST /api/assets/from-crop', () => {
  it('saves the cropped image to storage/images and creates an asset with source_job_id set', async () => {
    const res = await fromCrop(postRequest({
      styleId: STYLE_ID,
      jobId: '11111111-1111-1111-1111-111111111111',
      label: 'Inventory',
      imageDataUrl: TINY_PNG_DATA_URL,
    }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.prompt).toBe('Inventory');
    expect(body.data.source_job_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.data.image_path).toMatch(/\.png$/);

    const filePath = path.join(tempRoot, 'storage', 'images', body.data.image_path);
    const stat = await fsPromises.stat(filePath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('rejects an empty label with a 400, not a 500 from a failed asset insert', async () => {
    const res = await fromCrop(postRequest({
      styleId: STYLE_ID,
      jobId: '11111111-1111-1111-1111-111111111111',
      label: '',
      imageDataUrl: TINY_PNG_DATA_URL,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
