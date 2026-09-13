import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { POST as promoteFromJob } from '@/app/api/assets/from-job/route';

let tempRoot: string;
let cookieHeader: string;
let ownerId: string;
const STYLE_ID = '55555555-5555-5555-5555-555555555555';

function postRequest(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return new NextRequest('http://localhost/api/assets/from-job', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function jsonOf(res: Response) {
  return res.json();
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-promote-'));
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

  const owner = await userService.create({ name: 'Owner' });
  ownerId = owner.id;
  const { token } = await sessionService.create(ownerId);
  cookieHeader = `session=${token}`;

  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', ?, '{}', 0, 1000, 1000)`
  ).run(STYLE_ID, ownerId);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function insertJob(id: string, status: string, resultPath: string | null) {
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
     VALUES (?, ?, ?, 'sprite', 'p', ?, ?, 1000, 1000, '{}')`
  ).run(id, STYLE_ID, ownerId, status, resultPath);
}

describe('POST /api/assets/from-job (promotion)', () => {
  it('rejects a job with no result_path', async () => {
    insertJob('66666666-6666-6666-6666-666666666666', 'pending', null);
    const res = await promoteFromJob(postRequest({ jobId: '66666666-6666-6666-6666-666666666666' }, cookieHeader));
    const body = await jsonOf(res);
    expect(body.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('creates an asset on the first call, and is idempotent on a retried identical call', async () => {
    insertJob('77777777-7777-7777-7777-777777777777', 'complete', 'result-1.png');

    const first = await jsonOf(await promoteFromJob(postRequest({ jobId: '77777777-7777-7777-7777-777777777777' }, cookieHeader)));
    expect(first.success).toBe(true);
    expect(first.alreadyExists).toBeUndefined();
    const assetId = first.data.id;

    // Simulates a client retry after the first response was lost —
    // the job is now 'promoted', not 'complete'. Must still succeed
    // and return the SAME asset, not error.
    const second = await jsonOf(await promoteFromJob(postRequest({ jobId: '77777777-7777-7777-7777-777777777777' }, cookieHeader)));
    expect(second.success).toBe(true);
    expect(second.alreadyExists).toBe(true);
    expect(second.data.id).toBe(assetId);

    const db = DatabaseConnection.getInstance();
    const count = db.prepare('SELECT COUNT(*) as c FROM assets WHERE image_path = ?').get('result-1.png') as { c: number };
    expect(count.c).toBe(1); // never duplicated
  });

  it('rejects a job that is still pending/processing/failed/discarded even if it somehow has a stale result_path', async () => {
    insertJob('88888888-8888-8888-8888-888888888888', 'failed', 'stale.png');
    const res = await promoteFromJob(postRequest({ jobId: '88888888-8888-8888-8888-888888888888' }, cookieHeader));
    const body = await jsonOf(res);
    expect(body.success).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/assets/from-job — login and ownership', () => {
  it('401s an unauthenticated request (no session cookie)', async () => {
    insertJob('99999999-9999-9999-9999-999999999999', 'complete', 'result-unauth.png');
    const res = await promoteFromJob(postRequest({ jobId: '99999999-9999-9999-9999-999999999999' }));
    const body = await jsonOf(res);
    expect(res.status).toBe(401);
    expect(body.success).toBe(false);

    const db = DatabaseConnection.getInstance();
    const asset = db.prepare('SELECT * FROM assets WHERE image_path = ?').get('result-unauth.png');
    expect(asset).toBeUndefined(); // no asset created
  });

  it('403s a non-owner, non-admin logged-in user, and creates no asset row', async () => {
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const strangerCookie = `session=${token}`;

    const jobId = 'aaaaaaaa-1111-1111-1111-111111111111';
    insertJob(jobId, 'complete', 'result-forbidden.png');

    const res = await promoteFromJob(postRequest({ jobId }, strangerCookie));
    const body = await jsonOf(res);
    expect(res.status).toBe(403);
    expect(body.success).toBe(false);

    const db = DatabaseConnection.getInstance();
    const asset = db.prepare('SELECT * FROM assets WHERE image_path = ?').get('result-forbidden.png');
    expect(asset).toBeUndefined(); // no asset created

    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('complete'); // job untouched
  });

  it('lets the owner promote their own job (happy path unaffected)', async () => {
    const jobId = 'aaaaaaaa-2222-2222-2222-222222222222';
    insertJob(jobId, 'complete', 'result-owner.png');

    const res = await promoteFromJob(postRequest({ jobId }, cookieHeader));
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('lets a non-owner admin promote someone else\'s job', async () => {
    // `Owner` (seeded in beforeEach) was the first user ever created in
    // this test's temp DB, so it is already the admin (see UserService.create).
    // Give the job to a different, non-admin creator and promote it with
    // Owner's session to exercise the admin-override path.
    const otherUser = await userService.create({ name: 'SomeoneElse' });
    const jobId = 'aaaaaaaa-3333-3333-3333-333333333333';
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
       VALUES (?, ?, ?, 'sprite', 'p', 'complete', 'result-admin.png', 1000, 1000, '{}')`
    ).run(jobId, STYLE_ID, otherUser.id);

    const res = await promoteFromJob(postRequest({ jobId }, cookieHeader));
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
