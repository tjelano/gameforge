# Edit in Aseprite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Edit in Aseprite" action on an asset's detail page that launches Aseprite, pointed at that asset's actual image file, on the local machine.

**Architecture:** A new local-only `settings` table (never git-synced) stores the Aseprite executable path per machine, set via a new Settings page. A new API route resolves the asset's image path and the configured Aseprite path, runs a pure decision function to pick one of seven outcomes (no image / unsafe stored image path / path not configured / configured path doesn't look like Aseprite / image missing on disk / Aseprite missing on disk / ok to launch), and on the "ok" outcome spawns Aseprite as a detached child process using array-form arguments (no shell string, no injection surface). This plan also fixes one pre-existing, unrelated bug found during its own adversarial review: a cross-process race in the migration runner (Task 1, Step 0).

**Tech Stack:** Next.js App Router API routes, Node's `child_process.spawn`, better-sqlite3, Zod, Vitest with real temp SQLite (this project's established pattern — see `test/assetUpdate.test.ts` for the exact fixture shape reused throughout this plan).

**Spec:** docs/superpowers/specs/2026-09-04-aseprite-edit-design.md

## Global Constraints

- No install automation of any kind — Aseprite must already be present on the machine; V1 only locates and launches it (see spec's "Out of scope").
- `settings` table is machine-local config: never added to `GitService`'s `DATA_DIRS`, never exported to `data/`.
- `child_process.spawn` MUST be called with the array-of-args form (`spawn(exePath, [imagePath], {...})`), never a shell string or `shell: true` — this is what keeps any value from being re-parsed as shell syntax (Global Constraint from the spec's Security note).
- The asset's stored `image_path` MUST be validated as a bare filename (`isSafeStoredFilename` — no `/`, `\`, or `..`) before being joined into a physical path, mirroring the guard `app/api/images/[filename]/route.ts` already uses — added after this plan's adversarial review found `AssetSchema` does not format-validate `image_path`, and git-imported asset JSON reaches it unchecked.
- The configured Aseprite path MUST resolve to a filename matching `looksLikeAsepriteExecutable` (`/^aseprite.*\.exe$/i` on the basename) before it is ever passed to `spawn` — a proportionate mitigation for this app having no authentication anywhere (see spec's Security note for the full reasoning and its limits).
- Every fs/process operation wrapped in try/catch with `console.error` logging on failure (project Hard Rule, `AGENTS.md`); `spawn`'s asynchronous `'error'` event MUST also be handled (a synchronous try/catch alone does not catch it and an unhandled `'error'` event crashes the process).
- Every new API response follows the `{success, data, error}` contract already used throughout this codebase.
- Direct SQL via better-sqlite3, no ORM; direct Zod validation at API boundaries, no DTOs (project Hard Rules).

---

## File Map

| File | Responsibility |
|---|---|
| `lib/database/index.ts` | Fix cross-process race in the migration runner (pre-existing bug, fixed in Task 1) |
| `lib/database/migrations/007_add_settings_table.sql` | New `settings(key, value)` table |
| `lib/services/SettingsService.ts` | `get`/`set` on the settings table, direct SQL |
| `app/api/settings/aseprite-path/route.ts` | `GET`/`PUT` for the `aseprite_path` setting |
| `app/dashboard/settings/aseprite/page.tsx` | UI to view/set the Aseprite path |
| `app/components/NavRail.tsx` | Add the new settings page to nav |
| `lib/services/shared/editDecision.ts` | Pure function: given asset/settings/filesystem state, decide the outcome |
| `app/api/assets/[id]/edit/route.ts` | `POST` — wires `editDecision` to a real `child_process.spawn` call |
| `app/dashboard/assets/[id]/page.tsx` | Add the "Edit in Aseprite" button |

---

### Task 1: Settings table + SettingsService

**Files:**
- Create: `lib/database/migrations/007_add_settings_table.sql`
- Create: `lib/services/SettingsService.ts`
- Modify: `lib/config.ts`
- Modify: `lib/database/index.ts` (migration-runner concurrency fix — see Step 0 below)
- Test: `test/settingsService.test.ts`
- Test: `test/migrationConcurrency.test.ts`

**Interfaces:**
- Produces: `settingsService.get(key: string): Promise<string | null>`, `settingsService.set(key: string, value: string): Promise<void>`, and the constant `ASEPRITE_PATH_SETTING_KEY` from `@/lib/config` — consumed by Task 2's API route and Task 4's edit route (this project's convention: constants shared by 2+ files live in `lib/config.ts`, see its existing `IO_WRITE_BATCH_SIZE`/`WORKER_BATCH_SIZE`).

**Note — this task also fixes a pre-existing, unrelated bug found during this plan's adversarial review (see `docs/superpowers/plans/2026-09-04-aseprite-edit-review-log.md`, Round 1, finding 6):** `DatabaseConnection.runMigrations()` reads which migrations are already applied once, then applies each unapplied file in its own transaction. This app's own documented normal startup runs two separate processes (`npm run dev` and `npm run dev:worker`) that each independently call `DatabaseConnection.getInstance()` — if both start close together after a new migration file is added (exactly what happens the first time this feature's own migration 007 gets deployed), both processes can read "not yet applied" before either commits, and the second one to run fails when it hits already-created schema objects. This isn't specific to migration 007 — every prior migration has had this exposure — but it's small, contained to one file, and fixing it now protects this feature's own first real startup, so it's fixed here rather than filed away.

- [ ] **Step 0: Fix the migration-runner race first (TDD)**

Write the failing test:

```typescript
// test/migrationConcurrency.test.ts
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

describe('BEGIN IMMEDIATE lock actually serializes concurrent connections', () => {
  it('a second connection blocks (per busy_timeout) rather than erroring immediately while the first holds the lock', () => {
    // This is the specific mechanism the migration-runner fix depends on:
    // does BEGIN IMMEDIATE + busy_timeout genuinely make a second writer
    // wait, rather than fail instantly? Two real, separate better-sqlite3
    // connections to the SAME file exercise SQLite's actual file-level
    // locking — this is the part that matters for proving the lock works;
    // it doesn't require two separate OS processes, since SQLite's locking
    // is per-connection/per-file-handle, identical whether those handles
    // live in one process or two. A genuine two-OS-process test would
    // additionally need to solve this project's @/ path-alias resolution
    // inside a spawned child process for no extra evidence about the
    // locking mechanism itself — disproportionate for what it would add.
    const dbPath = path.join(tempRoot, 'data.db');
    DatabaseConnection.getInstance(); // ensures data.db + migrations table exist

    const dbA = new Database(dbPath);
    dbA.pragma('busy_timeout = 5000');
    dbA.exec('BEGIN IMMEDIATE'); // holds the write lock, uncommitted

    const dbB = new Database(dbPath);
    dbB.pragma('busy_timeout = 200'); // short on purpose so the test doesn't hang
    const start = Date.now();
    expect(() => dbB.exec('BEGIN IMMEDIATE')).toThrow();
    const elapsed = Date.now() - start;
    // Proves B actually waited on A's lock rather than failing instantly —
    // an instant SQLITE_BUSY with no wait would mean busy_timeout isn't
    // doing anything, which would make the whole fix meaningless.
    expect(elapsed).toBeGreaterThanOrEqual(150);

    dbA.exec('ROLLBACK');
    dbA.close();
    dbB.close();
  });
});
```

Run: `npx vitest run test/migrationConcurrency.test.ts`
Expected: PASS even before the refactor for the first `describe` block (idempotency); the second `describe` block's test is independent of the refactor too — it tests SQLite's own locking behavior plus the `busy_timeout` pragma this codebase already sets, not code this task changes. Both together are the evidence for this fix: the lock genuinely serializes concurrent writers (this test), and re-checking applied-status *inside* that lock before deciding to run a migration is what makes "already applied" the correct outcome for whichever connection loses the race (the idempotency test, plus code inspection of the refactor itself — BEGIN IMMEDIATE + re-check-inside-the-lock is a standard, well-understood pattern for exactly this class of race).

Replace `lib/database/index.ts`'s `runMigrations` method (and remove the now-redundant `tableCheck` block above it) with:

```typescript
  private static runMigrations(db: Database.Database): void {
    const migrationsDir = path.join(getProjectRoot(), 'lib', 'database', 'migrations');

    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`❌ Migrations directory not found: ${migrationsDir}`);
    }

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    if (files.length === 0) return;

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
  }
```

Run: `npx vitest run test/migrationConcurrency.test.ts`
Expected: PASS (2 tests). Then run the FULL suite — this touches shared infrastructure every other test depends on:

Run: `npx vitest run`
Expected: all existing tests still PASS (this refactor preserves exact behavior for the single-process case; it only changes *how* the lock is acquired, not what gets applied or in what order).

Commit this fix on its own before continuing to Step 1:

```bash
git add lib/database/index.ts test/migrationConcurrency.test.ts
git commit -m "Fix cross-process race in migration runner (BEGIN IMMEDIATE)"
```

- [ ] **Step 1: Write the failing test**

```typescript
// test/settingsService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { settingsService } from '@/lib/services/SettingsService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-settings-'));
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

describe('SettingsService', () => {
  it('returns null for a key that was never set', async () => {
    expect(await settingsService.get('aseprite_path')).toBeNull();
  });

  it('set() then get() round-trips the value', async () => {
    await settingsService.set('aseprite_path', 'C:\\Aseprite\\Aseprite.exe');
    expect(await settingsService.get('aseprite_path')).toBe('C:\\Aseprite\\Aseprite.exe');
  });

  it('set() called twice on the same key upserts rather than throwing', async () => {
    await settingsService.set('aseprite_path', 'C:\\first\\path.exe');
    await settingsService.set('aseprite_path', 'C:\\second\\path.exe');
    expect(await settingsService.get('aseprite_path')).toBe('C:\\second\\path.exe');
  });

  it('keys are independent of each other', async () => {
    await settingsService.set('aseprite_path', 'C:\\a.exe');
    expect(await settingsService.get('some_other_key')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settingsService.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/SettingsService'` (the module doesn't exist yet), and migration 007 doesn't exist so the copied-migrations directory won't include it either (harmless at this point — the import failure happens first).

- [ ] **Step 3: Write the migration**

```sql
-- lib/database/migrations/007_add_settings_table.sql

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Write SettingsService**

```typescript
// lib/services/SettingsService.ts
import { DatabaseConnection } from '@/lib/database';

class SettingsServiceImpl {
  async get(key: string): Promise<string | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  async set(key: string, value: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

export const settingsService = new SettingsServiceImpl();
```

- [ ] **Step 5: Add the shared settings-key constant**

`lib/config.ts` currently reads:

```typescript
// Shared env-driven constants. Extracted here because both GitService
// (staging chunk size) and AssetService (cleanup delete-batch size) need
// the same IO_WRITE_BATCH_SIZE value.

export const IO_WRITE_BATCH_SIZE = Number(process.env.IO_WRITE_BATCH_SIZE) || 25;
export const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 5;
```

Add one line — this is not env-driven like the other two, but it's the same
"shared by 2+ files" reason this module exists, so it belongs here rather
than as a duplicated string literal in two route files:

```typescript
// Shared env-driven constants. Extracted here because both GitService
// (staging chunk size) and AssetService (cleanup delete-batch size) need
// the same IO_WRITE_BATCH_SIZE value.

export const IO_WRITE_BATCH_SIZE = Number(process.env.IO_WRITE_BATCH_SIZE) || 25;
export const WORKER_BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 5;

// Settings-table key for the Aseprite executable path. Shared between
// the settings API route and the asset edit route.
export const ASEPRITE_PATH_SETTING_KEY = 'aseprite_path';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/settingsService.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/database/migrations/007_add_settings_table.sql lib/services/SettingsService.ts lib/config.ts test/settingsService.test.ts
git commit -m "Add settings table and SettingsService for machine-local config"
```

---

### Task 2: Settings API route, Settings page, nav entry

**Files:**
- Create: `app/api/settings/aseprite-path/route.ts`
- Create: `app/dashboard/settings/aseprite/page.tsx`
- Modify: `app/components/NavRail.tsx:6-14`
- Test: `test/asepritePathSettings.test.ts`

**Interfaces:**
- Consumes: `settingsService.get`/`settingsService.set` from Task 1 (`@/lib/services/SettingsService`).
- Produces: `GET /api/settings/aseprite-path` → `{success:true,data:{path:string}}`; `PUT /api/settings/aseprite-path` (body `{path:string}`) → `{success:true,data:{path:string}}`, or `{success:false,error:string}` (400) when `path` is missing or not a string. An empty string IS accepted — it's how the setting gets cleared (see Round 1 review finding 4: Task 5's manual verification needs to clear the path, and `decideEditAction`'s existing `!params.asepritePathSetting` check already treats an empty string as falsy, i.e. "not configured" — no separate clear/delete endpoint needed).

- [ ] **Step 1: Write the failing test**

```typescript
// test/asepritePathSettings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { GET as getPath, PUT as putPath } from '@/app/api/settings/aseprite-path/route';

let tempRoot: string;

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/aseprite-path', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-asepritesettings-'));
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

describe('GET/PUT /api/settings/aseprite-path', () => {
  it('GET returns an empty path when nothing has been saved', async () => {
    const res = await getPath();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.path).toBe('');
  });

  it('PUT saves the path, and a subsequent GET returns it', async () => {
    const putRes = await putPath(putRequest({ path: 'C:\\Aseprite\\Aseprite.exe' }));
    const putBody = await putRes.json();
    expect(putBody.success).toBe(true);
    expect(putBody.data.path).toBe('C:\\Aseprite\\Aseprite.exe');

    const getRes = await getPath();
    const getBody = await getRes.json();
    expect(getBody.data.path).toBe('C:\\Aseprite\\Aseprite.exe');
  });

  it('PUT accepts an empty path — this is how the setting gets cleared', async () => {
    await putPath(putRequest({ path: 'C:\\Aseprite\\Aseprite.exe' }));
    const res = await putPath(putRequest({ path: '' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.path).toBe('');

    const getRes = await getPath();
    const getBody = await getRes.json();
    expect(getBody.data.path).toBe('');
  });

  it('PUT rejects a missing path field with a 400', async () => {
    const res = await putPath(putRequest({}));
    expect(res.status).toBe(400);
  });

  it('PUT rejects a non-string path with a 400', async () => {
    const res = await putPath(putRequest({ path: 123 }));
    expect(res.status).toBe(400);
  });

  it('PUT rejects a relative path with a 400', async () => {
    const res = await putPath(putRequest({ path: 'Aseprite.exe' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('PUT trims surrounding whitespace before validating and saving', async () => {
    const res = await putPath(putRequest({ path: '  C:\\Aseprite\\Aseprite.exe  ' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe('C:\\Aseprite\\Aseprite.exe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/asepritePathSettings.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/settings/aseprite-path/route'`.

- [ ] **Step 3: Write the API route**

```typescript
// app/api/settings/aseprite-path/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import path from 'path';
import { settingsService } from '@/lib/services/SettingsService';
import { ASEPRITE_PATH_SETTING_KEY } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Trimmed first, then either '' (clears the setting — decideEditAction in
// Task 3 already treats '' the same as null/unset) or a genuinely absolute
// path. A relative path here would resolve from wherever the Next.js
// server process happens to be running, not from anywhere meaningful to
// the user — round 2 review finding 2.
const SetPathSchema = z.object({
  path: z
    .string()
    .transform(s => s.trim())
    .refine(s => s === '' || path.isAbsolute(s), {
      message: 'Path must be empty (to clear) or an absolute path.',
    }),
});

export async function GET() {
  try {
    const savedPath = await settingsService.get(ASEPRITE_PATH_SETTING_KEY);
    return NextResponse.json({ success: true, data: { path: savedPath ?? '' } });
  } catch (error: any) {
    console.error('Failed to read aseprite_path setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = SetPathSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    await settingsService.set(ASEPRITE_PATH_SETTING_KEY, parsed.data.path);
    return NextResponse.json({ success: true, data: { path: parsed.data.path } });
  } catch (error: any) {
    console.error('Failed to save aseprite_path setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/asepritePathSettings.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the Settings page**

```tsx
// app/dashboard/settings/aseprite/page.tsx
'use client';

import { useEffect, useState } from 'react';

export default function AsepriteSettingsPage() {
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/aseprite-path');
        const body = await res.json();
        if (ignore) return;
        if (body.success) setPath(body.data.path);
      } catch {
        if (!ignore) setResult('Could not reach the server.');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch('/api/settings/aseprite-path', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const body = await res.json();
      setResult(body.success ? 'Saved.' : (body.error ?? 'Save failed.'));
    } catch {
      setResult('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Aseprite</h1>
      <p className="page-subtitle">
        Set the path to your Aseprite executable so the &quot;Edit in Aseprite&quot; button on asset
        pages can launch it. This is machine-specific — it is never synced to git.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div className="field">
          <label htmlFor="aseprite-path">Aseprite executable path</label>
          <input
            id="aseprite-path"
            value={path}
            onChange={e => setPath(e.target.value)}
            placeholder="C:\Program Files\Aseprite\Aseprite.exe"
          />
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ marginTop: 12 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {result && <p style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-dim)' }}>{result}</p>}
      </div>
    </>
  );
}
```

- [ ] **Step 6: Add the nav entry**

In `app/components/NavRail.tsx`, the `LINKS` array is currently:

```typescript
const LINKS = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
];
```

Add one entry after the Storage link:

```typescript
const LINKS = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
];
```

- [ ] **Step 7: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 8: Commit**

```bash
git add app/api/settings/aseprite-path/route.ts app/dashboard/settings/aseprite/page.tsx app/components/NavRail.tsx test/asepritePathSettings.test.ts
git commit -m "Add Aseprite path setting: API route, settings page, nav entry"
```

---

### Task 3: Edit decision logic

**Files:**
- Create: `lib/services/shared/editDecision.ts`
- Test: `test/editDecision.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  type EditDecision =
    | { ok: true; asepritePath: string; imagePath: string }
    | { ok: false; error: string };

  function decideEditAction(params: {
    imagePathColumn: string | null;
    imagePathIsSafe: boolean;
    asepritePathSetting: string | null;
    asepritePathLooksLikeAseprite: boolean;
    imageAbsolutePath: string;
    imageExists: boolean;
    asepriteExists: boolean;
  }): EditDecision;

  function isSafeStoredFilename(filename: string): boolean;
  function looksLikeAsepriteExecutable(asepritePath: string): boolean;
  ```
  Consumed by Task 4's `POST /api/assets/[id]/edit` route.

This is a pure function — no fs, no DB, no process access. The route (Task 4) computes the boolean/string inputs and hands them in; that split is what makes every rejection branch unit-testable without touching a real filesystem or spawning anything.

`imagePathIsSafe` and `asepritePathLooksLikeAseprite` exist because of two findings from this plan's adversarial review (`docs/superpowers/plans/2026-09-04-aseprite-edit-review-log.md`, Round 1):

- **Finding 2 (path traversal):** `AssetSchema.image_path` is `z.string().nullable()` with no format check, and git-imported asset JSON goes through `AssetSchema.parse()` unchecked — a crafted `image_path` containing `../` or a path separator could resolve outside `storage/images` once `path.join()`'d. `app/api/images/[filename]/route.ts` already guards against exactly this for the *read* path (`filename.includes('/') || includes('\\') || includes('..')` → reject); `isSafeStoredFilename` is the same guard, reused here for the *write/launch* path, which needs it at least as much.
- **Finding 1 (unauthenticated remote launch):** this app has no auth anywhere, and its own README documents running it behind a VPN/tunnel for remote access — meaning an unauthenticated caller could `PUT` an arbitrary path via Task 2's settings route, then `POST` this route to launch it. Building real access control is out of scope here (every other route in this app is equally unauthenticated today; retrofitting auth onto one route is inconsistent and not what this feature is for). `looksLikeAsepriteExecutable` is a narrower, proportionate mitigation: it restricts what CAN be configured and launched to something whose filename actually looks like Aseprite, closing off the sharper edge of that finding — "launch any already-present executable on the machine" — down to "only ever launches something named aseprite*.exe". It does not eliminate the underlying risk (this app's total lack of auth is a pre-existing, whole-system property, not something this plan is scoped to fix), and the spec's Security section is updated to say so plainly.

- [ ] **Step 1: Write the failing test**

```typescript
// test/editDecision.test.ts
import { describe, it, expect } from 'vitest';
import {
  decideEditAction,
  isSafeStoredFilename,
  looksLikeAsepriteExecutable,
} from '@/lib/services/shared/editDecision';

const BASE = {
  imagePathColumn: 'asset-123.png',
  imagePathIsSafe: true,
  asepritePathSetting: 'C:\\Aseprite\\Aseprite.exe',
  asepritePathLooksLikeAseprite: true,
  imageAbsolutePath: 'C:\\project\\storage\\images\\asset-123.png',
  imageExists: true,
  asepriteExists: true,
};

describe('decideEditAction', () => {
  it('rejects when the asset has no image at all', () => {
    const result = decideEditAction({ ...BASE, imagePathColumn: null });
    expect(result).toEqual({ ok: false, error: 'This asset has no image.' });
  });

  it('rejects an unsafe stored image path before checking anything else', () => {
    const result = decideEditAction({ ...BASE, imagePathIsSafe: false });
    expect(result).toEqual({ ok: false, error: 'Invalid image path.' });
  });

  it('rejects when no Aseprite path is configured', () => {
    const result = decideEditAction({ ...BASE, asepritePathSetting: null });
    expect(result).toEqual({ ok: false, error: 'Set your Aseprite path in Settings first.' });
  });

  it('rejects a configured path whose filename does not look like Aseprite', () => {
    const result = decideEditAction({ ...BASE, asepritePathLooksLikeAseprite: false });
    expect(result).toEqual({
      ok: false,
      error: 'Configured path must point to an Aseprite executable.',
    });
  });

  it('rejects when the image file is missing on disk', () => {
    const result = decideEditAction({ ...BASE, imageExists: false });
    expect(result).toEqual({ ok: false, error: 'Image file not found on disk.' });
  });

  it('rejects when Aseprite is not found at the configured path', () => {
    const result = decideEditAction({ ...BASE, asepriteExists: false });
    expect(result).toEqual({
      ok: false,
      error: 'Aseprite not found at the configured path. Check Settings.',
    });
  });

  it('approves when everything checks out, returning the resolved paths', () => {
    const result = decideEditAction(BASE);
    expect(result).toEqual({
      ok: true,
      asepritePath: 'C:\\Aseprite\\Aseprite.exe',
      imagePath: 'C:\\project\\storage\\images\\asset-123.png',
    });
  });
});

describe('isSafeStoredFilename', () => {
  it('accepts a bare filename', () => {
    expect(isSafeStoredFilename('asset-123.png')).toBe(true);
  });

  it('rejects a path containing a forward slash', () => {
    expect(isSafeStoredFilename('../secrets.png')).toBe(false);
  });

  it('rejects a path containing a backslash', () => {
    expect(isSafeStoredFilename('..\\secrets.png')).toBe(false);
  });

  it('rejects a path containing ..', () => {
    expect(isSafeStoredFilename('foo..png')).toBe(false);
  });
});

describe('looksLikeAsepriteExecutable', () => {
  it('accepts Aseprite.exe (any casing)', () => {
    expect(looksLikeAsepriteExecutable('C:\\Program Files\\Aseprite\\Aseprite.exe')).toBe(true);
    expect(looksLikeAsepriteExecutable('C:\\tools\\aseprite.exe')).toBe(true);
  });

  it('accepts a self-built binary with a version suffix', () => {
    expect(looksLikeAsepriteExecutable('C:\\aseprite-src\\build\\bin\\aseprite-1.3.7.exe')).toBe(true);
  });

  it('rejects an unrelated executable', () => {
    expect(looksLikeAsepriteExecutable('C:\\Windows\\System32\\cmd.exe')).toBe(false);
    expect(looksLikeAsepriteExecutable('C:\\Windows\\System32\\powershell.exe')).toBe(false);
  });

  it('rejects a non-.exe file even if named aseprite', () => {
    expect(looksLikeAsepriteExecutable('C:\\notes\\aseprite.txt')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editDecision.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/shared/editDecision'`.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/shared/editDecision.ts
import path from 'path';

export type EditDecision =
  | { ok: true; asepritePath: string; imagePath: string }
  | { ok: false; error: string };

// Same guard app/api/images/[filename]/route.ts already uses for the read
// path — reused here because a stored image_path reaches this route
// without going through that route's own check, and can arrive via
// git-imported JSON that AssetSchema doesn't format-validate.
export function isSafeStoredFilename(filename: string): boolean {
  return !filename.includes('/') && !filename.includes('\\') && !filename.includes('..');
}

// Proportionate mitigation for this app having no auth anywhere (see this
// task's own Interfaces section above for the full reasoning): restricts
// what can be launched to something whose filename actually looks like
// Aseprite, rather than any already-present executable on the machine.
export function looksLikeAsepriteExecutable(asepritePath: string): boolean {
  return /^aseprite.*\.exe$/i.test(path.basename(asepritePath));
}

export function decideEditAction(params: {
  imagePathColumn: string | null;
  imagePathIsSafe: boolean;
  asepritePathSetting: string | null;
  asepritePathLooksLikeAseprite: boolean;
  imageAbsolutePath: string;
  imageExists: boolean;
  asepriteExists: boolean;
}): EditDecision {
  if (!params.imagePathColumn) {
    return { ok: false, error: 'This asset has no image.' };
  }
  if (!params.imagePathIsSafe) {
    return { ok: false, error: 'Invalid image path.' };
  }
  if (!params.asepritePathSetting) {
    return { ok: false, error: 'Set your Aseprite path in Settings first.' };
  }
  if (!params.asepritePathLooksLikeAseprite) {
    return { ok: false, error: 'Configured path must point to an Aseprite executable.' };
  }
  if (!params.imageExists) {
    return { ok: false, error: 'Image file not found on disk.' };
  }
  if (!params.asepriteExists) {
    return { ok: false, error: 'Aseprite not found at the configured path. Check Settings.' };
  }
  return { ok: true, asepritePath: params.asepritePathSetting, imagePath: params.imageAbsolutePath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/editDecision.test.ts`
Expected: PASS (15 tests: 7 for `decideEditAction`, 4 for `isSafeStoredFilename`, 4 for `looksLikeAsepriteExecutable`).

- [ ] **Step 5: Commit**

```bash
git add lib/services/shared/editDecision.ts test/editDecision.test.ts
git commit -m "Add pure decision function for the Edit-in-Aseprite action"
```

---

### Task 4: Edit API route and asset page button

**Files:**
- Create: `app/api/assets/[id]/edit/route.ts`
- Modify: `app/dashboard/assets/[id]/page.tsx:1-84` (imports, state, and the block right after the asset image)
- Test: `test/assetEdit.test.ts`

**Interfaces:**
- Consumes: `assetService.getById(id: string): Promise<Asset | null>` (existing, `@/lib/services/AssetService`), `settingsService.get` + `ASEPRITE_PATH_SETTING_KEY` (Task 1), `decideEditAction` + `isSafeStoredFilename` + `looksLikeAsepriteExecutable` (Task 3).
- Produces: `POST /api/assets/[id]/edit` → `{success:true,data:{launched:true}}` on success, or `{success:false,error:string}` with status 404 (asset not found), 400 (any `decideEditAction` rejection), or 500 (spawn threw synchronously, or emitted an async `'error'` within `SPAWN_ERROR_WAIT_MS`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/assetEdit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

// A fake ChildProcess: a real EventEmitter (so .once('error', ...) works
// exactly like the real thing) plus a stubbed unref(). Individual tests
// can grab the returned emitter via spawnMock.mock.results to fire a
// simulated async 'error' event.
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}
const spawnMock = vi.fn(makeFakeChild);
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

let tempRoot: string;
const STYLE_ID = '99999999-9999-9999-9999-999999999999';
const ASSET_WITH_IMAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ASSET_NO_IMAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ASSET_UNSAFE_PATH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function editRequest(): NextRequest {
  return new NextRequest('http://localhost/api/assets/x/edit', { method: 'POST' });
}

beforeEach(async () => {
  spawnMock.mockClear();
  spawnMock.mockImplementation(makeFakeChild);
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetedit-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'Confirm', 'confirm.png', 1000, 0)`
  ).run(ASSET_WITH_IMAGE_ID, STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'No Image', NULL, 1000, 0)`
  ).run(ASSET_NO_IMAGE_ID, STYLE_ID);
  // Simulates a row that arrived via git-imported JSON, which AssetSchema
  // does not format-validate — exactly the vector Round 1 review finding 2
  // described. A normal upload flow never produces a path like this.
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'Unsafe', '../../../outside.png', 1000, 0)`
  ).run(ASSET_UNSAFE_PATH_ID, STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('POST /api/assets/[id]/edit', () => {
  it('404s when the asset does not exist', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: 'no-such-asset' }) });
    expect(res.status).toBe(404);
  });

  it('400s with a specific message when the asset has no image', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_NO_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('This asset has no image.');
  });

  it('400s and never touches the filesystem when the stored image path is unsafe', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_UNSAFE_PATH_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid image path.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s with a specific message when no Aseprite path is configured', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Set your Aseprite path in Settings first.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s when the configured path exists but its filename does not look like Aseprite', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const wrongExePath = path.join(tempRoot, 'notepad.exe');
    await fsPromises.writeFile(wrongExePath, 'not-aseprite');
    await settingsService.set('aseprite_path', wrongExePath);
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'confirm.png'), 'fake-png-bytes');

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Configured path must point to an Aseprite executable.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s when the configured Aseprite path does not exist on disk', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    await settingsService.set('aseprite_path', path.join(tempRoot, 'no-such-aseprite.exe'));
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'confirm.png'), 'fake-png-bytes');

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Aseprite not found at the configured path. Check Settings.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s when the image file is missing on disk even though the DB row has a path', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    // Deliberately NOT creating storage/images/confirm.png here.

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Image file not found on disk.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('launches Aseprite with the resolved absolute image path when everything checks out', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    const imagePath = path.join(tempRoot, 'storage', 'images', 'confirm.png');
    await fsPromises.writeFile(imagePath, 'fake-png-bytes');

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [calledExe, calledArgs, calledOpts] = spawnMock.mock.calls[0];
    expect(calledExe).toBe(fakeAsepritePath);
    expect(calledArgs).toEqual([imagePath]);
    expect(calledOpts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('reports a launch failure instead of crashing when spawn emits an async error', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    const imagePath = path.join(tempRoot, 'storage', 'images', 'confirm.png');
    await fsPromises.writeFile(imagePath, 'fake-png-bytes');

    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild();
      // Simulate the real, asynchronous failure mode: spawn() returns
      // successfully, then the OS-level failure surfaces on 'error'
      // shortly after (e.g. permission denied, not actually executable).
      setImmediate(() => child.emit('error', new Error('spawn EACCES')));
      return child;
    });

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assetEdit.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/assets/[id]/edit/route'`.

- [ ] **Step 3: Write the API route**

```typescript
// app/api/assets/[id]/edit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { assetService } from '@/lib/services/AssetService';
import { settingsService } from '@/lib/services/SettingsService';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import {
  decideEditAction,
  isSafeStoredFilename,
  looksLikeAsepriteExecutable,
} from '@/lib/services/shared/editDecision';
import { ASEPRITE_PATH_SETTING_KEY } from '@/lib/config';

export const dynamic = 'force-dynamic';

// How long to wait for spawn's asynchronous 'error' event before giving up
// and reporting success anyway. spawn() itself returns immediately either
// way; a real, immediate failure (bad permissions, not actually an
// executable) reliably surfaces well within this window in practice. This
// does not wait for Aseprite to fully start or exit — only for the narrow
// class of near-immediate launch failures, matching the spec's "fire and
// forget, don't wait for Aseprite to close" design.
const SPAWN_ERROR_WAIT_MS = 300;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }

    const asepritePathSetting = await settingsService.get(ASEPRITE_PATH_SETTING_KEY);

    const imagePathIsSafe = !!asset.image_path && isSafeStoredFilename(asset.image_path);
    const imageAbsolutePath =
      asset.image_path && imagePathIsSafe
        ? path.join(getProjectRoot(), 'storage', 'images', asset.image_path)
        : '';
    const asepritePathLooksLikeAseprite =
      !!asepritePathSetting && looksLikeAsepriteExecutable(asepritePathSetting);

    // isFile() rather than existsSync: a directory or other non-regular
    // path would pass an existsSync-only check and produce a confusing
    // spawn failure instead of the specific, actionable message below.
    // statSync throws ENOENT for a path that doesn't exist at all — that's
    // an ordinary, expected outcome here, not worth logging. Any OTHER
    // stat failure (e.g. EACCES — permission denied) is unexpected and
    // genuinely worth a server-side log, even though the user still just
    // sees the same generic "not found" decision-branch message.
    function isRegularFile(p: string): boolean {
      try {
        return fs.statSync(p).isFile();
      } catch (e: any) {
        if (e?.code !== 'ENOENT') console.error(`Unexpected error checking ${p}:`, e);
        return false;
      }
    }

    let imageExists = false;
    let asepriteExists = false;
    try {
      imageExists = !!imageAbsolutePath && isRegularFile(imageAbsolutePath);
      asepriteExists = !!asepritePathSetting && isRegularFile(asepritePathSetting);
    } catch (e) {
      console.error('Failed checking file existence for edit action:', e);
    }

    const decision = decideEditAction({
      imagePathColumn: asset.image_path,
      imagePathIsSafe,
      asepritePathSetting,
      asepritePathLooksLikeAseprite,
      imageAbsolutePath,
      imageExists,
      asepriteExists,
    });

    if (!decision.ok) {
      return NextResponse.json({ success: false, error: decision.error }, { status: 400 });
    }

    try {
      const child = spawn(decision.asepritePath, [decision.imagePath], {
        detached: true,
        stdio: 'ignore',
      });

      const spawnError = await new Promise<Error | null>(resolve => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(null);
        }, SPAWN_ERROR_WAIT_MS);
        // This listener can still fire AFTER the timeout above already
        // resolved the promise (resolve() on an already-settled promise is
        // a harmless no-op) — a late failure that arrives after the
        // response already reported success. That's still worth a
        // server-side log even though the HTTP response has already gone
        // out; a call to resolve() below in that case is inert but
        // harmless.
        child.once('error', err => {
          clearTimeout(timer);
          if (settled) {
            console.error('Aseprite failed to launch (after the response already reported success):', err);
          } else {
            settled = true;
          }
          resolve(err);
        });
      });

      child.unref();

      if (spawnError) {
        console.error('Failed to launch Aseprite:', spawnError);
        return NextResponse.json(
          { success: false, error: 'Could not launch Aseprite. Check the configured path.' },
          { status: 500 }
        );
      }
    } catch (e) {
      console.error('Failed to spawn Aseprite:', e);
      return NextResponse.json({ success: false, error: 'Could not launch Aseprite.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: { launched: true } });
  } catch (error: any) {
    console.error('Edit action failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assetEdit.test.ts`
Expected: PASS (9 tests). The success-path and error-path tests each take a little over 300ms in real time (the bounded wait genuinely waits), which is fine — this file isn't run often enough for that to matter.

- [ ] **Step 5: Add the button to the asset detail page**

`app/dashboard/assets/[id]/page.tsx` currently starts like this:

```tsx
'use client';

import { useEffect, useState, use as usePromise } from 'react';
import type { Asset } from '@/lib/database/schema';

export default function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [margins, setMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [nineSliceEnabled, setNineSliceEnabled] = useState(false);
  const [states, setStates] = useState<string[]>([]);
  const [newState, setNewState] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
```

Add two new state variables after `error`:

```tsx
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editStatus, setEditStatus] = useState<string | null>(null);
```

Add a handler function after `handleSave` (which currently ends at line 61 with the closing `}`):

```tsx
  async function handleEdit() {
    setEditing(true);
    setEditStatus(null);
    try {
      const res = await fetch(`/api/assets/${id}/edit`, { method: 'POST' });
      const body = await res.json();
      setEditStatus(body.success ? 'Opened in Aseprite.' : (body.error ?? 'Could not launch Aseprite.'));
    } catch {
      setEditStatus('Could not reach the server.');
    } finally {
      setEditing(false);
    }
  }
```

The image block currently reads:

```tsx
      {asset.image_path && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/images/${asset.image_path}`}
          alt={asset.prompt}
          style={{ maxWidth: 256, imageRendering: 'pixelated', marginBottom: 24, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />
      )}
```

Replace it with the image plus the new button and status line, still gated on `asset.image_path`:

```tsx
      {asset.image_path && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/images/${asset.image_path}`}
            alt={asset.prompt}
            style={{ maxWidth: 256, imageRendering: 'pixelated', marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
          />
          <div style={{ marginBottom: 24 }}>
            <button className="btn" onClick={handleEdit} disabled={editing}>
              {editing ? 'Opening…' : 'Edit in Aseprite'}
            </button>
            {editStatus && <p style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-dim)' }}>{editStatus}</p>}
          </div>
        </>
      )}
```

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 7: Commit**

```bash
git add app/api/assets/[id]/edit/route.ts app/dashboard/assets/[id]/page.tsx test/assetEdit.test.ts
git commit -m "Add Edit in Aseprite action to the asset detail page"
```

---

### Task 5: Manual real-world verification

**Files:** none (verification only).

The spawn call cannot be meaningfully exercised by the automated suite — it launches a real GUI application. This task is a manual check, same discipline as the UI Sheets feature's real-Pixellab walkthrough.

- [ ] **Step 1: Run the full automated suite one more time**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 2: Start the dev server**

Run `npm run dev`.

- [ ] **Step 3: Walk the real flow**

1. Visit `/dashboard/settings/aseprite`. Confirm the field starts empty (or shows a previously-saved value).
2. Set it to your real, local Aseprite executable's absolute path. Save. Confirm the "Saved." message appears, and reloading the page still shows the saved path.
3. Visit an existing asset's detail page (`/dashboard/assets/[id]`) for an asset that has an image. Click "Edit in Aseprite."
4. Confirm Aseprite actually opens with that exact image loaded.
5. Make a visible edit in Aseprite (e.g. draw one pixel) and save (Ctrl+S) in Aseprite, keeping the same PNG format/filename.
6. Back in GameForge, reload the asset detail page and confirm the new pixel is visible in the thumbnail.
7. Test one failure path for real: temporarily clear the Aseprite path in Settings, click "Edit in Aseprite" again, confirm the inline message reads "Set your Aseprite path in Settings first." Restore the real path afterward.

- [ ] **Step 4: Clean up**

Stop the dev server. No test artifacts to clean up — this task didn't create any jobs, assets, or generated files, only edited an existing local image in place.
