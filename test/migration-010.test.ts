import { describe, it, expect, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

// Migration 010 rebuilds jobs and assets (DROP TABLE + recreate) to widen
// their output_kind CHECK constraint. With foreign_keys=ON, DROP TABLE
// performs an implicit DELETE FROM first -- which fails if any assets row
// still has a non-NULL source_job_id pointing at a job (a real,
// already-shipped shape: see app/api/assets/from-crop/route.ts). This test
// exercises the REAL lib/database/index.ts runMigrations() codepath (not a
// standalone per-file db.exec()) against a DB that already has such a row,
// because that's the only way to actually trigger the bug -- every other
// existing test builds a brand-new DB with all migrations (010 included)
// applied at once against an empty database, which never hits this FK
// violation.
const REAL_MIGRATIONS_DIR = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');

let tempRoot: string;

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('migration 010: widen output_kind CHECK without breaking source_job_id FK', () => {
  it('upgrades an existing DB with a source_job_id-bearing asset, keeps the reference intact, and allows component inserts afterward', async () => {
    tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration010-'));
    await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

    const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
    await fsPromises.mkdir(tempMigrationsDir, { recursive: true });

    const allMigrationFiles = (await fsPromises.readdir(REAL_MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
    const preMigration010Files = allMigrationFiles.filter(f => f < '010');
    const migration010File = allMigrationFiles.find(f => f.startsWith('010'))!;

    // Phase 1: stand up a DB on everything BEFORE 010, matching a real
    // install that hasn't upgraded yet.
    for (const file of preMigration010Files) {
      await fsPromises.copyFile(path.join(REAL_MIGRATIONS_DIR, file), path.join(tempMigrationsDir, file));
    }
    setProjectRootForTests(tempRoot);
    DatabaseConnection.resetForTests();
    let db = DatabaseConnection.getInstance();

    db.prepare(
      `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
       VALUES ('style-1', 'style', 'user-1', '{}', 0, 1000, 1000)`
    ).run();
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
       VALUES ('job-1', 'style-1', 'user-1', 'ui_sheet', 'a sheet', 'complete', 'sheet.png', 1000, 1000, '{}')`
    ).run();
    // Real shape: an asset split off a UI sheet job, referencing it via
    // source_job_id (app/api/assets/from-crop/route.ts).
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id)
       VALUES ('asset-1', 'style-1', 'user-1', 'ui_element', 'Inventory', 'inv.png', 1000, 0, 'job-1')`
    ).run();

    // Close the connection but keep the on-disk data.db so phase 2 reopens
    // the same file with the seeded data still present.
    DatabaseConnection.resetForTests();

    // Phase 2: "upgrade" by dropping migration 010 into place and
    // reopening -- this is what actually runs runMigrations() against a
    // populated DB and is where the bug lived.
    await fsPromises.copyFile(path.join(REAL_MIGRATIONS_DIR, migration010File), path.join(tempMigrationsDir, migration010File));

    expect(() => {
      db = DatabaseConnection.getInstance();
    }).not.toThrow();

    const asset = db.prepare('SELECT source_job_id FROM assets WHERE id = ?').get('asset-1') as { source_job_id: string };
    expect(asset.source_job_id).toBe('job-1');

    expect(() => {
      db.prepare(
        `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
         VALUES ('job-2', 'style-1', 'user-1', 'component', 'a button', 'pending', NULL, 2000, 2000, '{}', 'component')`
      ).run();
    }).not.toThrow();

    expect(() => {
      db.prepare(
        `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
         VALUES ('asset-2', 'style-1', 'user-1', 'component', 'a button', 'button.html', 2000, 0, 'component')`
      ).run();
    }).not.toThrow();
  });
});
