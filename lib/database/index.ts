import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

const globalForDb = globalThis as unknown as { db: Database.Database | undefined };

export class DatabaseConnection {
  static getInstance(): Database.Database {
    if (!globalForDb.db) {
      const dbPath = path.join(getProjectRoot(), 'data.db');
      const db = new Database(dbPath);

      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');

      try {
        this.runMigrations(db);
      } catch (error) {
        // Don't leak a locked file handle for a DB we're about to
        // discard — on Windows in particular, an unclosed handle
        // blocks the temp dir it lives in from being deleted.
        db.close();
        throw error;
      }

      globalForDb.db = db;
    }
    return globalForDb.db;
  }

  // Test-only: close and drop the cached singleton so the next
  // getInstance() call opens a fresh file at whatever path
  // getProjectRoot() currently resolves to.
  static resetForTests(): void {
    if (globalForDb.db) {
      globalForDb.db.close();
      globalForDb.db = undefined;
    }
  }

  private static runMigrations(db: Database.Database): void {
    const migrationsDir = path.join(getProjectRoot(), 'lib', 'database', 'migrations');

    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`❌ Migrations directory not found: ${migrationsDir}`);
    }

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    if (files.length === 0) return;

    // Some migrations (e.g. 010) rebuild a table via DROP TABLE + recreate,
    // since SQLite has no ALTER TABLE ... DROP CONSTRAINT. With
    // foreign_keys=ON, DROP TABLE performs an implicit DELETE FROM first --
    // and if another table's row still references the about-to-be-dropped
    // table via a foreign key (e.g. assets.source_job_id -> jobs.id, which
    // is real for any already-shipped UI-sheet split, see
    // app/api/assets/from-crop/route.ts), that implicit delete violates the
    // FK and the whole migration fails. PRAGMA foreign_keys is a no-op
    // inside a transaction, so it can't be toggled from within an
    // individual migration's own SQL -- it has to be disabled here, before
    // the per-file transaction loop starts, and restored after. The
    // PRAGMA foreign_key_check before each COMMIT is the safety net: since
    // enforcement is off for the duration, this manually verifies the
    // migration didn't actually leave any dangling references before we
    // commit that state.
    db.pragma('foreign_keys = OFF');

    try {
      // IF NOT EXISTS makes this safe to run from multiple processes without
      // a pre-check — SQLite serializes writers at the file level, so two
      // concurrent CREATE TABLE IF NOT EXISTS calls are safe in either order.
      db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);

      for (const file of files) {
        try {
          // BEGIN IMMEDIATE acquires SQLite's write lock right away instead
          // of lazily on first write. This closes the race where two
          // processes (the Next.js server and the separate worker process,
          // both calling DatabaseConnection.getInstance() independently on
          // startup) both read "not yet applied" before either commits — the
          // second process to reach BEGIN IMMEDIATE blocks (up to
          // busy_timeout) until the first finishes, then re-checks applied
          // status before deciding. It's inside this try (not before it) so
          // a failure acquiring the lock itself — e.g. busy_timeout
          // exceeded waiting on the other process — is handled by the same
          // path as every other failure below, rather than propagating
          // uncaught from outside the try/catch.
          db.exec('BEGIN IMMEDIATE');
          const alreadyApplied = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(file);
          if (!alreadyApplied) {
            console.log(`📦 Running migration: ${file}`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
            db.exec(sql);

            const violations = db.pragma('foreign_key_check') as unknown[];
            if (violations.length > 0) {
              throw new Error(
                `Migration ${file} left ${violations.length} dangling foreign key reference(s): ${JSON.stringify(violations)}`
              );
            }

            db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
            console.log(`✅ Migration complete: ${file}`);
          }
          db.exec('COMMIT');
        } catch (error) {
          // Only roll back if a transaction is actually open — if BEGIN
          // IMMEDIATE itself is what failed (e.g. lock-wait timeout), there
          // is nothing to roll back, and calling ROLLBACK anyway would throw
          // its own "no transaction is active" error, masking the real one.
          if (db.inTransaction) db.exec('ROLLBACK');
          console.error(`❌ Migration failed: ${file}`, error);
          throw error;
        }
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}
