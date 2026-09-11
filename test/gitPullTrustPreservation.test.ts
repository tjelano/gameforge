// test/gitPullTrustPreservation.test.ts
//
// importFromJson() force-resets edited_externally to 0 on every asset it
// imports (a git pull must never be able to grant "serve this unsanitized"
// trust). pull() re-imports EVERYTHING as part of its normal flow, so without
// the trust-preservation pass a routine pull would silently un-trust this
// machine's own untouched components too. These tests drive a real two-repo
// pull — bare remote + a second clone acting as another machine — and assert
// trust survives exactly when the component file's bytes did not change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;
let bareRemote: string;
let cloneDirs: string[] = [];

const STYLE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TRUSTED_ASSET_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_ASSET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const HOSTILE_ASSET_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TRUSTED_FILE = 'trusted-card.html';
const LOCAL_TRUSTED_CONTENT = '<div class="card">hand-reviewed locally</div>\n';

function assetJson(overrides: Record<string, unknown>) {
  return JSON.stringify({
    style_id: STYLE_ID,
    created_by: 'user-1',
    asset_type: 'card',
    prompt: 'a card',
    created_at: 1000,
    is_deleted: 0,
    source_job_id: null,
    nine_slice_margins: null,
    states: '[]',
    output_kind: 'component',
    ...overrides,
  }, null, 2);
}

async function setupTrustedRepoAndRemote(): Promise<void> {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pulltrust-'));
  bareRemote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pulltrust-remote-'));

  await simpleGit(bareRemote).init(['--bare']);

  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'styles'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'assets'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });

  // DatabaseConnection resolves migrations relative to getProjectRoot().
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
  await git.addRemote('origin', bareRemote);

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);

  // A component this machine hand-edited and marked trusted (edited_externally
  // is only ever set locally, via PATCH /api/assets/[id]/component).
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', TRUSTED_FILE), LOCAL_TRUSTED_CONTENT);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind, edited_externally)
     VALUES (?, ?, 'user-1', 'card', 'a card', ?, 1000, 0, 'component', 1)`
  ).run(TRUSTED_ASSET_ID, STYLE_ID, TRUSTED_FILE);

  // Publish this state so the remote (and the clones below) share it.
  const pushResult = await gitService.push();
  expect(pushResult.success).toBe(true);
}

/** Another machine clones the same remote, changes something, and pushes. */
async function pushFromOtherMachine(mutate: (cloneDir: string) => Promise<void>): Promise<void> {
  const cloneDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pulltrust-clone-'));
  cloneDirs.push(cloneDir);
  await simpleGit().clone(bareRemote, cloneDir);
  const git = simpleGit(cloneDir);
  await git.addConfig('user.name', 'Other Machine');
  await git.addConfig('user.email', 'other@example.com');
  await mutate(cloneDir);
  await git.add('.');
  await git.commit('change from another machine');
  await git.push();
}

function editedExternallyOf(assetId: string): number {
  const db = DatabaseConnection.getInstance();
  const row = db.prepare('SELECT edited_externally FROM assets WHERE id = ?').get(assetId) as any;
  return row?.edited_externally;
}

beforeEach(async () => {
  cloneDirs = [];
  await setupTrustedRepoAndRemote();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  for (const dir of [tempRoot, bareRemote, ...cloneDirs]) {
    if (dir) await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('GitService.pull() preserves local component trust only for byte-identical files', () => {
  it('keeps edited_externally = 1 when the pull does not touch the trusted component file', async () => {
    await pushFromOtherMachine(async (cloneDir) => {
      await fsPromises.writeFile(
        path.join(cloneDir, 'data', 'assets', `asset-${OTHER_ASSET_ID}.json`),
        assetJson({ id: OTHER_ASSET_ID, image_path: 'unrelated.html', prompt: 'unrelated' })
      );
    });

    const result = await gitService.pull();
    expect(result.success).toBe(true);

    // The pull really did bring something in, and really did leave the
    // trusted file alone.
    expect(editedExternallyOf(OTHER_ASSET_ID)).toBe(0);
    const onDisk = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', TRUSTED_FILE), 'utf-8');
    expect(onDisk).toBe(LOCAL_TRUSTED_CONTENT);

    expect(editedExternallyOf(TRUSTED_ASSET_ID)).toBe(1);
  });

  it('drops edited_externally to 0 when the pull replaces the trusted component file content', async () => {
    const REMOTE_CONTENT = '<div class="card" onclick="steal()">from the remote</div>\n';
    await pushFromOtherMachine(async (cloneDir) => {
      await fsPromises.writeFile(path.join(cloneDir, 'storage', 'components', TRUSTED_FILE), REMOTE_CONTENT);
    });

    const result = await gitService.pull();
    expect(result.success).toBe(true);

    // The pull really did overwrite the file, so the local trust decision no
    // longer applies to this content — it must be re-reviewed.
    const onDisk = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', TRUSTED_FILE), 'utf-8');
    expect(onDisk).not.toBe(LOCAL_TRUSTED_CONTENT);
    expect(onDisk).toContain('from the remote');

    expect(editedExternallyOf(TRUSTED_ASSET_ID)).toBe(0);
  });

  it('still refuses to grant trust to an incoming asset that merely claims edited_externally = 1', async () => {
    await pushFromOtherMachine(async (cloneDir) => {
      await fsPromises.writeFile(path.join(cloneDir, 'storage', 'components', 'hostile.html'), '<img src=x onerror=alert(1)>\n');
      await fsPromises.writeFile(
        path.join(cloneDir, 'data', 'assets', `asset-${HOSTILE_ASSET_ID}.json`),
        assetJson({ id: HOSTILE_ASSET_ID, image_path: 'hostile.html', prompt: 'hostile', edited_externally: 1 })
      );
    });

    const result = await gitService.pull();
    expect(result.success).toBe(true);

    // Trust is never granted by sync, and the preservation pass must not
    // launder it either: this row was not trusted locally before the pull.
    expect(editedExternallyOf(HOSTILE_ASSET_ID)).toBe(0);
    // ...while the genuinely-local trust is still intact.
    expect(editedExternallyOf(TRUSTED_ASSET_ID)).toBe(1);
  });

  it('still restores trust for an untouched component even when importFromJson() throws partway through', async () => {
    // importFromJson() processes data/users, then data/styles, then
    // data/assets, then data/presets, then data/pages, in that fixed order
    // (see GitService.importFromJson()). Putting the unparseable file in
    // data/presets guarantees the entire data/assets pass - including this
    // machine's own trusted asset, force-reset to edited_externally = 0 as
    // part of that pass - completes before the throw, regardless of
    // filesystem readdir ordering within any one directory.
    await pushFromOtherMachine(async (cloneDir) => {
      await fsPromises.mkdir(path.join(cloneDir, 'data', 'presets'), { recursive: true });
      await fsPromises.writeFile(
        path.join(cloneDir, 'data', 'presets', 'preset-broken.json'),
        '{ not valid json'
      );
    });

    await expect(gitService.pull()).rejects.toThrow();

    // The trusted file's bytes were never touched by this pull, so despite
    // the overall pull failing, trust must still have been restored.
    const onDisk = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', TRUSTED_FILE), 'utf-8');
    expect(onDisk).toBe(LOCAL_TRUSTED_CONTENT);
    expect(editedExternallyOf(TRUSTED_ASSET_ID)).toBe(1);
  });
});
