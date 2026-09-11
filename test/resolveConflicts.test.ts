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
// A component this machine hand-edited and marked trusted, committed on the
// base commit so it is tracked and NOT part of the conflict below.
const TRUSTED_ASSET_ID = '33333333-3333-3333-3333-333333333333';
const TRUSTED_FILE = 'trusted-card.html';
const TRUSTED_COMPONENT_PATH = `storage/components/${TRUSTED_FILE}`;
const LOCAL_TRUSTED_CONTENT = '<div class="card">hand-reviewed locally</div>\n';

function trustedAssetJson() {
  return JSON.stringify({
    id: TRUSTED_ASSET_ID,
    style_id: STYLE_ID,
    created_by: 'user-1',
    asset_type: 'card',
    prompt: 'a card',
    image_path: TRUSTED_FILE,
    created_at: 1000,
    is_deleted: 0,
    source_job_id: null,
    nine_slice_margins: null,
    states: '[]',
    output_kind: 'component',
    // What exportToJson() writes for a locally-trusted component. importFromJson()
    // still forces this to 0 — trust is never granted by sync.
    edited_externally: 1,
  }, null, 2);
}

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
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });

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
  await fsPromises.writeFile(path.join(tempRoot, TRUSTED_COMPONENT_PATH), LOCAL_TRUSTED_CONTENT);
  await fsPromises.writeFile(
    path.join(tempRoot, 'data', 'assets', `asset-${TRUSTED_ASSET_ID}.json`),
    trustedAssetJson()
  );
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
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind, edited_externally)
     VALUES (?, ?, 'user-1', 'card', 'a card', ?, 1000, 0, 'component', 1)`
  ).run(TRUSTED_ASSET_ID, STYLE_ID, TRUSTED_FILE);
}

function editedExternallyOfTrustedAsset(): number {
  const db = DatabaseConnection.getInstance();
  const row = db.prepare('SELECT edited_externally FROM assets WHERE id = ?').get(TRUSTED_ASSET_ID) as any;
  return row?.edited_externally;
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

  // resolveConflicts() re-imports every JSON file, and importFromJson() force-sets
  // edited_externally = 0 on all of them. Without the trust-preservation pass, just
  // resolving an unrelated conflict would silently un-trust this machine's own
  // untouched components.
  it('keeps edited_externally = 1 for a trusted component the merge never touched', async () => {
    // The user resolves the (unrelated) asset JSON conflict by hand.
    await fsPromises.writeFile(path.join(tempRoot, CONFLICTED_FILE), assetJson('resolved by user'));
    expect(editedExternallyOfTrustedAsset()).toBe(1);

    await gitService.resolveConflicts();

    const onDisk = await fsPromises.readFile(path.join(tempRoot, TRUSTED_COMPONENT_PATH), 'utf-8');
    expect(onDisk).toBe(LOCAL_TRUSTED_CONTENT);
    expect(editedExternallyOfTrustedAsset()).toBe(1);
  });

  it('drops edited_externally to 0 when the merge changed the trusted component file', async () => {
    await fsPromises.writeFile(path.join(tempRoot, CONFLICTED_FILE), assetJson('resolved by user'));

    // What a merge that carried an incoming change to this component looks like at
    // resolveConflicts() entry: new content in the working tree, staged in the index.
    await fsPromises.writeFile(
      path.join(tempRoot, TRUSTED_COMPONENT_PATH),
      '<div class="card" onclick="steal()">from the other branch</div>\n'
    );
    await simpleGit(tempRoot).add(TRUSTED_COMPONENT_PATH);

    await gitService.resolveConflicts();

    // The reviewed bytes are gone, so the local trust decision no longer applies.
    expect(editedExternallyOfTrustedAsset()).toBe(0);
  });
});
