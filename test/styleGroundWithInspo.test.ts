// test/styleGroundWithInspo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-groundinspo-'));
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

describe('styles.ground_with_inspo', () => {
  it('defaults to false (0) for a newly-created style', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    expect(style.ground_with_inspo).toBe(0);
  });

  it('can be toggled on via update()', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const updated = await styleService.update(style.id, userId, { groundWithInspo: true });
    expect('ground_with_inspo' in (updated as any) ? (updated as any).ground_with_inspo : null).toBe(1);
  });
});
