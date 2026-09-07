import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-userservice-'));
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

describe('userService.create', () => {
  it('makes the first-ever user an admin', async () => {
    const alice = await userService.create({ name: 'Alice' });
    expect(alice.is_admin).toBe(1);
  });

  it('does not make the second user an admin', async () => {
    await userService.create({ name: 'Alice' });
    const bob = await userService.create({ name: 'Bob' });
    expect(bob.is_admin).toBe(0);
  });

  it('rejects a duplicate name', async () => {
    await userService.create({ name: 'Alice' });
    await expect(userService.create({ name: 'Alice' })).rejects.toThrow();
  });
});

describe('userService reads', () => {
  it('getAll returns every user, getById/getByName find one', async () => {
    const alice = await userService.create({ name: 'Alice' });
    await userService.create({ name: 'Bob' });

    expect((await userService.getAll()).length).toBe(2);
    expect((await userService.getActiveUsers()).length).toBe(2);
    expect((await userService.getById(alice.id))?.name).toBe('Alice');
    expect((await userService.getByName('Bob'))?.name).toBe('Bob');
    expect(await userService.getById('nonexistent-id')).toBeNull();
    expect(await userService.getByName('Nobody')).toBeNull();
  });
});
