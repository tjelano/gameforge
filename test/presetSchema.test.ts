// test/presetSchema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { PresetSchema } from '@/lib/database/schema';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetschema-'));
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

describe('presets table + PresetSchema', () => {
  it('accepts a full row with a null theme_prompt', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, 'SaaS Landing', 'user-1', 'minimalist SaaS landing page', '["Tailwind","React"]', NULL, '[{"assetType":"nav bar","prompt":"a nav bar"}]', 0, ?, ?)
    `).run('11111111-1111-1111-1111-111111111111', now, now);

    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get('11111111-1111-1111-1111-111111111111');
    const parsed = PresetSchema.parse(row);
    expect(parsed.theme_prompt).toBeNull();
    expect(JSON.parse(parsed.tech_stack_tags)).toEqual(['Tailwind', 'React']);
    expect(JSON.parse(parsed.components)).toEqual([{ assetType: 'nav bar', prompt: 'a nav bar' }]);
  });

  it('defaults tech_stack_tags and components to empty-array JSON when omitted', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, is_deleted, created_at, updated_at)
      VALUES (?, 'Bare', 'user-1', 'x', 0, ?, ?)
    `).run('22222222-2222-2222-2222-222222222222', now, now);

    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get('22222222-2222-2222-2222-222222222222');
    const parsed = PresetSchema.parse(row);
    expect(JSON.parse(parsed.tech_stack_tags)).toEqual([]);
    expect(JSON.parse(parsed.components)).toEqual([]);
  });
});
