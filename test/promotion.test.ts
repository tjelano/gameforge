import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { POST as promoteFromJob } from '@/app/api/assets/from-job/route';

let tempRoot: string;
const STYLE_ID = '55555555-5555-5555-5555-555555555555';

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assets/from-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
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
     VALUES (?, ?, 'user-1', 'sprite', 'p', ?, ?, 1000, 1000, '{}')`
  ).run(id, STYLE_ID, status, resultPath);
}

describe('POST /api/assets/from-job (promotion)', () => {
  it('rejects a job with no result_path', async () => {
    insertJob('66666666-6666-6666-6666-666666666666', 'pending', null);
    const res = await promoteFromJob(postRequest({ jobId: '66666666-6666-6666-6666-666666666666' }));
    const body = await jsonOf(res);
    expect(body.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('creates an asset on the first call, and is idempotent on a retried identical call', async () => {
    insertJob('77777777-7777-7777-7777-777777777777', 'complete', 'result-1.png');

    const first = await jsonOf(await promoteFromJob(postRequest({ jobId: '77777777-7777-7777-7777-777777777777' })));
    expect(first.success).toBe(true);
    expect(first.alreadyExists).toBeUndefined();
    const assetId = first.data.id;

    // Simulates a client retry after the first response was lost —
    // the job is now 'promoted', not 'complete'. Must still succeed
    // and return the SAME asset, not error.
    const second = await jsonOf(await promoteFromJob(postRequest({ jobId: '77777777-7777-7777-7777-777777777777' })));
    expect(second.success).toBe(true);
    expect(second.alreadyExists).toBe(true);
    expect(second.data.id).toBe(assetId);

    const db = DatabaseConnection.getInstance();
    const count = db.prepare('SELECT COUNT(*) as c FROM assets WHERE image_path = ?').get('result-1.png') as { c: number };
    expect(count.c).toBe(1); // never duplicated
  });

  it('rejects a job that is still pending/processing/failed/discarded even if it somehow has a stale result_path', async () => {
    insertJob('88888888-8888-8888-8888-888888888888', 'failed', 'stale.png');
    const res = await promoteFromJob(postRequest({ jobId: '88888888-8888-8888-8888-888888888888' }));
    const body = await jsonOf(res);
    expect(body.success).toBe(false);
    expect(res.status).toBe(400);
  });
});
