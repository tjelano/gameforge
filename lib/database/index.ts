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

    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
    ).get();

    if (!tableCheck) {
      db.exec(`
        CREATE TABLE migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);
    }

    const applied = db.prepare('SELECT name FROM migrations').all() as { name: string }[];
    const appliedNames = new Set(applied.map(m => m.name));

    for (const file of files) {
      if (!appliedNames.has(file)) {
        console.log(`📦 Running migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

        const applyMigration = db.transaction(() => {
          db.exec(sql);
          db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')
            .run(file, Date.now());
        });

        try {
          applyMigration();
          console.log(`✅ Migration complete: ${file}`);
        } catch (error) {
          console.error(`❌ Migration failed: ${file}`, error);
          throw error;
        }
      }
    }
  }
}
