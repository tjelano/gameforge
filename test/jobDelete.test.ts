import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { sessionService } from '@/lib/services/SessionService';
import { DELETE as deleteJob } from '@/app/api/jobs/[id]/route';

let tempRoot: string;
let cookieHeader: string;
const STYLE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SHEET_JOB_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD_ASSET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const COMPOSITE_FILENAME = 'sheet-composite.png';

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/jobs/${SHEET_JOB_ID}`, { method: 'DELETE', headers: { Cookie: cookieHeader } });
}

async function jsonOf(res: Response) {
  return res.json();
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobdelete-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();

  db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run('11111111-1111-1111-1111-111111111111', 'Test User', 0, Date.now());
  const { token } = await sessionService.create('11111111-1111-1111-1111-111111111111');
  cookieHeader = `session=${token}`;

  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', '11111111-1111-1111-1111-111111111111', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);

  // The sheet job — completed, with a composite image on disk.
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
     VALUES (?, ?, '11111111-1111-1111-1111-111111111111', 'ui_sheet', 'a sheet', 'complete', ?, 1000, 1000, '{"pieces":[{}]}')`
  ).run(SHEET_JOB_ID, STYLE_ID, COMPOSITE_FILENAME);

  const compositePath = path.join(tempRoot, 'storage', 'images', COMPOSITE_FILENAME);
  await fsPromises.writeFile(compositePath, 'fake-png-bytes');

  // A split-child asset produced from that sheet — its own image_path,
  // NOT the composite's filename, but source_job_id points back at the job.
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id)
     VALUES (?, ?, '11111111-1111-1111-1111-111111111111', 'button', 'Inventory', 'split-inventory.png', 1000, 0, ?)`
  ).run(CHILD_ASSET_ID, STYLE_ID, SHEET_JOB_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('DELETE /api/jobs/[id] refuses to discard a sheet job with split children', () => {
  it('returns 409, leaves the job row intact, and never removes the composite file', async () => {
    const compositePath = path.join(tempRoot, 'storage', 'images', COMPOSITE_FILENAME);

    const res = await deleteJob(deleteRequest(), { params: Promise.resolve({ id: SHEET_JOB_ID }) });
    const body = await jsonOf(res);

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);

    const db = DatabaseConnection.getInstance();
    const jobRow = db.prepare('SELECT id FROM jobs WHERE id = ?').get(SHEET_JOB_ID);
    expect(jobRow).toBeDefined(); // job row still exists — not deleted

    await expect(fsPromises.access(compositePath)).resolves.not.toThrow(); // file never removed
  });

  it('still deletes a sheet job with no split children (the ordinary path is unaffected)', async () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('DELETE FROM assets WHERE id = ?').run(CHILD_ASSET_ID);

    const compositePath = path.join(tempRoot, 'storage', 'images', COMPOSITE_FILENAME);
    const res = await deleteJob(deleteRequest(), { params: Promise.resolve({ id: SHEET_JOB_ID }) });
    const body = await jsonOf(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const jobRow = db.prepare('SELECT id FROM jobs WHERE id = ?').get(SHEET_JOB_ID);
    expect(jobRow).toBeUndefined(); // job row deleted

    await expect(fsPromises.access(compositePath)).rejects.toThrow(); // file was removed
  });
});
