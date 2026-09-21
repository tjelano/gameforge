import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-inspocache-'));
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

describe('inspo_reference_cache table', () => {
  it('enforces UNIQUE(style_id, component_type, accent_hash) via upsert', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const db = DatabaseConnection.getInstance();

    const insert = () => db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (style_id, component_type, accent_hash) DO UPDATE SET image_url = excluded.image_url, fetched_at = excluded.fetched_at
    `).run(crypto.randomUUID(), style.id, 'Button', 'abc123', 'https://inspomcp.dev/api/component/x/1', 0, 1, Date.now());

    insert();
    insert(); // second write with the same key must not throw or duplicate

    const rows = db.prepare('SELECT * FROM inspo_reference_cache WHERE style_id = ?').all(style.id);
    expect(rows).toHaveLength(1);
  });

  it('cascades delete when the owning style is deleted', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
    `).run(crypto.randomUUID(), style.id, 'Button', 'abc123', 'https://inspomcp.dev/api/component/x/1', Date.now());

    db.prepare('DELETE FROM styles WHERE id = ?').run(style.id);

    const rows = db.prepare('SELECT * FROM inspo_reference_cache WHERE style_id = ?').all(style.id);
    expect(rows).toHaveLength(0);
  });
});
