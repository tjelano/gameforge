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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-inspogrounding-'));
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

describe('hashAccentColor', () => {
  it('is deterministic and differs for different colors', async () => {
    const { hashAccentColor } = await import('@/lib/services/inspoGrounding');
    expect(hashAccentColor('#3b82f6')).toBe(hashAccentColor('#3b82f6'));
    expect(hashAccentColor('#3b82f6')).not.toBe(hashAccentColor('#ef4444'));
  });
});

describe('resolveAndValidateUrl', () => {
  const originalEnv = process.env.INSPO_BASE_URL;
  beforeEach(() => { process.env.INSPO_BASE_URL = 'https://inspo.test'; });
  afterEach(() => { process.env.INSPO_BASE_URL = originalEnv; });

  it('resolves a relative path against INSPO_BASE_URL', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('/api/component/acme-corp/1')).toBe('https://inspo.test/api/component/acme-corp/1');
  });

  it('accepts an already-absolute same-origin URL', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('https://inspo.test/api/component/acme-corp/1')).toBe('https://inspo.test/api/component/acme-corp/1');
  });

  it('rejects a cross-origin absolute URL', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('https://evil.example/steal.png')).toBeNull();
  });

  it('rejects a non-http(s) scheme', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('lookupCachedReference', () => {
  it('returns null on a cache miss', async () => {
    const { lookupCachedReference } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    expect(lookupCachedReference(style.id, 'Button', 'abc123')).toBeNull();
  });

  it('returns the cached row when present and fresh', async () => {
    const { lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const hash = hashAccentColor('#3b82f6');
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
    `).run('11111111-1111-1111-1111-111111111111', style.id, 'Button', hash, 'https://inspomcp.dev/api/component/x/1', Date.now());

    const found = lookupCachedReference(style.id, 'Button', hash);
    expect(found?.image_url).toBe('https://inspomcp.dev/api/component/x/1');
  });

  it('returns null for a stale (expired-TTL) row', async () => {
    const { lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const hash = hashAccentColor('#3b82f6');
    const db = DatabaseConnection.getInstance();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
    `).run('22222222-2222-2222-2222-222222222222', style.id, 'Button', hash, 'https://inspomcp.dev/api/component/x/1', eightDaysAgo);

    expect(lookupCachedReference(style.id, 'Button', hash)).toBeNull();
  });
});
