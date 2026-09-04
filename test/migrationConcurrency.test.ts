import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migrationrace-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
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

describe('DatabaseConnection migration runner idempotency', () => {
  it('re-opening the same database file does not re-apply or fail on already-applied migrations', () => {
    // First "process": runs every migration normally via the singleton.
    const db1 = DatabaseConnection.getInstance();
    const appliedCount = (db1.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number }).c;
    expect(appliedCount).toBeGreaterThan(0);

    // Simulate a second process opening the SAME underlying file fresh
    // (resetForTests() closes the cached connection; getInstance() then
    // re-opens the same data.db path and re-runs the migration runner
    // against it from scratch) — this is the code path that must not
    // throw or duplicate rows when every migration is already applied,
    // which is exactly the state a second real process finds itself in
    // after the first process wins the race.
    DatabaseConnection.resetForTests();
    const db2 = DatabaseConnection.getInstance();
    const appliedCount2 = (db2.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number }).c;
    expect(appliedCount2).toBe(appliedCount);
  });
});

describe('BEGIN IMMEDIATE + busy_timeout lock contention', () => {
  it('a second connection blocks (per busy_timeout) rather than erroring immediately while the first holds the lock', () => {
    // This proves the specific locking primitive the migration-runner fix
    // depends on: does BEGIN IMMEDIATE + busy_timeout genuinely make a
    // second writer wait, rather than fail instantly? It does NOT, on its
    // own, prove the full end-to-end migration race is closed — that
    // additionally depends on the re-check-inside-the-lock logic in
    // runMigrations() being correct, which is established by code
    // inspection (the refactor above) plus the idempotency test in the
    // previous describe block. This test is supporting evidence for one
    // real mechanism the fix relies on, not a substitute for reasoning
    // through the whole fix.
    //
    // Two real, separate better-sqlite3 connections to the SAME file
    // exercise SQLite's actual file-level locking — this doesn't require
    // two separate OS processes, since SQLite's locking is
    // per-connection/per-file-handle, identical whether those handles
    // live in one process or two. A genuine two-OS-process test would
    // additionally need to solve this project's @/ path-alias resolution
    // inside a spawned child process for no extra evidence about the
    // locking mechanism itself — disproportionate for what it would add.
    const dbPath = path.join(tempRoot, 'data.db');
    DatabaseConnection.getInstance(); // ensures data.db + migrations table exist

    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    try {
      dbA.pragma('busy_timeout = 5000');
      dbA.exec('BEGIN IMMEDIATE'); // holds the write lock, uncommitted

      dbB.pragma('busy_timeout = 200'); // short on purpose so the test doesn't hang
      const start = Date.now();
      expect(() => dbB.exec('BEGIN IMMEDIATE')).toThrow();
      const elapsed = Date.now() - start;
      // Proves B actually waited on A's lock rather than failing instantly
      // — an instant SQLITE_BUSY with no wait would mean busy_timeout
      // isn't doing anything, which would make the whole fix meaningless.
      expect(elapsed).toBeGreaterThanOrEqual(150);

      dbA.exec('ROLLBACK');
    } finally {
      // finally, not just inline at the end: a failed assertion above must
      // not leave these file handles open — on Windows in particular, an
      // unclosed handle blocks the temp dir this test created from being
      // deleted in afterEach.
      dbA.close();
      dbB.close();
    }
  });
});
