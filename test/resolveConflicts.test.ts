import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;
const CONFLICTED_FILE = 'data/assets/asset-conflict-test.json';
const STYLE_ID = '11111111-1111-1111-1111-111111111111';
const ASSET_ID = '22222222-2222-2222-2222-222222222222';

function assetJson(note: string) {
  return JSON.stringify({
    id: ASSET_ID,
    style_id: STYLE_ID,
    created_by: 'user-1',
    asset_type: 'sprite',
    prompt: note,
    image_path: null,
    created_at: 1000,
    is_deleted: 0,
    source_job_id: null,
    nine_slice_margins: null,
    states: '[]',
  });
}

async function setupConflictedRepo(): Promise<void> {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-resolve-'));

  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'styles'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'assets'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

  // DatabaseConnection resolves migrations relative to getProjectRoot(),
  // so the temp project needs its own copy of the real migration files.
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

  const filePath = path.join(tempRoot, CONFLICTED_FILE);
  await fsPromises.writeFile(filePath, assetJson('base'));
  await git.add('.');
  await git.commit('base commit');

  await git.checkoutLocalBranch('feature');
  await fsPromises.writeFile(filePath, assetJson('from feature branch'));
  await git.add(CONFLICTED_FILE);
  await git.commit('feature change');

  await git.checkout('master').catch(() => git.checkout('main'));
  await fsPromises.writeFile(filePath, assetJson('from main branch'));
  await git.add(CONFLICTED_FILE);
  await git.commit('main change');

  // This merge fails and leaves conflict markers in CONFLICTED_FILE.
  await git.merge(['feature']).catch(() => {
    // simple-git rejects on a conflicted merge — that's expected here.
  });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  // Force migrations to run against the temp project's own data.db.
  const db = DatabaseConnection.getInstance();
  // The conflicted asset's style_id must satisfy the FK constraint
  // (foreign_keys = ON) once importFromJson() runs post-resolution.
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
}

beforeEach(async () => {
  await setupConflictedRepo();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GitService.resolveConflicts()', () => {
  it('refuses to commit when conflict markers are still present in the resolved files', async () => {
    const filePath = path.join(tempRoot, CONFLICTED_FILE);
    const beforeContent = await fsPromises.readFile(filePath, 'utf-8');
    expect(beforeContent).toMatch(/<<<<<<</);

    const git = simpleGit(tempRoot);
    const logBefore = await git.log();

    await expect(gitService.resolveConflicts()).rejects.toThrow(/conflict markers/i);

    // Nothing should have been committed — same HEAD, same commit count.
    const logAfter = await git.log();
    expect(logAfter.latest?.hash).toBe(logBefore.latest?.hash);
    expect(logAfter.total).toBe(logBefore.total);

    // The merge should still be in progress (MERGE_HEAD still exists).
    expect(fs.existsSync(path.join(tempRoot, '.git', 'MERGE_HEAD'))).toBe(true);

    // The file on disk must be untouched — still carrying the markers.
    const afterContent = await fsPromises.readFile(filePath, 'utf-8');
    expect(afterContent).toBe(beforeContent);
  });

  it('commits successfully once conflict markers are actually removed', async () => {
    const filePath = path.join(tempRoot, CONFLICTED_FILE);
    // Simulate the user resolving the conflict by hand.
    await fsPromises.writeFile(filePath, assetJson('resolved by user'));

    const git = simpleGit(tempRoot);
    const logBefore = await git.log();

    await expect(gitService.resolveConflicts()).resolves.not.toThrow();

    const logAfter = await git.log();
    // A merge commit also pulls the other branch's prior commit into
    // reachable history, so this isn't simply +1 — just confirm growth
    // and that the new tip is the resolution commit itself.
    expect(logAfter.total).toBeGreaterThan(logBefore.total);
    expect(logAfter.latest?.message).toBe('Resolved merge conflicts');
    expect(fs.existsSync(path.join(tempRoot, '.git', 'MERGE_HEAD'))).toBe(false);
  });
});
