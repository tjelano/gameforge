// test/gitServiceUsers.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitusers-'));
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

describe('GitService users sync', () => {
  it('exportToJson() writes one JSON file per user under data/users/', async () => {
    const alice = await userService.create({ name: 'Alice' });
    await gitService.exportToJson();
    const filePath = path.join(tempRoot, 'data', 'users', `user-${alice.id}.json`);
    const content = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
    expect(content.name).toBe('Alice');
    expect(content.is_admin).toBe(1);
  });

  it('importFromJson() brings an exported user into a fresh database', async () => {
    const alice = await userService.create({ name: 'Alice' });
    await gitService.exportToJson();

    // Simulate a second machine: fresh DB, same exported data/ directory.
    DatabaseConnection.resetForTests();
    await gitService.importFromJson();

    const imported = await userService.getById(alice.id);
    expect(imported?.name).toBe('Alice');
    expect(imported?.is_admin).toBe(1);
  });

  it('does not export a sessions table into data/', async () => {
    await userService.create({ name: 'Alice' });
    await gitService.exportToJson();
    const dataDir = path.join(tempRoot, 'data');
    const entries = await fsPromises.readdir(dataDir);
    expect(entries).not.toContain('sessions');
  });
});
