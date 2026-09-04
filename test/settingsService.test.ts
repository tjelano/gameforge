import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { settingsService } from '@/lib/services/SettingsService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-settings-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

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

describe('SettingsService', () => {
  it('returns null for a key that was never set', async () => {
    expect(await settingsService.get('aseprite_path')).toBeNull();
  });

  it('set() then get() round-trips the value', async () => {
    await settingsService.set('aseprite_path', 'C:\\Aseprite\\Aseprite.exe');
    expect(await settingsService.get('aseprite_path')).toBe('C:\\Aseprite\\Aseprite.exe');
  });

  it('set() called twice on the same key upserts rather than throwing', async () => {
    await settingsService.set('aseprite_path', 'C:\\first\\path.exe');
    await settingsService.set('aseprite_path', 'C:\\second\\path.exe');
    expect(await settingsService.get('aseprite_path')).toBe('C:\\second\\path.exe');
  });

  it('keys are independent of each other', async () => {
    await settingsService.set('aseprite_path', 'C:\\a.exe');
    expect(await settingsService.get('some_other_key')).toBeNull();
  });
});
