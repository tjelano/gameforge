import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-driveauth-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('driveService auth', () => {
  it('isConnected() is false when no refresh token is stored', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    expect(await driveService.isConnected()).toBe(false);
  });

  it('getAuthUrl() includes offline access and forces the consent prompt', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    const url = driveService.getAuthUrl();
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('scope=');
  });

  it('exchangeCodeForTokens() stores the refresh token, making isConnected() true', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    const { OAuth2Client } = await import('google-auth-library');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'a-real-looking-refresh-token', access_token: 'short-lived' },
      res: null,
    } as any);

    await driveService.exchangeCodeForTokens('fake-auth-code');
    expect(await driveService.isConnected()).toBe(true);

    const { settingsService } = await import('@/lib/services/SettingsService');
    const { GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY } = await import('@/lib/config');
    expect(await settingsService.get(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY)).toBe('a-real-looking-refresh-token');
  });
});
