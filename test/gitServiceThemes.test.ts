// test/gitServiceThemes.test.ts
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
const STYLE_ID = '55555555-5555-5555-5555-555555555555';
const THEME_ASSET_ID = '66666666-6666-6666-6666-666666666666';
const OLD_JSON_ASSET_ID = '77777777-7777-7777-7777-777777777777';

async function setupRepoWithRemote(): Promise<void> {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gittheme-'));
  bareRemote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gittheme-remote-'));

  await simpleGit(bareRemote).init(['--bare']);

  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'styles'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'assets'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

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
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
}

beforeEach(async () => {
  await setupRepoWithRemote();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
  if (bareRemote) await fsPromises.rm(bareRemote, { recursive: true, force: true });
});

describe('GitService stages, pushes, and restores theme CSS files', () => {
  it('push() stages and commits a theme asset\'s CSS file under storage/themes/', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'theme-1.css'), ':root { --color-bg: #111; }');
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
       VALUES (?, ?, 'user-1', 'theme', 'x', 'theme-1.css', 1000, 0, 'theme')`
    ).run(THEME_ASSET_ID, STYLE_ID);

    const result = await gitService.push();
    expect(result.success).toBe(true);

    const log = await simpleGit(tempRoot).log();
    const show = await simpleGit(tempRoot).raw(['show', '--stat', log.latest!.hash]);
    expect(show).toContain('storage/themes/theme-1.css');
  });

  it('importFromJson() persists output_kind on a theme asset', async () => {
    await fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${THEME_ASSET_ID}.json`),
      JSON.stringify({
        id: THEME_ASSET_ID, style_id: STYLE_ID, created_by: 'user-1', asset_type: 'theme',
        prompt: 'dark fantasy', image_path: 'theme-1.css', created_at: 1000, is_deleted: 0,
        source_job_id: null, nine_slice_margins: null, states: JSON.stringify([]),
        output_kind: 'theme',
      })
    );

    await gitService.importFromJson();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get(THEME_ASSET_ID) as any;
    expect(row.output_kind).toBe('theme');
  });

  it('importFromJson() defaults output_kind to \'image\' for an old JSON export that predates this field, without throwing', async () => {
    await fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${OLD_JSON_ASSET_ID}.json`),
      JSON.stringify({
        id: OLD_JSON_ASSET_ID, style_id: STYLE_ID, created_by: 'user-1', asset_type: 'sprite',
        prompt: 'a goblin', image_path: 'goblin.png', created_at: 1000, is_deleted: 0,
        source_job_id: null, nine_slice_margins: null, states: JSON.stringify([]),
      })
    );

    await expect(gitService.importFromJson()).resolves.not.toThrow();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get(OLD_JSON_ASSET_ID) as any;
    expect(row.output_kind).toBe('image');
  });

  it('re-importing an asset updates output_kind (ON CONFLICT DO UPDATE), not just on first insert', async () => {
    const write = (outputKind: string) => fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${THEME_ASSET_ID}.json`),
      JSON.stringify({
        id: THEME_ASSET_ID, style_id: STYLE_ID, created_by: 'user-1', asset_type: 'theme',
        prompt: 'x', image_path: 'theme-1.css', created_at: 1000, is_deleted: 0,
        source_job_id: null, nine_slice_margins: null, states: JSON.stringify([]),
        output_kind: outputKind,
      })
    );

    await write('image');
    await gitService.importFromJson();
    await write('theme');
    await gitService.importFromJson();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get(THEME_ASSET_ID) as any;
    expect(row.output_kind).toBe('theme');
  });
});
