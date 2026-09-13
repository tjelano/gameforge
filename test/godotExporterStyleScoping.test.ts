import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { godotExporter } from '@/lib/services/GodotExporter';

let tempRoot: string;
const STYLE_A = '11111111-1111-1111-1111-111111111111';
const STYLE_B = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-godotscope-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  const imagesDir = path.join(tempRoot, 'storage', 'images');
  await fsPromises.mkdir(imagesDir, { recursive: true });
  await fsPromises.writeFile(path.join(imagesDir, 'goblin-a.png'), 'fake-png-a');
  await fsPromises.writeFile(path.join(imagesDir, 'goblin-b.png'), 'fake-png-b');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style A', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_A);
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style B', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_B);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ?, 'user-1', 'sprite', 'x', 'goblin-a.png', 1000, 0, 'image')`
  ).run(STYLE_A);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', ?, 'user-1', 'sprite', 'x', 'goblin-b.png', 1000, 0, 'image')`
  ).run(STYLE_B);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GodotExporter.exportToGodot() scopes to one style and guards a subdir collision', () => {
  it("exports only the requested style's image, not a sibling style's", async () => {
    const result = await godotExporter.exportToGodot(STYLE_A, 'godot-scope-test');
    if ('error' in result) throw new Error(`Unexpected export error: ${result.error}`);
    expect(result.exported).toBe(1);
    const exportedFiles = await fsPromises.readdir(result.targetDir);
    expect(exportedFiles).toEqual(['goblin-a.png']);
  });

  it('returns ALREADY_EXISTS on a second export to the same subdir', async () => {
    const first = await godotExporter.exportToGodot(STYLE_A, 'godot-collision-test');
    expect('error' in first).toBe(false);

    const second = await godotExporter.exportToGodot(STYLE_B, 'godot-collision-test');
    expect(second).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('returns STYLE_NOT_FOUND for a soft-deleted style, and never claims the export subdir', async () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE styles SET is_deleted = 1 WHERE id = ?').run(STYLE_A);

    const result = await godotExporter.exportToGodot(STYLE_A, 'godot-soft-deleted-test');
    expect(result).toEqual({ error: 'STYLE_NOT_FOUND' });

    // The subdir must not have been claimed by the rejected export - a
    // later, legitimate export to the same name must still succeed.
    const retry = await godotExporter.exportToGodot(STYLE_B, 'godot-soft-deleted-test');
    if ('error' in retry) throw new Error(`Unexpected export error: ${retry.error}`);
    expect(retry.exported).toBe(1);
  });

  it('returns STYLE_NOT_FOUND for a nonexistent style', async () => {
    const result = await godotExporter.exportToGodot('99999999-9999-9999-9999-999999999999', 'godot-missing-style-test');
    expect(result).toEqual({ error: 'STYLE_NOT_FOUND' });
  });
});
