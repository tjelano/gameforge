import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;
const ORIGINAL_STYLE_ID = '11111111-1111-1111-1111-111111111111';
const FORKED_STYLE_ID = '22222222-2222-2222-2222-222222222222';
const SHEET_JOB_ID = '33333333-3333-3333-3333-333333333333';
const ASSET_ID = '44444444-4444-4444-4444-444444444444';
// A UUID that is never inserted into the local jobs table — simulates a
// second machine that pulled an asset whose source_job_id refers to a job
// that only ever existed on the machine that created it (jobs are local-only).
const ORPHAN_JOB_ID = '99999999-9999-9999-9999-999999999999';
const ORPHAN_ASSET_ID = '88888888-8888-8888-8888-888888888888';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-importfields-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'styles'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'assets'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  const git = simpleGit(tempRoot);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();

  // Create the original style to satisfy the FOREIGN KEY constraint on jobs.style_id
  db.prepare(`
    INSERT INTO styles (id, name, created_by, parameters, forked_from, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ORIGINAL_STYLE_ID, 'Original', 'user-1', '{}', null, 0, 1000, 1000);

  // Create a job record to satisfy the FOREIGN KEY constraint on assets.source_job_id
  db.prepare(`
    INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(SHEET_JOB_ID, ORIGINAL_STYLE_ID, 'user-1', 'button', 'Inventory', 'pending', 3000, 3000);

  // Write the JSON files importFromJson() will read — this is what a real
  // git pull would have placed there, with every current schema field.
  await fsPromises.writeFile(
    path.join(tempRoot, 'data', 'styles', `style-${ORIGINAL_STYLE_ID}.json`),
    JSON.stringify({
      id: ORIGINAL_STYLE_ID, name: 'Original', created_by: 'user-1', parameters: '{}',
      forked_from: null, is_deleted: 0, created_at: 1000, updated_at: 1000,
    })
  );
  await fsPromises.writeFile(
    path.join(tempRoot, 'data', 'styles', `style-${FORKED_STYLE_ID}.json`),
    JSON.stringify({
      id: FORKED_STYLE_ID, name: 'Fork', created_by: 'user-2', parameters: '{}',
      forked_from: ORIGINAL_STYLE_ID, is_deleted: 0, created_at: 2000, updated_at: 2000,
    })
  );
  await fsPromises.writeFile(
    path.join(tempRoot, 'data', 'assets', `asset-${ASSET_ID}.json`),
    JSON.stringify({
      id: ASSET_ID, style_id: ORIGINAL_STYLE_ID, created_by: 'user-1', asset_type: 'button',
      prompt: 'Inventory', image_path: 'inv.png', created_at: 3000, is_deleted: 0,
      source_job_id: SHEET_JOB_ID,
      nine_slice_margins: JSON.stringify({ top: 4, right: 4, bottom: 4, left: 4 }),
      states: JSON.stringify(['hover', 'pressed']),
    })
  );
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GitService.importFromJson() persists every current schema field, not just the original ones', () => {
  it('persists forked_from on a style', async () => {
    await gitService.importFromJson();
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT forked_from FROM styles WHERE id = ?').get(FORKED_STYLE_ID) as any;
    expect(row.forked_from).toBe(ORIGINAL_STYLE_ID);
  });

  it('persists nine_slice_margins and states on an asset, but never imports source_job_id (machine-local provenance)', async () => {
    await gitService.importFromJson();
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT source_job_id, nine_slice_margins, states FROM assets WHERE id = ?').get(ASSET_ID) as any;
    // source_job_id is intentionally NOT written by importFromJson() (see
    // Critical #1 fix in GitService.ts) — it stays NULL even though the
    // incoming JSON has a source_job_id pointing at a real local job.
    expect(row.source_job_id).toBeNull();
    expect(JSON.parse(row.nine_slice_margins)).toEqual({ top: 4, right: 4, bottom: 4, left: 4 });
    expect(JSON.parse(row.states)).toEqual(['hover', 'pressed']);
  });

  it('imports an asset whose source_job_id points at a job that does not exist locally, without throwing, and lands it as NULL', async () => {
    // Deliberately do NOT insert ORPHAN_JOB_ID into the local jobs table —
    // this is the exact scenario the other fixtures in this file avoid by
    // always pre-inserting the referenced job row first.
    await fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${ORPHAN_ASSET_ID}.json`),
      JSON.stringify({
        id: ORPHAN_ASSET_ID, style_id: ORIGINAL_STYLE_ID, created_by: 'user-1', asset_type: 'button',
        prompt: 'Map', image_path: 'map.png', created_at: 3000, is_deleted: 0,
        source_job_id: ORPHAN_JOB_ID,
        nine_slice_margins: null,
        states: JSON.stringify([]),
      })
    );

    await expect(gitService.importFromJson()).resolves.not.toThrow();

    const db = DatabaseConnection.getInstance();
    const jobRow = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(ORPHAN_JOB_ID);
    expect(jobRow).toBeUndefined(); // confirms this really was the no-local-job case

    const row = db.prepare('SELECT source_job_id FROM assets WHERE id = ?').get(ORPHAN_ASSET_ID) as any;
    expect(row.source_job_id).toBeNull();

    // Also confirms the loop didn't abort partway: the asset that sorts
    // after this one (by filename) still got imported.
    const otherRow = db.prepare('SELECT id FROM assets WHERE id = ?').get(ASSET_ID) as any;
    expect(otherRow).toBeDefined();
  });

  it('updates these fields on a re-import (ON CONFLICT DO UPDATE), not just on first insert', async () => {
    await gitService.importFromJson();

    // Simulate a second pull where the asset's states changed upstream.
    await fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${ASSET_ID}.json`),
      JSON.stringify({
        id: ASSET_ID, style_id: ORIGINAL_STYLE_ID, created_by: 'user-1', asset_type: 'button',
        prompt: 'Inventory', image_path: 'inv.png', created_at: 3000, is_deleted: 0,
        source_job_id: SHEET_JOB_ID,
        nine_slice_margins: JSON.stringify({ top: 4, right: 4, bottom: 4, left: 4 }),
        states: JSON.stringify(['hover', 'pressed', 'disabled']),
      })
    );
    await gitService.importFromJson();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT states FROM assets WHERE id = ?').get(ASSET_ID) as any;
    expect(JSON.parse(row.states)).toEqual(['hover', 'pressed', 'disabled']);
  });
});
