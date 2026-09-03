import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;
const STYLE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OLD_SHEET_JOB_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OLD_ORDINARY_JOB_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const ONE_HOUR_MS = 60 * 60 * 1000;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-getactive-'));
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

function insertJob(id: string, opts: { status: string; updatedAt: number; options: string }) {
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
     VALUES (?, ?, 'user-1', 'ui_sheet', 'a sheet', ?, 'sheet.png', 1000, ?, ?)`
  ).run(id, STYLE_ID, opts.status, opts.updatedAt, opts.options);
}

describe('JobService.getActive()', () => {
  it('keeps a completed UI-sheet job (non-empty options.pieces) reachable well outside the 5-minute window', async () => {
    insertJob(OLD_SHEET_JOB_ID, {
      status: 'complete',
      updatedAt: Date.now() - ONE_HOUR_MS,
      options: JSON.stringify({ pieces: [{ id: 'a', kind: 'rounded_rect', label: 'x', x: 0, y: 0, w: 10, h: 10 }], imageSize: { width: 256, height: 256 } }),
    });

    const active = await jobService.getActive();
    expect(active.map(j => j.id)).toContain(OLD_SHEET_JOB_ID);
  });

  it('still excludes an ordinary completed job (no pieces in options) once outside the 5-minute window — pre-existing behavior unchanged', async () => {
    insertJob(OLD_ORDINARY_JOB_ID, {
      status: 'complete',
      updatedAt: Date.now() - ONE_HOUR_MS,
      options: JSON.stringify({}),
    });

    const active = await jobService.getActive();
    expect(active.map(j => j.id)).not.toContain(OLD_ORDINARY_JOB_ID);
  });

  it('excludes an old completed job with an empty pieces array (not a real sheet job)', async () => {
    insertJob(OLD_ORDINARY_JOB_ID, {
      status: 'complete',
      updatedAt: Date.now() - ONE_HOUR_MS,
      options: JSON.stringify({ pieces: [] }),
    });

    const active = await jobService.getActive();
    expect(active.map(j => j.id)).not.toContain(OLD_ORDINARY_JOB_ID);
  });

  it('does not throw when an old job has a non-array, non-object pieces value (options is unvalidated at the /api/generate boundary)', async () => {
    insertJob(OLD_ORDINARY_JOB_ID, {
      status: 'complete',
      updatedAt: Date.now() - ONE_HOUR_MS,
      options: JSON.stringify({ pieces: 'oops, a bare string' }),
    });

    const active = await jobService.getActive();
    expect(active.map(j => j.id)).not.toContain(OLD_ORDINARY_JOB_ID);
  });
});
