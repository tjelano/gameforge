# Edit in Aseprite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Edit in Aseprite" action on an asset's detail page that launches Aseprite, pointed at that asset's actual image file, on the local machine.

**Architecture:** A new local-only `settings` table (never git-synced) stores the Aseprite executable path per machine, set via a new Settings page. A new API route resolves the asset's image path and the configured Aseprite path, runs a pure decision function to pick one of five outcomes (asset has no image / path not configured / image missing on disk / Aseprite missing on disk / ok to launch), and on the "ok" outcome spawns Aseprite as a detached child process using array-form arguments (no shell string, no injection surface).

**Tech Stack:** Next.js App Router API routes, Node's `child_process.spawn`, better-sqlite3, Zod, Vitest with real temp SQLite (this project's established pattern — see `test/assetUpdate.test.ts` for the exact fixture shape reused throughout this plan).

**Spec:** docs/superpowers/specs/2026-09-04-aseprite-edit-design.md

## Global Constraints

- No install automation of any kind — Aseprite must already be present on the machine; V1 only locates and launches it (see spec's "Out of scope").
- `settings` table is machine-local config: never added to `GitService`'s `DATA_DIRS`, never exported to `data/`.
- `child_process.spawn` MUST be called with the array-of-args form (`spawn(exePath, [imagePath], {...})`), never a shell string or `shell: true` — this is what keeps any value from being re-parsed as shell syntax (Global Constraint from the spec's Security note).
- Every fs/process operation wrapped in try/catch with `console.error` logging on failure (project Hard Rule, `AGENTS.md`).
- Every new API response follows the `{success, data, error}` contract already used throughout this codebase.
- Direct SQL via better-sqlite3, no ORM; direct Zod validation at API boundaries, no DTOs (project Hard Rules).

---

## File Map

| File | Responsibility |
|---|---|
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
- Test: `test/settingsService.test.ts`

**Interfaces:**
- Produces: `settingsService.get(key: string): Promise<string | null>`, `settingsService.set(key: string, value: string): Promise<void>`, and the constant `ASEPRITE_PATH_SETTING_KEY` from `@/lib/config` — consumed by Task 2's API route and Task 4's edit route (this project's convention: constants shared by 2+ files live in `lib/config.ts`, see its existing `IO_WRITE_BATCH_SIZE`/`WORKER_BATCH_SIZE`).

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
- Produces: `GET /api/settings/aseprite-path` → `{success:true,data:{path:string}}`; `PUT /api/settings/aseprite-path` (body `{path:string}`) → `{success:true,data:{path:string}}` or `{success:false,error:string}` (400 on empty/missing `path`).

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

  it('PUT rejects an empty path with a 400', async () => {
    const res = await putPath(putRequest({ path: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('PUT rejects a missing path field with a 400', async () => {
    const res = await putPath(putRequest({}));
    expect(res.status).toBe(400);
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
import { settingsService } from '@/lib/services/SettingsService';
import { ASEPRITE_PATH_SETTING_KEY } from '@/lib/config';

export const dynamic = 'force-dynamic';

const SetPathSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty.'),
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
Expected: PASS (4 tests).

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
      const res = await fetch('/api/settings/aseprite-path');
      const body = await res.json();
      if (ignore) return;
      if (body.success) setPath(body.data.path);
      setLoading(false);
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
    asepritePathSetting: string | null;
    imageAbsolutePath: string;
    imageExists: boolean;
    asepriteExists: boolean;
  }): EditDecision;
  ```
  Consumed by Task 4's `POST /api/assets/[id]/edit` route.

This is a pure function — no fs, no DB, no process access. The route (Task 4) computes the boolean/string inputs and hands them in; that split is what makes the four failure branches unit-testable without touching a real filesystem or spawning anything.

- [ ] **Step 1: Write the failing test**

```typescript
// test/editDecision.test.ts
import { describe, it, expect } from 'vitest';
import { decideEditAction } from '@/lib/services/shared/editDecision';

const BASE = {
  imagePathColumn: 'asset-123.png',
  asepritePathSetting: 'C:\\Aseprite\\Aseprite.exe',
  imageAbsolutePath: 'C:\\project\\storage\\images\\asset-123.png',
  imageExists: true,
  asepriteExists: true,
};

describe('decideEditAction', () => {
  it('rejects when the asset has no image at all', () => {
    const result = decideEditAction({ ...BASE, imagePathColumn: null });
    expect(result).toEqual({ ok: false, error: 'This asset has no image.' });
  });

  it('rejects when no Aseprite path is configured', () => {
    const result = decideEditAction({ ...BASE, asepritePathSetting: null });
    expect(result).toEqual({ ok: false, error: 'Set your Aseprite path in Settings first.' });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/editDecision.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/shared/editDecision'`.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/shared/editDecision.ts

export type EditDecision =
  | { ok: true; asepritePath: string; imagePath: string }
  | { ok: false; error: string };

export function decideEditAction(params: {
  imagePathColumn: string | null;
  asepritePathSetting: string | null;
  imageAbsolutePath: string;
  imageExists: boolean;
  asepriteExists: boolean;
}): EditDecision {
  if (!params.imagePathColumn) {
    return { ok: false, error: 'This asset has no image.' };
  }
  if (!params.asepritePathSetting) {
    return { ok: false, error: 'Set your Aseprite path in Settings first.' };
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
Expected: PASS (5 tests).

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
- Consumes: `assetService.getById(id: string): Promise<Asset | null>` (existing, `@/lib/services/AssetService`), `settingsService.get` + `ASEPRITE_PATH_SETTING_KEY` (Task 1), `decideEditAction` (Task 3).
- Produces: `POST /api/assets/[id]/edit` → `{success:true,data:{launched:true}}` on success, or `{success:false,error:string}` with status 404 (asset not found) or 400 (any `decideEditAction` rejection) or 500 (spawn itself threw).

- [ ] **Step 1: Write the failing test**

```typescript
// test/assetEdit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

const spawnMock = vi.fn(() => ({ unref: vi.fn() }));
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

let tempRoot: string;
const STYLE_ID = '99999999-9999-9999-9999-999999999999';
const ASSET_WITH_IMAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ASSET_NO_IMAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function editRequest(): NextRequest {
  return new NextRequest('http://localhost/api/assets/x/edit', { method: 'POST' });
}

beforeEach(async () => {
  spawnMock.mockClear();
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

  it('400s with a specific message when no Aseprite path is configured', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Set your Aseprite path in Settings first.');
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
    const fakeAsepritePath = path.join(tempRoot, 'fake-aseprite.exe');
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
    const fakeAsepritePath = path.join(tempRoot, 'fake-aseprite.exe');
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
import { decideEditAction } from '@/lib/services/shared/editDecision';
import { ASEPRITE_PATH_SETTING_KEY } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }

    const asepritePathSetting = await settingsService.get(ASEPRITE_PATH_SETTING_KEY);
    const imageAbsolutePath = asset.image_path
      ? path.join(getProjectRoot(), 'storage', 'images', asset.image_path)
      : '';

    let imageExists = false;
    let asepriteExists = false;
    try {
      imageExists = !!asset.image_path && fs.existsSync(imageAbsolutePath);
      asepriteExists = !!asepritePathSetting && fs.existsSync(asepritePathSetting);
    } catch (e) {
      console.error('Failed checking file existence for edit action:', e);
    }

    const decision = decideEditAction({
      imagePathColumn: asset.image_path,
      asepritePathSetting,
      imageAbsolutePath,
      imageExists,
      asepriteExists,
    });

    if (!decision.ok) {
      return NextResponse.json({ success: false, error: decision.error }, { status: 400 });
    }

    try {
      spawn(decision.asepritePath, [decision.imagePath], { detached: true, stdio: 'ignore' }).unref();
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
Expected: PASS (6 tests).

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
