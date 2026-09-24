import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { settingsService } from '@/lib/services/SettingsService';
import { WORKER_LAST_SEEN_SETTING_KEY } from '@/lib/config';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workerstatus-'));
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

describe('GET /api/dashboard/worker-status', () => {
  it('reports alive:true when the heartbeat is fresh', async () => {
    await settingsService.set(WORKER_LAST_SEEN_SETTING_KEY, String(Date.now()));

    const { GET } = await import('@/app/api/dashboard/worker-status/route');
    const res = await GET();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.alive).toBe(true);
  });

  it('reports alive:false when the heartbeat is stale', async () => {
    await settingsService.set(WORKER_LAST_SEEN_SETTING_KEY, String(Date.now() - 60_000));

    const { GET } = await import('@/app/api/dashboard/worker-status/route');
    const res = await GET();
    const body = await res.json();

    expect(body.data.alive).toBe(false);
  });

  it('reports alive:false when no heartbeat has ever been written', async () => {
    const { GET } = await import('@/app/api/dashboard/worker-status/route');
    const res = await GET();
    const body = await res.json();

    expect(body.data.alive).toBe(false);
  });
});
