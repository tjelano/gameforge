import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');

function applyMigration(db: Database.Database, filename: string) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf-8');
  db.exec(sql);
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of [
    '001_init.sql',
    '002_add_is_deleted_to_assets.sql',
    '003_add_options_to_jobs.sql',
    '004_add_unique_constraint_on_assets.sql',
    '005_add_forked_from_to_styles.sql',
    '006_add_ui_sheet_columns_to_assets.sql',
    '007_add_settings_table.sql',
    '008_add_output_kind.sql',
  ]) {
    applyMigration(db, file);
  }
});

afterEach(() => {
  db.close();
});

function insertStyle(id: string) {
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(id);
}

describe('migration 008: output_kind on jobs and assets', () => {
  it('adds output_kind to both tables', () => {
    const jobCols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(c => c.name);
    const assetCols = (db.prepare('PRAGMA table_info(assets)').all() as { name: string }[]).map(c => c.name);
    expect(jobCols).toContain('output_kind');
    expect(assetCols).toContain('output_kind');
  });

  it('defaults existing-shape inserts to \'image\' on both tables', () => {
    insertStyle('style-1');
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
       VALUES ('job-1', 'style-1', 'user-1', 'sprite', 'a goblin', 'pending', NULL, 1000, 1000, '{}')`
    ).run();
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
       VALUES ('asset-1', 'style-1', 'user-1', 'sprite', 'a goblin', 'goblin.png', 1000, 0)`
    ).run();

    const job = db.prepare('SELECT output_kind FROM jobs WHERE id = ?').get('job-1') as any;
    const asset = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get('asset-1') as any;
    expect(job.output_kind).toBe('image');
    expect(asset.output_kind).toBe('image');
  });

  it('accepts an explicit \'theme\' value on both tables', () => {
    insertStyle('style-1');
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES ('job-2', 'style-1', 'user-1', 'theme', 'dark fantasy', 'pending', NULL, 1000, 1000, '{}', 'theme')`
    ).run();
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
       VALUES ('asset-2', 'style-1', 'user-1', 'theme', 'dark fantasy', 'theme.css', 1000, 0, 'theme')`
    ).run();

    const job = db.prepare('SELECT output_kind FROM jobs WHERE id = ?').get('job-2') as any;
    const asset = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get('asset-2') as any;
    expect(job.output_kind).toBe('theme');
    expect(asset.output_kind).toBe('theme');
  });

  it('rejects an invalid output_kind value on jobs via the CHECK constraint', () => {
    insertStyle('style-1');
    expect(() => {
      db.prepare(
        `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
         VALUES ('job-bad', 'style-1', 'user-1', 'x', 'x', 'pending', NULL, 1000, 1000, '{}', 'bogus')`
      ).run();
    }).toThrow(/CHECK/);
  });

  it('rejects an invalid output_kind value on assets via the CHECK constraint', () => {
    insertStyle('style-1');
    expect(() => {
      db.prepare(
        `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
         VALUES ('asset-bad', 'style-1', 'user-1', 'x', 'x', 'x.png', 1000, 0, 'bogus')`
      ).run();
    }).toThrow(/CHECK/);
  });
});
