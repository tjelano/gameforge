// test/godotExporterSkipsThemes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { godotExporter } from '@/lib/services/GodotExporter';

let tempRoot: string;
const STYLE_ID = '88888888-8888-8888-8888-888888888888';
const IMAGE_ASSET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THEME_ASSET_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-godottheme-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  const imagesDir = path.join(tempRoot, 'storage', 'images');
  await fsPromises.mkdir(imagesDir, { recursive: true });
  await fsPromises.writeFile(path.join(imagesDir, 'goblin.png'), 'fake-png');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES (?, ?, 'user-1', 'sprite', 'x', 'goblin.png', 1000, 0, 'image')`
  ).run(IMAGE_ASSET_ID, STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES (?, ?, 'user-1', 'theme', 'x', 'theme-1.css', 1000, 0, 'theme')`
  ).run(THEME_ASSET_ID, STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GodotExporter.exportToGodot() skips theme assets', () => {
  it('exports only the image asset', async () => {
    const result = await godotExporter.exportToGodot(STYLE_ID, 'godot-test');
    if ('error' in result) throw new Error(`Unexpected export error: ${result.error}`);
    expect(result.exported).toBe(1);
    expect(result.skipped).toBe(0);

    const exportedFiles = await fsPromises.readdir(result.targetDir);
    expect(exportedFiles).toEqual(['goblin.png']);
  });
});
