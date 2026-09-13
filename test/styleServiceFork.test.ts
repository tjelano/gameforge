import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-styleforkactive-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('StyleService.getActiveById', () => {
  it('returns the style when active', async () => {
    const style = await styleService.create({ name: 'Active', createdBy: 'user-1', parameters: '{}' });
    expect((await styleService.getActiveById(style.id))?.id).toBe(style.id);
  });

  it('returns null for a soft-deleted style', async () => {
    const style = await styleService.create({ name: 'Gone', createdBy: 'user-1', parameters: '{}' });
    // Note: after Part A Task 5, softDelete() requires (id, requestingUserId) —
    // pass the style's own creator.
    await styleService.softDelete(style.id, 'user-1');
    expect(await styleService.getActiveById(style.id)).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    expect(await styleService.getActiveById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('StyleService.fork', () => {
  it('forks an active style (pre-existing behavior, unchanged)', async () => {
    const original = await styleService.create({ name: 'Original', createdBy: 'user-1', parameters: '{"x":1}' });
    const forked = await styleService.fork(original.id, 'user-2');
    expect('error' in forked).toBe(false);
    if ('error' in forked) return;
    expect(forked.name).toBe('Original (fork)');
    expect(forked.created_by).toBe('user-2');
    expect(forked.forked_from).toBe(original.id);
  });

  it("refuses to fork a soft-deleted style — this is the behavior change: fork() used to call getById(), which happily forked a deleted style", async () => {
    const original = await styleService.create({ name: 'Deleted', createdBy: 'user-1', parameters: '{}' });
    await styleService.softDelete(original.id, 'user-1');

    const result = await styleService.fork(original.id, 'user-2');
    expect(result).toEqual({ error: 'NOT_FOUND' });
  });
});
