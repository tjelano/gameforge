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
  applyMigration(db, '001_init.sql');
  applyMigration(db, '002_add_is_deleted_to_assets.sql');
  applyMigration(db, '003_add_options_to_jobs.sql');
});

afterEach(() => {
  db.close();
});

function insertStyle(id: string) {
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test-style', 'user-1', '{}', 0, ?, ?)`
  ).run(id, Date.now(), Date.now());
}

function insertAsset(opts: {
  id: string;
  styleId: string;
  imagePath: string | null;
  isDeleted: 0 | 1;
  createdAt: number;
}) {
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'sprite', 'a prompt', ?, ?, ?)`
  ).run(opts.id, opts.styleId, opts.imagePath, opts.createdAt, opts.isDeleted);
}

describe('migration 004: unique constraint + safe dedup', () => {
  it('leaves rows with NULL image_path untouched, even when there are several', () => {
    insertStyle('style-1');
    insertAsset({ id: 'a1', styleId: 'style-1', imagePath: null, isDeleted: 0, createdAt: 100 });
    insertAsset({ id: 'a2', styleId: 'style-1', imagePath: null, isDeleted: 0, createdAt: 200 });
    insertAsset({ id: 'a3', styleId: 'style-1', imagePath: null, isDeleted: 1, createdAt: 300 });

    applyMigration(db, '004_add_unique_constraint_on_assets.sql');

    const remaining = db.prepare('SELECT id FROM assets ORDER BY id').all() as { id: string }[];
    expect(remaining.map(r => r.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('keeps the active row over a soft-deleted row sharing the same image_path, even if the active row is newer', () => {
    insertStyle('style-1');
    // Soft-deleted row created FIRST (would win on created_at alone).
    insertAsset({ id: 'deleted-old', styleId: 'style-1', imagePath: 'shared.png', isDeleted: 1, createdAt: 100 });
    // Active row created LATER, must still win because is_deleted ASC is primary sort key.
    insertAsset({ id: 'active-new', styleId: 'style-1', imagePath: 'shared.png', isDeleted: 0, createdAt: 200 });

    applyMigration(db, '004_add_unique_constraint_on_assets.sql');

    const remaining = db.prepare('SELECT id, is_deleted FROM assets WHERE image_path = ?').all('shared.png') as
      { id: string; is_deleted: number }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('active-new');
    expect(remaining[0].is_deleted).toBe(0);
  });

  it('among rows tied on is_deleted, keeps the earliest created_at', () => {
    insertStyle('style-1');
    insertAsset({ id: 'first', styleId: 'style-1', imagePath: 'dup.png', isDeleted: 0, createdAt: 100 });
    insertAsset({ id: 'second', styleId: 'style-1', imagePath: 'dup.png', isDeleted: 0, createdAt: 200 });
    insertAsset({ id: 'third', styleId: 'style-1', imagePath: 'dup.png', isDeleted: 0, createdAt: 300 });

    applyMigration(db, '004_add_unique_constraint_on_assets.sql');

    const remaining = db.prepare('SELECT id FROM assets WHERE image_path = ?').all('dup.png') as { id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('first');
  });

  it('enforces uniqueness on image_path for inserts made after the migration runs', () => {
    insertStyle('style-1');
    insertAsset({ id: 'only', styleId: 'style-1', imagePath: 'solo.png', isDeleted: 0, createdAt: 100 });

    applyMigration(db, '004_add_unique_constraint_on_assets.sql');

    expect(() => insertAsset({ id: 'dupe', styleId: 'style-1', imagePath: 'solo.png', isDeleted: 0, createdAt: 200 }))
      .toThrow(/UNIQUE constraint failed/);
  });

  it('still allows multiple NULL image_path rows after the unique index exists (SQLite treats NULLs as distinct)', () => {
    insertStyle('style-1');
    insertAsset({ id: 'null-1', styleId: 'style-1', imagePath: null, isDeleted: 0, createdAt: 100 });
    applyMigration(db, '004_add_unique_constraint_on_assets.sql');

    expect(() => insertAsset({ id: 'null-2', styleId: 'style-1', imagePath: null, isDeleted: 0, createdAt: 200 }))
      .not.toThrow();
  });
});
