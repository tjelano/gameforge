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

function insertJob(id: string, styleId: string) {
  db.prepare(
    `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
     VALUES (?, ?, 'user-1', 'ui_sheet', 'a sheet', 'complete', 'sheet.png', 1000, 1000, '{}')`
  ).run(id, styleId);
}

describe('migration 006: source_job_id, nine_slice_margins, states on assets', () => {
  it('adds the three new columns with correct defaults', () => {
    const cols = db.prepare('PRAGMA table_info(assets)').all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain('source_job_id');
    expect(names).toContain('nine_slice_margins');
    expect(names).toContain('states');
  });

  it('a normal (non-sheet) asset insert still works unchanged, defaulting states to []', () => {
    insertStyle('style-1');
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
       VALUES ('asset-1', 'style-1', 'user-1', 'sprite', 'a goblin', 'goblin.png', 1000, 0)`
    ).run();

    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get('asset-1') as any;
    expect(row.source_job_id).toBeNull();
    expect(row.nine_slice_margins).toBeNull();
    expect(row.states).toBe('[]');
  });

  it('accepts a source_job_id pointing at a real job, and rejects one pointing nowhere', () => {
    insertStyle('style-1');
    insertJob('job-1', 'style-1');

    expect(() =>
      db.prepare(
        `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id)
         VALUES ('asset-1', 'style-1', 'user-1', 'button', 'Inventory', 'inv.png', 1000, 0, 'job-1')`
      ).run()
    ).not.toThrow();

    expect(() =>
      db.prepare(
        `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id)
         VALUES ('asset-2', 'style-1', 'user-1', 'button', 'Map', 'map.png', 1000, 0, 'no-such-job')`
      ).run()
    ).toThrow();
  });

  it('deleting a job that still has split children fails closed (foreign_keys = ON)', () => {
    insertStyle('style-1');
    insertJob('job-1', 'style-1');
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id)
       VALUES ('asset-1', 'style-1', 'user-1', 'button', 'Inventory', 'inv.png', 1000, 0, 'job-1')`
    ).run();

    expect(() => db.prepare('DELETE FROM jobs WHERE id = ?').run('job-1')).toThrow();
  });
});
