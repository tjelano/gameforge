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
const STYLE_ID = '33333333-3333-3333-3333-333333333333';

async function setupRepoWithRemote(): Promise<void> {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-push-'));
  bareRemote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-remote-'));

  await simpleGit(bareRemote).init(['--bare']);

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
  await git.addRemote('origin', bareRemote);

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
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

describe('GitService.push()', () => {
  it('safety-stops when there are no styles or assets at all', async () => {
    // Override the fixture: wipe the seeded style so both tables are empty.
    const db = DatabaseConnection.getInstance();
    db.prepare('DELETE FROM styles').run();

    const result = await gitService.push();
    expect(result.success).toBe(false);
    expect(result.error).toBe('SAFETY_STOP');
  });

  it('handles the unborn-HEAD case (first push ever) and sets upstream', async () => {
    const result = await gitService.push();
    expect(result).toEqual({ success: true });

    // The bare "remote" should now actually have the branch and commit.
    const remoteGit = simpleGit(bareRemote);
    const branches = await remoteGit.branchLocal();
    expect(branches.all.length).toBeGreaterThan(0);

    const log = await simpleGit(tempRoot).log();
    expect(log.latest?.message).toBe('Sync from GameForge');
  });

  it('detects an already-configured upstream on a second push and does not fail trying to set it again', async () => {
    const first = await gitService.push();
    expect(first.success).toBe(true);

    // Change something so there's a real second commit to push.
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
       VALUES (?, 'second style', 'user-1', '{}', 0, 2000, 2000)`
    ).run('44444444-4444-4444-4444-444444444444');

    const second = await gitService.push();
    expect(second).toEqual({ success: true });

    const remoteGit = simpleGit(bareRemote);
    const log = await remoteGit.log();
    expect(log.total).toBeGreaterThanOrEqual(2);
  });
});
