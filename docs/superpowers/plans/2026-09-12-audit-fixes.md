# GameForge Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all findings from the 2026-09-11 GameForge codebase audit (security/ownership gaps, AI-generation pipeline robustness, dashboard UX, core data/sync services, over-engineering cleanup).

**Architecture:** Four independent-but-sequenced groups of changes: (A) security/ownership hardening, including the Godot exporter's path-traversal and style-scoping fixes (these two are coupled — the exporter's signature changes first, then the route that calls it gets both the new signature wiring and the auth/path-safety hardening in one pass); (B) soft-delete integrity, test coverage, and small cleanups; (C) the AI generation pipeline (shared Claude tool-call helper, timeouts, retries, error surfacing); (D) dashboard UX (error surfacing, confirmation dialogs, accessibility).

**Tech Stack:** Next.js 16 App Router, TypeScript, better-sqlite3 (no ORM), Zod, Vitest. No new npm dependencies.

**Audit:** findings verified against the live codebase on 2026-09-11 (6 parallel review passes, every claim independently re-checked before being kept).

## Global Constraints

- No new npm dependencies.
- `try/catch` around all filesystem operations, with `console.error` logging on failure, matching every existing service in this codebase (AGENTS.md).
- `fs.mkdir(dir, { recursive: true })` before every new file write, except an existing atomic-mkdir-as-check pattern.
- All physical paths built via `path.join(getProjectRoot(), ...)`.
- No wrapper classes, factories, repository patterns, or custom error classes (AGENTS.md) — this plan's ownership checks return `{ error: 'NOT_FOUND' | 'FORBIDDEN' }` discriminated unions, matching the existing `StyleService.update()` pattern, not exceptions.
- `User.is_admin` is `0 | 1` (not a real boolean) — use `!!user.is_admin` when passing it as a `boolean` parameter, `!user.is_admin` for inline negation.
- This codebase has no automated tests for dashboard pages, hooks, or the Zustand store (established convention) — Part D's tasks end in manual dev-server verification, not new test files, except where noted.

## Integration notes (found while merging the 4 drafted sections into this plan)

Two independently-drafted sections each rewrote `app/api/export/route.ts` and each created a test file named `test/exportRoute.test.ts` — one add add auth + path-traversal hardening, the other adding required `styleId` + style-scoping. **Task 2 below merges both into one combined change** rather than keeping them as two incompatible full-file rewrites. Everywhere else, the 4 sections' "Cross-cutting facts" were cross-checked against every other section's file list and found to have no other conflicts — see the end of this document for the full reconciliation notes.

---

## Part A: Security, Ownership, and the Godot Export Hardening

### Task 1: `GodotExporter` — style-scope to one Style Bible + add the collision guard

**Files:**
- Modify: `lib/services/GodotExporter.ts` (whole file)
- Modify: `test/godotExporterSkipsThemes.test.ts` (call-site update for the new signature)
- Test: `test/godotExporterStyleScoping.test.ts` (new)

**Interfaces:**
- Consumes: `assetService.getActiveAssetsForStyle(styleId: string): Promise<Asset[]>` (existing, `lib/services/AssetService.ts:101-107`).
- Produces: `godotExporter.exportToGodot(styleId: string, subdir: string): Promise<ExportResult | { error: 'ALREADY_EXISTS' }>` — signature changed from the old single-argument `exportToGodot(subdir: string): Promise<ExportResult>`. **Task 2 depends on this.**

- [ ] **Step 1: Write the failing test**
```typescript
// test/godotExporterStyleScoping.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { godotExporter } from '@/lib/services/GodotExporter';

let tempRoot: string;
const STYLE_A = '11111111-1111-1111-1111-111111111111';
const STYLE_B = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-godotscope-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  const imagesDir = path.join(tempRoot, 'storage', 'images');
  await fsPromises.mkdir(imagesDir, { recursive: true });
  await fsPromises.writeFile(path.join(imagesDir, 'goblin-a.png'), 'fake-png-a');
  await fsPromises.writeFile(path.join(imagesDir, 'goblin-b.png'), 'fake-png-b');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style A', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_A);
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style B', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_B);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ?, 'user-1', 'sprite', 'x', 'goblin-a.png', 1000, 0, 'image')`
  ).run(STYLE_A);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', ?, 'user-1', 'sprite', 'x', 'goblin-b.png', 1000, 0, 'image')`
  ).run(STYLE_B);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GodotExporter.exportToGodot() scopes to one style and guards a subdir collision', () => {
  it("exports only the requested style's image, not a sibling style's", async () => {
    const result = await godotExporter.exportToGodot(STYLE_A, 'godot-scope-test');
    if ('error' in result) throw new Error(`Unexpected export error: ${result.error}`);
    expect(result.exported).toBe(1);
    const exportedFiles = await fsPromises.readdir(result.targetDir);
    expect(exportedFiles).toEqual(['goblin-a.png']);
  });

  it('returns ALREADY_EXISTS on a second export to the same subdir', async () => {
    const first = await godotExporter.exportToGodot(STYLE_A, 'godot-collision-test');
    expect('error' in first).toBe(false);

    const second = await godotExporter.exportToGodot(STYLE_B, 'godot-collision-test');
    expect(second).toEqual({ error: 'ALREADY_EXISTS' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/godotExporterStyleScoping.test.ts`
Expected: FAIL. First test: `expected 2 to be 1` — today's signature is `exportToGodot(subdir)`, so the call's *first* argument (`STYLE_A`, a uuid) binds to `subdir` and the second argument is silently dropped by JS; `getActiveAssets()` (unscoped) returns both styles' images, so `exported` is 2, not 1. Second test: `expected { exported: 1, skipped: 0, targetDir: '...' } to equal { error: 'ALREADY_EXISTS' }` — both calls end up targeting *different* directories (named after `STYLE_A`/`STYLE_B` respectively, since that's what binds to `subdir` today) and the old `mkdir(..., { recursive: true })` never throws `EEXIST` anyway, so there's no collision to detect.

- [ ] **Step 3: Implement**

Replace the whole file:
```typescript
// lib/services/GodotExporter.ts
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';

export interface ExportResult {
  exported: number;
  skipped: number;
  targetDir: string;
}

class GodotExporterImpl {
  /**
   * Copies one Style Bible's active assets' physical images into
   * storage/exports/{subdir}/ (2D only for V1 — filenames only, the
   * exporter is responsible for the physical path, per the
   * "database stores filenames, not URLs" hard rule).
   *
   * The target directory is claimed with a single atomic (non-recursive)
   * mkdir, mirroring SiteExporter.exportSite()'s own collision guard: it
   * either creates targetDir and this call owns it, or fails with EEXIST
   * because some earlier export (any style, any time) already used this
   * subdir name. Unlike SiteExporter there's no manifest here to check
   * "is this a safe re-export of the same style" against — a Godot export
   * is a flat image copy with no hand-edit-preservation concept to
   * protect, so a reused subdir is simply rejected outright.
   */
  async exportToGodot(styleId: string, subdir: string): Promise<ExportResult | { error: 'ALREADY_EXISTS' }> {
    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');
    const targetDir = path.join(exportsRootDir, subdir);

    try {
      await fsPromises.mkdir(exportsRootDir, { recursive: true });
    } catch (e) {
      console.error(`Failed to create the exports root directory ${exportsRootDir}:`, e);
      throw e;
    }

    try {
      await fsPromises.mkdir(targetDir);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        console.error(`Failed to create export target directory ${targetDir}:`, e);
        throw e;
      }
      return { error: 'ALREADY_EXISTS' };
    }

    const assets = (await assetService.getActiveAssetsForStyle(styleId)).filter(asset => asset.output_kind === 'image');

    let exported = 0;
    let skipped = 0;

    for (const asset of assets) {
      if (!asset.image_path) {
        skipped++;
        continue;
      }
      const sourcePath = path.join(imagesDir, asset.image_path);
      const destPath = path.join(targetDir, asset.image_path);
      try {
        await fsPromises.copyFile(sourcePath, destPath);
        exported++;
      } catch (e) {
        console.error(`Failed to export asset image ${asset.image_path}:`, e);
        skipped++;
      }
    }

    return { exported, skipped, targetDir };
  }
}

export const godotExporter = new GodotExporterImpl();
```

In `test/godotExporterSkipsThemes.test.ts`, update the one call site to the new 2-argument signature (read the file for its exact existing `STYLE_ID`-shaped variable name and use that instead of a literal):
```typescript
// current:
    const result = await godotExporter.exportToGodot('godot-test');

// replacement:
    const result = await godotExporter.exportToGodot(STYLE_ID, 'godot-test');
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add lib/services/GodotExporter.ts test/godotExporterSkipsThemes.test.ts test/godotExporterStyleScoping.test.ts
git commit -m "$(cat <<'EOF'
fix: GodotExporter scopes to one Style Bible and guards a subdir collision

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Harden `app/api/export/route.ts` — login, path-traversal guard, and the new `styleId` requirement

**Depends on Task 1** (the new `GodotExporter.exportToGodot(styleId, subdir)` signature).

**Files:**
- Modify: `app/api/export/route.ts` (whole file)
- Test: `test/exportRoute.test.ts` (new)

**Interfaces:**
- Consumes: `getCurrentUser(req: NextRequest): Promise<User | null>` (`lib/utils/session.ts`); `godotExporter.exportToGodot(styleId, subdir): Promise<ExportResult | { error: 'ALREADY_EXISTS' }>` (Task 1).
- Produces: `POST /api/export` now requires login (401), requires a `styleId` (400 via Zod if missing), rejects a `subdir` that isn't `/^[a-z0-9-]+$/` (400 — was `z.string().min(1)`, which accepted `../../etc` and any other string), and surfaces `ALREADY_EXISTS` as a 400. **Task 3 depends on this** (the dashboard page's POST body shape).

- [ ] **Step 1: Write the failing test**
```typescript
// test/exportRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { seedSession } from '@/test/helpers/testSession';
import { POST } from '@/app/api/export/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-exportroute-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

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

function postRequest(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/export', () => {
  it('401s when not logged in', async () => {
    const res = await POST(postRequest({ styleId: '99999999-9999-9999-9999-999999999999', subdir: 'godot' }));
    expect(res.status).toBe(401);
  });

  it('400s when styleId is missing', async () => {
    const { cookieHeader } = await seedSession();
    const res = await POST(postRequest({ subdir: 'godot' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('rejects a path-traversal subdir instead of exporting to it', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await POST(postRequest({ styleId: style.id, subdir: '../escape' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('exports the given style and returns counts', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await POST(postRequest({ styleId: style.id, subdir: 'godot-route-test' }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.exported).toBe(0); // no assets for this style, but a valid, scoped export
  });

  it('maps a subdir collision to a 400 with ALREADY_EXISTS', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    await POST(postRequest({ styleId: style.id, subdir: 'godot-route-collide' }, cookieHeader));
    const res = await POST(postRequest({ styleId: style.id, subdir: 'godot-route-collide' }, cookieHeader));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('ALREADY_EXISTS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/exportRoute.test.ts`
Expected: FAIL on all five — today's route has no login check (the 401 case gets `200`), no `styleId` field in its schema (the "missing styleId" case gets `200`, not `400`), accepts any non-empty `subdir` including `../escape` (gets `200`, not `400`), and calls `godotExporter.exportToGodot(subdir)` with the OLD one-argument signature, which after Task 1 means `subdir` binds to the new `styleId` parameter and the real `subdir` is `undefined` — `path.join(exportsRootDir, undefined)` throws `TypeError [ERR_INVALID_ARG_TYPE]`, caught by the route's catch-all as a 500 (not the expected 200/400 in the other cases).

- [ ] **Step 3: Implement**

Replace the whole file:
```typescript
// app/api/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { godotExporter } from '@/lib/services/GodotExporter';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const ExportSchema = z.object({
  styleId: z.string().uuid(),
  subdir: z.string().regex(/^[a-z0-9-]+$/, 'subdir must contain only lowercase letters, numbers, and hyphens').default('godot'),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { styleId, subdir } = ExportSchema.parse(await req.json().catch(() => ({})));
    const result = await godotExporter.exportToGodot(styleId, subdir);
    if ('error' in result) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add app/api/export/route.ts test/exportRoute.test.ts
git commit -m "$(cat <<'EOF'
fix: require login, reject path-traversal subdir, and require styleId on Godot export

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `app/dashboard/export/page.tsx` — add the missing style dropdown

**Depends on Task 2** (the route now requires `styleId` in the POST body).

**Files:**
- Modify: `app/dashboard/export/page.tsx` (whole file)
- Test: none — see justification below.

**Interfaces:**
- Consumes: `useStyles()` → `{ styles, loading, refresh }` (`lib/hooks/useStyles.ts`, pre-Part-D shape — **Part D's Task 2 will need to extend this page too once it adds the `error` field**, noted at the end of this document). `StyleBiblePicker` → `({ styles, value, onChange })` (`app/components/StyleBiblePicker.tsx`, already used by every other style-scoped dashboard page).
- Produces: `POST /api/export` body now includes `styleId`.

- [ ] **Step 1/2: No automated test for this page**

This codebase doesn't unit-test dashboard pages — every other style-scoped page (`generate`, `themes`, `components`, `ui-sheets`) ships with no page-level test. The route-level contract this page depends on (`styleId` required, `ALREADY_EXISTS` handling) is already covered by Task 2's `test/exportRoute.test.ts`. Verify this task by running the dev server and exporting from the page manually instead.

- [ ] **Step 3: Implement**

Replace the whole file:
```tsx
// app/dashboard/export/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

export default function ExportPage() {
  const { styles, loading: stylesLoading } = useStyles();
  const [styleId, setStyleId] = useState('');
  const [subdir, setSubdir] = useState('godot');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ exported: number; skipped: number; targetDir: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!styleId && styles.length > 0) setStyleId(styles[0].id);
  }, [styleId, styles]);

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    if (running || !styleId || !subdir.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleId, subdir: subdir.trim() }),
      });
      const body = await res.json();
      if (body.success) {
        setResult(body.data);
      } else {
        setError(body.error ?? 'Export failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Export</h1>
      <p className="page-subtitle">
        Copy one Style Bible&apos;s active asset images into <code>storage/exports/</code> for your Godot
        project (2D only for V1).
      </p>

      <form className="card" onSubmit={handleExport} style={{ maxWidth: 420 }}>
        <StyleBiblePicker styles={styles} value={styleId} onChange={setStyleId} />

        <div className="field">
          <label htmlFor="subdir">Export folder name</label>
          <input id="subdir" value={subdir} onChange={e => setSubdir(e.target.value)} placeholder="godot" />
        </div>

        <button className="btn btn-primary" type="submit" disabled={running || !styleId || !subdir.trim() || stylesLoading}>
          {running ? 'Exporting…' : 'Export to Godot'}
        </button>

        {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 14 }}>{error}</p>}

        {result && (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 14 }}>
            Exported {result.exported} asset{result.exported === 1 ? '' : 's'}
            {result.skipped > 0 ? ` (${result.skipped} skipped)` : ''} to <code>{result.targetDir}</code>.
          </p>
        )}
      </form>
    </>
  );
}
```

- [ ] **Step 4: Manually verify** — `npm run dev`, open `/dashboard/export`, confirm the dropdown populates and is required before submit.
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add app/dashboard/export/page.tsx
git commit -m "$(cat <<'EOF'
feat: add Style Bible picker to the Godot export page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 4: Enforce creator-or-admin ownership on `AssetService.update()`/`softDelete()`

**Files:**
- Modify: `lib/services/AssetService.ts` (`update`, `softDelete`)
- Modify: `app/api/assets/[id]/route.ts` (PUT/DELETE handlers)
- Modify: `app/api/assets/[id]/component/route.ts` (call-site fixup — this route already has `user` in scope)
- Modify: `lib/services/GitService.ts` (call-site fixup — trusted system reconciliation, bypasses via `isAdmin=true`)
- Modify (call-site fixups for the new required `requestingUserId` param): `test/assetUpdate.test.ts`, `test/assetExportRoute.test.ts`, `test/componentFileRoute.test.ts`, `test/dedupQueries.test.ts`, `test/exportSync.test.ts`, `test/pageRenderRoute.test.ts`, `test/siteExporter.test.ts`, `test/suggestPageLayoutRoute.test.ts`
- Test: `test/assetOwnershipAdminBypass.test.ts` (new)

**Interfaces:**
- Consumes: `getCurrentUser(req)`; mirrors `StyleService.update(id, requestingUserId, patch, isAdmin=false): Promise<Style | {error:'NOT_FOUND'|'FORBIDDEN'}>` exactly.
- Produces (breaking signature change):
  - `AssetService.update(id: string, requestingUserId: string, patch: {...}, isAdmin: boolean = false): Promise<Asset | { error: 'NOT_FOUND' | 'FORBIDDEN' }>` (was `update(id, patch): Promise<Asset | null>`).
  - `AssetService.softDelete(id: string, requestingUserId: string, isAdmin: boolean = false): Promise<void | { error: 'NOT_FOUND' | 'FORBIDDEN' }>` (was `softDelete(id): Promise<void>`).
  - `PUT`/`DELETE /api/assets/[id]` now require login (401) and branch NOT_FOUND→404, FORBIDDEN→403, exactly like `app/api/styles/[id]/route.ts`'s PUT.

- [ ] **Step 1: Write the failing test**
```typescript
// test/assetOwnershipAdminBypass.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { PUT, DELETE } from '@/app/api/assets/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetownership-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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

function putRequest(body: unknown, cookieHeader: string) {
  return new NextRequest('http://localhost/api/assets/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('asset ownership: admin bypass', () => {
  it("lets a non-owner admin edit someone else's asset", async () => {
    const admin = await userService.create({ name: 'Admin' }); // first user created = admin
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);

    const style = await styleService.create({ name: 'S', createdBy: other.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: other.id, assetType: 'button', prompt: "Their asset", imagePath: 'x.png' });

    const res = await PUT(putRequest({ prompt: 'Renamed by admin' }, `session=${token}`), { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.prompt).toBe('Renamed by admin');
  });

  it('still blocks a non-owner, non-admin user from editing', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);

    const style = await styleService.create({ name: 'S', createdBy: owner.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: owner.id, assetType: 'button', prompt: 'Owned', imagePath: 'x.png' });

    const res = await PUT(putRequest({ prompt: 'Should fail' }, `session=${token}`), { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(403);
  });

  it('401s an edit attempt with no session', async () => {
    const owner = await userService.create({ name: 'Owner' });
    const style = await styleService.create({ name: 'S', createdBy: owner.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: owner.id, assetType: 'button', prompt: 'Owned', imagePath: 'x.png' });

    const req = new NextRequest('http://localhost/api/assets/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(401);
  });

  it("lets the admin delete someone else's asset", async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const style = await styleService.create({ name: 'S', createdBy: other.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: other.id, assetType: 'button', prompt: 'Deletable', imagePath: 'x.png' });

    const req = new NextRequest('http://localhost/api/assets/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(200);
  });

  it('still blocks a non-owner, non-admin user from deleting', async () => {
    await userService.create({ name: 'Admin' });
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const style = await styleService.create({ name: 'S', createdBy: owner.id, parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: owner.id, assetType: 'button', prompt: 'Owned', imagePath: 'x.png' });

    const req = new NextRequest('http://localhost/api/assets/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assetOwnershipAdminBypass.test.ts`
Expected: FAIL — every case gets back `200` today (the route never calls `getCurrentUser` and `AssetService.update`/`softDelete` have no ownership concept), so the `401`/`403` expectations fail.

- [ ] **Step 3: Implement**

**3a. `lib/services/AssetService.ts` — `update()`:**
```typescript
// current:
  async update(id: string, patch: {
    prompt?: string;
    assetType?: string;
    nineSliceMargins?: NineSliceMargins | null;
    states?: string[];
    editedExternally?: boolean;
  }): Promise<Asset | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const db = DatabaseConnection.getInstance();
```
Replace with:
```typescript
  /** Only the creator, or an admin, may edit an asset. Mirrors StyleService.update(). */
  async update(id: string, requestingUserId: string, patch: {
    prompt?: string;
    assetType?: string;
    nineSliceMargins?: NineSliceMargins | null;
    states?: string[];
    editedExternally?: boolean;
  }, isAdmin: boolean = false): Promise<Asset | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();
```
(the rest of the method body is unchanged; the final `return this.getById(id);` line stays).

**3b. `lib/services/AssetService.ts` — `softDelete()`:**
```typescript
// current:
  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE assets SET is_deleted = 1 WHERE id = ?').run(id);
  }
```
Replace with:
```typescript
  /** Only the creator, or an admin, may delete an asset. Mirrors update() above. */
  async softDelete(id: string, requestingUserId: string, isAdmin: boolean = false): Promise<void | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE assets SET is_deleted = 1 WHERE id = ?').run(id);
  }
```

**3c. `app/api/assets/[id]/route.ts` — full file:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { NineSliceMarginsSchema } from '@/lib/database/schema';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: asset });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Only the creator (or an admin) may edit — enforced server-side in AssetService.update().
const UpdateAssetSchema = z.object({
  prompt: z.string().min(1).optional(),
  assetType: z.string().min(1).optional(),
  nineSliceMargins: NineSliceMarginsSchema.nullable().optional(),
  states: z.array(z.string()).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const patch = UpdateAssetSchema.parse(await req.json());
    const result = await assetService.update(id, user.id, patch, !!user.is_admin);

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can edit this asset.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const result = await assetService.softDelete(id, user.id, !!user.is_admin);

    if (result && 'error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this asset.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

**3d. `app/api/assets/[id]/component/route.ts`** (already has `user` from its own pre-existing `getCurrentUser` call):
```typescript
// current:
    await assetService.update(id, { editedExternally: trustAsEdited });
```
```typescript
// new:
    await assetService.update(id, user.id, { editedExternally: trustAsEdited }, !!user.is_admin);
```

**3e. `lib/services/GitService.ts`** — `restoreTrustForUnchangedComponents()` runs during git pull/import reconciliation, a trusted system process with no acting user (same category as `cleanupOrphanedImages()`), so it bypasses via `isAdmin=true` rather than threading a real user id through:
```typescript
// current:
        if (hashContent(content) === preHash) {
          await assetService.update(assetId, { editedExternally: true });
        }
```
```typescript
// new:
        if (hashContent(content) === preHash) {
          // Trusted system reconciliation (git pull/import), not a specific
          // user's action — bypasses ownership via isAdmin, same as
          // cleanupOrphanedImages() bypasses the per-user asset model.
          await assetService.update(assetId, asset.created_by, { editedExternally: true }, true);
        }
```

**3f. Existing test call-site fixups** — read each file yourself and add `'user-1'` (or the test's own seeded `userId` where one already exists, e.g. `suggestPageLayoutRoute.test.ts`) as the second argument to every direct `assetService.update(...)`/`assetService.softDelete(...)` call in: `test/assetUpdate.test.ts` (4 call sites), `test/assetExportRoute.test.ts`, `test/componentFileRoute.test.ts`, `test/dedupQueries.test.ts`, `test/exportSync.test.ts` (2 call sites), `test/pageRenderRoute.test.ts`, `test/siteExporter.test.ts` (3 call sites), `test/suggestPageLayoutRoute.test.ts` (use that test's own seeded `userId`, not a literal).

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` — this is the step that catches any caller of `assetService.update`/`softDelete` not listed above; re-grep `assetService\.update\(` and `assetService\.softDelete\(` before committing.

- [ ] **Step 6: Commit**
```bash
git add lib/services/AssetService.ts app/api/assets/[id]/route.ts app/api/assets/[id]/component/route.ts lib/services/GitService.ts test/assetOwnershipAdminBypass.test.ts test/assetUpdate.test.ts test/assetExportRoute.test.ts test/componentFileRoute.test.ts test/dedupQueries.test.ts test/exportSync.test.ts test/pageRenderRoute.test.ts test/siteExporter.test.ts test/suggestPageLayoutRoute.test.ts
git commit -m "$(cat <<'EOF'
fix: enforce creator-or-admin ownership on AssetService.update()/softDelete()

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Move `StyleService.softDelete()`'s ownership check into the service

**Files:**
- Modify: `lib/services/StyleService.ts` (`softDelete`)
- Modify: `app/api/styles/[id]/route.ts` (DELETE handler)
- Test: `test/styleOwnershipAdminBypass.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new — same `getCurrentUser` already used by this file's PUT handler.
- Produces: `StyleService.softDelete(id: string, requestingUserId: string, isAdmin: boolean = false): Promise<void | { error: 'NOT_FOUND' | 'FORBIDDEN' }>` (was `softDelete(id): Promise<void>`). Confirmed via grep this has exactly one caller in source and none in tests. External route behavior (status codes, error messages) is unchanged — the check just moves from the route into the service.

- [ ] **Step 1: Write the failing test**
```typescript
// Add to the existing describe block in test/styleOwnershipAdminBypass.test.ts,
// after the "lets the admin delete someone else's style" test:
  it('still blocks a non-owner, non-admin user from deleting', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const style = await styleService.create({ name: 'Owned', createdBy: owner.id, parameters: '{}' });

    const req = new NextRequest('http://localhost/api/styles/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(403);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/styleOwnershipAdminBypass.test.ts`
Expected: this specific case actually already PASSES today, since the route currently does its own `existing.created_by !== user.id && !user.is_admin` check before calling `softDelete(id)`. This task is a refactor for consistency with the "enforced server-side in the service" convention, not a behavior fix — confirm the full file (including the new test) is green before refactoring, then re-run after Step 3 to confirm it's still green.

- [ ] **Step 3: Implement**

**3a. `lib/services/StyleService.ts`:**
```typescript
// current:
  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE styles SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
```
Replace with:
```typescript
  /** Only the creator, or an admin, may delete a style. Mirrors update() above. */
  async softDelete(id: string, requestingUserId: string, isAdmin: boolean = false): Promise<void | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE styles SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
```

**3b. `app/api/styles/[id]/route.ts` — DELETE handler:**
```typescript
// current:
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const existing = await styleService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    if (existing.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this style.',
      }, { status: 403 });
    }

    await styleService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```
Replace with (branches on the `{error:...}` result exactly like this same file's PUT handler does):
```typescript
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const result = await styleService.softDelete(id, user.id, !!user.is_admin);

    if (result && 'error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this style.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/services/StyleService.ts app/api/styles/[id]/route.ts test/styleOwnershipAdminBypass.test.ts
git commit -m "$(cat <<'EOF'
fix: move StyleService.softDelete() ownership check server-side into the service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 6: Add creator-or-admin ownership checks to job-mutating routes

**Files:**
- Modify: `app/api/jobs/[id]/route.ts` (DELETE)
- Modify: `app/api/jobs/[id]/component/route.ts` (PATCH)
- Modify: `app/api/jobs/[id]/component/reset/route.ts` (POST)
- Modify: `app/api/jobs/[id]/theme/route.ts` (PATCH)
- Modify: `app/api/jobs/[id]/theme/reset/route.ts` (POST)
- Modify: `app/api/jobs/retry/route.ts` (POST)
- Test: `test/jobOwnership.test.ts` (new)

**Interfaces:**
- Consumes: `getCurrentUser(req)`; `Job.created_by: string`; `jobService.getById(id)` (unchanged).
- Produces: all 6 routes now 401 when not logged in and 403 a non-owner/non-admin before any mutation. Enforced at the route layer (not inside `JobService`, which has no shared mutation method these routes go through — only `delete()`/`resetForRetry()` are service methods, each with one caller). GET routes are unchanged.

- [ ] **Step 1: Write the failing test**
```typescript
// test/jobOwnership.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { DELETE as deleteJob } from '@/app/api/jobs/[id]/route';
import { PATCH as patchComponent } from '@/app/api/jobs/[id]/component/route';
import { POST as resetComponent } from '@/app/api/jobs/[id]/component/reset/route';
import { PATCH as patchTheme } from '@/app/api/jobs/[id]/theme/route';
import { POST as resetTheme } from '@/app/api/jobs/[id]/theme/reset/route';
import { POST as retryJob } from '@/app/api/jobs/retry/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobownership-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
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

async function makeJob(ownerId: string): Promise<{ id: string }> {
  const style = await styleService.create({ name: 'x', createdBy: ownerId, parameters: '{}' });
  return jobService.create({ styleId: style.id, createdBy: ownerId, assetType: 'sprite', prompt: 'x' });
}

async function seedOwnerAndStranger() {
  await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
  const owner = await userService.create({ name: 'Owner' });
  const stranger = await userService.create({ name: 'Stranger' });
  const { token } = await sessionService.create(stranger.id);
  return { owner, stranger, cookieHeader: `session=${token}` };
}

describe('job ownership — DELETE /api/jobs/[id]', () => {
  it('401s when not logged in', async () => {
    const job = await makeJob('user-1');
    const res = await deleteJob(new NextRequest(`http://localhost/api/jobs/${job.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(401);
  });

  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/api/jobs/${job.id}`, { method: 'DELETE', headers: { Cookie: cookieHeader } });
    const res = await deleteJob(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — PATCH /api/jobs/[id]/component', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ html: '<div></div>', css: '' }),
    });
    const res = await patchComponent(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — POST /api/jobs/[id]/component/reset', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, { method: 'POST', headers: { Cookie: cookieHeader } });
    const res = await resetComponent(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — PATCH /api/jobs/[id]/theme', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({}),
    });
    const res = await patchTheme(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — POST /api/jobs/[id]/theme/reset', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest(`http://localhost/x`, { method: 'POST', headers: { Cookie: cookieHeader } });
    const res = await resetTheme(req, { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(403);
  });
});

describe('job ownership — POST /api/jobs/retry', () => {
  it('403s a non-owner, non-admin user', async () => {
    const { owner, cookieHeader } = await seedOwnerAndStranger();
    const job = await makeJob(owner.id);
    const req = new NextRequest('http://localhost/api/jobs/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ jobId: job.id }),
    });
    const res = await retryJob(req);
    expect(res.status).toBe(403);
  });

  it('lets a non-owner admin retry it', async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const job = await makeJob(other.id);
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
    const req = new NextRequest('http://localhost/api/jobs/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `session=${token}` },
      body: JSON.stringify({ jobId: job.id }),
    });
    const res = await retryJob(req);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jobOwnership.test.ts`
Expected: FAIL — every 401/403 expectation currently gets back `200` (DELETE) or whatever status the existing status/shape checks produce (PATCH/POST), since none of these routes call `getCurrentUser` today.

- [ ] **Step 3: Implement**

For each of the 6 files, add the import `import { getCurrentUser } from '@/lib/utils/session';` and, immediately after fetching the job and confirming it exists, insert:
```typescript
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
```
(placed as the FIRST check, before the job lookup, in every handler — read each file's current code and place it right after the `try {`), and after the `if (!job) { ... 404 ... }` check in each:
```typescript
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can <verb> this job.' }, { status: 403 });
    }
```
using the appropriate verb per route (`edit this job` for PATCH component/theme, `reset this job` for the two reset routes, `delete this job` for DELETE, `retry this job` for retry — added in Task 7, not here). Change each handler's first parameter from `_req: NextRequest` to `req: NextRequest` where it was previously unused (several of these routes currently ignore the request object entirely).

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add app/api/jobs/[id]/route.ts app/api/jobs/[id]/component/route.ts app/api/jobs/[id]/component/reset/route.ts app/api/jobs/[id]/theme/route.ts app/api/jobs/[id]/theme/reset/route.ts app/api/jobs/retry/route.ts test/jobOwnership.test.ts
git commit -m "$(cat <<'EOF'
fix: require creator-or-admin ownership on all job-mutating routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add a server-side status guard to `jobs/retry`

**Depends on Task 6** (the route now has `getCurrentUser`/ownership wiring to build on).

**Files:**
- Modify: `app/api/jobs/retry/route.ts`
- Test: `test/jobRetryStatusGuard.test.ts` (new)

**Interfaces:**
- Consumes: `Job.status: 'pending'|'processing'|'complete'|'promoted'|'discarded'|'failed'`. Allowed-status set derived from `app/components/JobCard.tsx`'s `canAct = job.status === 'complete' || job.status === 'failed'`, which gates the Retry button.
- Produces: `POST /api/jobs/retry` now 409s (`'Only a completed or failed job can be retried'`) for a job in `pending`/`processing`/`promoted`/`discarded`.

- [ ] **Step 1: Write the failing test**
```typescript
// test/jobRetryStatusGuard.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { seedSession } from '@/test/helpers/testSession';
import { POST } from '@/app/api/jobs/retry/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobretryguard-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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

async function makeJobWithStatus(ownerId: string, status: string) {
  const style = await styleService.create({ name: 'x', createdBy: ownerId, parameters: '{}' });
  const job = await jobService.create({ styleId: style.id, createdBy: ownerId, assetType: 'sprite', prompt: 'x' });
  DatabaseConnection.getInstance().prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, job.id);
  return job;
}

function retryRequest(jobId: string, cookieHeader: string) {
  return new NextRequest('http://localhost/api/jobs/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ jobId }),
  });
}

describe('POST /api/jobs/retry — status guard', () => {
  it('409s a pending job instead of resetting it mid-flight', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'pending');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(409);
  });

  it('409s a processing job instead of resetting it mid-flight', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'processing');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(409);
  });

  it('409s an already-promoted job', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'promoted');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(409);
  });

  it('allows retrying a failed job', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'failed');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(200);
  });

  it('allows retrying a completed job (re-rolling a candidate the user does not want)', async () => {
    const { userId, cookieHeader } = await seedSession();
    const job = await makeJobWithStatus(userId, 'complete');
    const res = await POST(retryRequest(job.id, cookieHeader));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jobRetryStatusGuard.test.ts`
Expected: FAIL — the `pending`/`processing`/`promoted` cases get back `200` today (no status guard exists).

- [ ] **Step 3: Implement**

After the ownership check added in Task 6 (`if (job.created_by !== user.id && !user.is_admin) { ... 403 ... }`), add:
```typescript
    if (job.status !== 'complete' && job.status !== 'failed') {
      return NextResponse.json({ success: false, error: 'Only a completed or failed job can be retried' }, { status: 409 });
    }
```
before the existing "free the old attempt's image" block.

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add app/api/jobs/retry/route.ts test/jobRetryStatusGuard.test.ts
git commit -m "$(cat <<'EOF'
fix: reject retry on a job that is not complete or failed

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Wrap `auth/me`, `drive/status`, and drive thumbnail in try/catch

**Files:**
- Modify: `app/api/auth/me/route.ts`
- Modify: `app/api/drive/status/route.ts`
- Modify: `app/api/drive/files/[id]/thumbnail/route.ts`
- Test: `test/authMeRoute.test.ts`, `test/driveAuthRoutes.test.ts`, `test/driveThumbnailRoute.test.ts` (each extended)

**Interfaces:**
- Consumes: nothing new.
- Produces: all three routes now return `{success:false, error: string}` at status 500 when the underlying call throws, instead of an unhandled rejection reaching Next's default error page.

- [ ] **Step 1: Write the failing test**
```typescript
// Add to test/authMeRoute.test.ts (add `vi` to its existing vitest import line),
// inside the existing describe('GET /api/auth/me', ...) block:
  it('returns a clean 500 instead of crashing when the session lookup throws', async () => {
    const { sessionService } = await import('@/lib/services/SessionService');
    const spy = vi.spyOn(sessionService, 'getUserByToken').mockRejectedValueOnce(new Error('db exploded'));
    const req = new NextRequest('http://localhost/api/auth/me', { headers: { Cookie: 'session=whatever' } });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    spy.mockRestore();
  });
```
```typescript
// Add to test/driveAuthRoutes.test.ts, inside the existing describe('GET /api/drive/status', ...) block:
  it('returns a clean 500 instead of crashing when the Drive check throws', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    const spy = vi.spyOn(driveService, 'isConnected').mockRejectedValueOnce(new Error('drive unreachable'));
    const { GET } = await import('@/app/api/drive/status/route');
    const req = new NextRequest('http://localhost/api/drive/status', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    spy.mockRestore();
  });
```
```typescript
// Add to test/driveThumbnailRoute.test.ts, inside the existing describe block:
  it('returns a clean 500 instead of crashing when the Drive lookup throws', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.getThumbnail).mockRejectedValue(new Error('drive unreachable'));

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/authMeRoute.test.ts test/driveAuthRoutes.test.ts test/driveThumbnailRoute.test.ts`
Expected: FAIL — each new test currently throws an unhandled rejection out of the route handler.

- [ ] **Step 3: Implement**

**3a. `app/api/auth/me/route.ts`** — wrap the existing body in try/catch:
```typescript
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: true, data: null });
    }
    return NextResponse.json({
      success: true,
      data: { id: user.id, name: user.name, isAdmin: !!user.is_admin },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

**3b. `app/api/drive/status/route.ts`** — same pattern:
```typescript
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    const connected = await driveService.isConnected();
    return NextResponse.json({ success: true, data: { connected } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

**3c. `app/api/drive/files/[id]/thumbnail/route.ts`** — same pattern, wrapping the existing body including the `Readable.toWeb(...)` response construction:
```typescript
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const thumbnail = await driveService.getThumbnail(id);
    if (!thumbnail) {
      return NextResponse.json({ success: false, error: 'No thumbnail available' }, { status: 404 });
    }

    return new NextResponse(Readable.toWeb(thumbnail.stream) as any, {
      headers: { 'Content-Type': thumbnail.mimeType },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add app/api/auth/me/route.ts app/api/drive/status/route.ts app/api/drive/files/[id]/thumbnail/route.ts test/authMeRoute.test.ts test/driveAuthRoutes.test.ts test/driveThumbnailRoute.test.ts
git commit -m "$(cat <<'EOF'
fix: wrap auth/me, drive/status, and drive thumbnail routes in try/catch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Wrap `drive/connect` and `drive/callback` in try/catch with redirect-based error handling

**Files:**
- Modify: `app/api/drive/connect/route.ts`
- Modify: `app/api/drive/callback/route.ts`
- Test: `test/driveAuthRoutes.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: both routes now redirect to `/dashboard/settings/google-drive?error=server_error` on an unexpected throw, instead of letting the exception propagate — these are hit by direct browser navigation (an OAuth redirect flow), not `fetch()`.

- [ ] **Step 1: Write the failing test**
```typescript
// Add to the existing describe('GET /api/drive/connect', ...) block:
  it('redirects with an error indicator instead of crashing when the session lookup throws', async () => {
    const { sessionService } = await import('@/lib/services/SessionService');
    const spy = vi.spyOn(sessionService, 'getUserByToken').mockRejectedValueOnce(new Error('db exploded'));
    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=');
    spy.mockRestore();
  });

// Add to the existing describe('GET /api/drive/callback', ...) block:
  it('redirects with an error indicator instead of crashing when the session lookup throws', async () => {
    const { sessionService } = await import('@/lib/services/SessionService');
    const spy = vi.spyOn(sessionService, 'getUserByToken').mockRejectedValueOnce(new Error('db exploded'));
    const { GET } = await import('@/app/api/drive/callback/route');
    const req = new NextRequest('http://localhost/api/drive/callback?code=fake-code', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=');
    spy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/driveAuthRoutes.test.ts`
Expected: FAIL — `getCurrentUser(req)` throwing propagates unhandled out of both handlers today.

- [ ] **Step 3: Implement**

**3a. `app/api/drive/connect/route.ts`** — wrap the whole handler in an outer try/catch, leaving the existing inner try/catch for `getAuthUrl()`'s own `not_configured` case untouched:
```typescript
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    try {
      return NextResponse.redirect(driveService.getAuthUrl());
    } catch (e) {
      console.error('Failed to build Google Drive auth URL:', e);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=not_configured', req.url));
    }
  } catch (e) {
    console.error('Unexpected error in Drive connect route:', e);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=server_error', req.url));
  }
}
```

**3b. `app/api/drive/callback/route.ts`** — same outer-try/catch shape, keeping the existing `missing_code`/`exchange_failed` handling untouched:
```typescript
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const code = req.nextUrl.searchParams.get('code');
    if (!code) {
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=missing_code', req.url));
    }

    try {
      await driveService.exchangeCodeForTokens(code);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive', req.url));
    } catch (e: any) {
      console.error('Failed to exchange Google Drive OAuth code:', e);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=exchange_failed', req.url));
    }
  } catch (e) {
    console.error('Unexpected error in Drive callback route:', e);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=server_error', req.url));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add app/api/drive/connect/route.ts app/api/drive/callback/route.ts test/driveAuthRoutes.test.ts
git commit -m "$(cat <<'EOF'
fix: redirect with error=server_error instead of crashing on Drive OAuth routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

**Notes on explicitly out-of-scope items (Part A):** `app/api/git/{push,abort,resolve}/route.ts` — confirmed orphaned, no UI caller, no action; flag for a future conflict-resolution-UI decision. `app/api/context/route.ts` — confirmed intentional external-facing route (documented in its own comment), no action. `lib/services/DriveService.ts`'s single shared OAuth token — confirmed reasonable for a no-auth single-workspace tool, no action.

## Part B: Soft-Delete Integrity, Test Coverage, and Cleanup

### Task 10: `StyleService.getActiveById()` + fix `fork()` to respect soft-delete

**Files:**
- Modify: `lib/services/StyleService.ts` (`getById`/`fork` region — does not overlap with Part A's edits to `update()`/`softDelete()`)
- Test: `test/styleServiceFork.test.ts` (new)

**Interfaces:**
- Consumes: `DatabaseConnection.getInstance()`, `StyleSchema.parse`.
- Produces: `styleService.getActiveById(id: string): Promise<Style | null>` (new). `styleService.fork(id: string, newOwnerId: string): Promise<Style | { error: 'NOT_FOUND' }>` (unchanged signature, changed behavior — now returns `NOT_FOUND` for a soft-deleted style instead of forking it). **Tasks 11 and 12 depend on this.**

- [ ] **Step 1: Write the failing test**
```typescript
// test/styleServiceFork.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-styleforkactive-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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

describe('StyleService.getActiveById', () => {
  it('returns the style when active', async () => {
    const style = await styleService.create({ name: 'Active', createdBy: 'user-1', parameters: '{}' });
    expect((await styleService.getActiveById(style.id))?.id).toBe(style.id);
  });

  it('returns null for a soft-deleted style', async () => {
    const style = await styleService.create({ name: 'Gone', createdBy: 'user-1', parameters: '{}' });
    // Note: after Part A Task 5, softDelete() requires (id, requestingUserId) —
    // pass the style's own creator.
    await styleService.softDelete(style.id, 'user-1');
    expect(await styleService.getActiveById(style.id)).toBeNull();
  });

  it('returns null for a nonexistent id', async () => {
    expect(await styleService.getActiveById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('StyleService.fork', () => {
  it('forks an active style (pre-existing behavior, unchanged)', async () => {
    const original = await styleService.create({ name: 'Original', createdBy: 'user-1', parameters: '{"x":1}' });
    const forked = await styleService.fork(original.id, 'user-2');
    expect('error' in forked).toBe(false);
    if ('error' in forked) return;
    expect(forked.name).toBe('Original (fork)');
    expect(forked.created_by).toBe('user-2');
    expect(forked.forked_from).toBe(original.id);
  });

  it("refuses to fork a soft-deleted style — this is the behavior change: fork() used to call getById(), which happily forked a deleted style", async () => {
    const original = await styleService.create({ name: 'Deleted', createdBy: 'user-1', parameters: '{}' });
    await styleService.softDelete(original.id, 'user-1');

    const result = await styleService.fork(original.id, 'user-2');
    expect(result).toEqual({ error: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/styleServiceFork.test.ts`
Expected: FAIL — the three `getActiveById` tests fail with `TypeError: styleService.getActiveById is not a function`. The "refuses to fork" test fails with the forked style object instead of `{error: 'NOT_FOUND'}` (current `fork()` still uses `getById`, which finds the soft-deleted row and forks it anyway). The "forks an active style" test already passes — unaffected behavior, included as a regression guard.

- [ ] **Step 3: Implement**

Add `getActiveById` right after the existing `getById` method:
```typescript
// current (getById):
  async getById(id: string): Promise<Style | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
    return row ? StyleSchema.parse(row) : null;
  }

// replacement — add getActiveById right after getById:
  async getById(id: string): Promise<Style | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
    return row ? StyleSchema.parse(row) : null;
  }

  /** Like getById, but returns null for a soft-deleted style — mirrors getActiveStyles()'s is_deleted = 0 filter, scoped to one id. */
  async getActiveById(id: string): Promise<Style | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM styles WHERE id = ? AND is_deleted = 0').get(id);
    return row ? StyleSchema.parse(row) : null;
  }
```
```typescript
// current (inside fork()):
  async fork(id: string, newOwnerId: string): Promise<Style | { error: 'NOT_FOUND' }> {
    const original = await this.getById(id);
    if (!original) return { error: 'NOT_FOUND' };

// replacement:
  async fork(id: string, newOwnerId: string): Promise<Style | { error: 'NOT_FOUND' }> {
    const original = await this.getActiveById(id);
    if (!original) return { error: 'NOT_FOUND' };
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/services/StyleService.ts test/styleServiceFork.test.ts
git commit -m "$(cat <<'EOF'
fix: StyleService.fork() now refuses a soft-deleted style via new getActiveById()

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `PresetService.applyPreset()` — verify `existingStyleId` is still active

**Depends on Task 10** (`styleService.getActiveById`).

**Files:**
- Modify: `lib/services/PresetService.ts` (`applyPreset`)
- Test: `test/presetApply.test.ts` (extend)

**Interfaces:**
- Consumes: `styleService.getActiveById(id: string): Promise<Style | null>` (Task 10).
- Produces: `presetService.applyPreset(...)` — same return-type union as today (`STYLE_NOT_FOUND` already exists in it), only the soft-delete check is now correct.

- [ ] **Step 1: Write the failing test**
```typescript
// test/presetApply.test.ts — add after the existing
// "returns STYLE_NOT_FOUND for a nonexistent existingStyleId" test:
  it("returns STYLE_NOT_FOUND for a soft-deleted existingStyleId — this is the behavior change: applyPreset() used to call styleService.getById(), which happily queued jobs against a deleted style", async () => {
    const existing = await styleService.create({ name: 'Deleted Bible', createdBy: 'user-1', parameters: '{}' });
    await styleService.softDelete(existing.id, 'user-1');
    const preset = await makeFullPreset();

    const result = await presetService.applyPreset(preset.id, { existingStyleId: existing.id }, 'user-1');
    expect(result).toEqual({ error: 'STYLE_NOT_FOUND' });

    const db = DatabaseConnection.getInstance();
    const jobCount = (db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;
    expect(jobCount).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/presetApply.test.ts`
Expected: FAIL with the preset successfully applying and queueing 3 jobs instead of returning `STYLE_NOT_FOUND` — `getById` still finds the soft-deleted row.

- [ ] **Step 3: Implement**
```typescript
// current:
    if (target.existingStyleId) {
      const existing = await styleService.getById(target.existingStyleId);
      if (!existing) return { error: 'STYLE_NOT_FOUND' };
    }

// replacement:
    if (target.existingStyleId) {
      const existing = await styleService.getActiveById(target.existingStyleId);
      if (!existing) return { error: 'STYLE_NOT_FOUND' };
    }
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/services/PresetService.ts test/presetApply.test.ts
git commit -m "$(cat <<'EOF'
fix: applyPreset() refuses a soft-deleted existingStyleId

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `SiteExporter.exportSite()` — refuse a soft-deleted style

**Depends on Task 10** (`styleService.getActiveById`).

**Files:**
- Modify: `lib/services/SiteExporter.ts` (import block + top of `exportSite`)
- Modify: `app/api/styles/[id]/site-export/route.ts` (`ExportSiteErrorKind`/`ERROR_MESSAGES`)
- Test: `test/siteExporter.test.ts` (append), `test/siteExportRoute.test.ts` (append)

**Interfaces:**
- Consumes: `styleService.getActiveById(id: string): Promise<Style | null>` (Task 10).
- Produces: `siteExporter.exportSite(styleId, subdir): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS' | 'STYLE_NOT_FOUND' }>` — new `STYLE_NOT_FOUND` case added to the union.

- [ ] **Step 1: Write the failing test**
```typescript
// test/siteExporter.test.ts — append:
describe("SiteExporter.exportSite() refuses a soft-deleted style", () => {
  it("returns STYLE_NOT_FOUND instead of exporting — this is the behavior change: exportSite() never checked the style itself, only pageService.getActivePagesForStyle()", async () => {
    const style = await styleService.create({ name: 'Deleted Bible', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await styleService.softDelete(style.id, 'user-1');

    const result = await siteExporter.exportSite(style.id, 'deleted-style-export');
    expect(result).toEqual({ error: 'STYLE_NOT_FOUND' });
  });
});
```
```typescript
// test/siteExportRoute.test.ts — append:
  it('returns 400 (STYLE_NOT_FOUND) for a soft-deleted style', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await styleService.softDelete(style.id, 'user-1');
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: 'deleted-route-test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('This Style Bible was deleted.');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/siteExporter.test.ts test/siteExportRoute.test.ts`
Expected: FAIL — `exportSite()` returns a successful export result instead of `{error: 'STYLE_NOT_FOUND'}`; the route test gets `200` instead of `400`.

- [ ] **Step 3: Implement**
```typescript
// lib/services/SiteExporter.ts — add to the import block:
import { styleService } from '@/lib/services/StyleService';
```
```typescript
// current (top of exportSite):
  async exportSite(styleId: string, subdir: string): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS' }> {
    if (!SUBDIR_PATTERN.test(subdir)) {
      return { error: 'INVALID_SUBDIR' };
    }

    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');

// replacement:
  async exportSite(styleId: string, subdir: string): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS' | 'STYLE_NOT_FOUND' }> {
    if (!SUBDIR_PATTERN.test(subdir)) {
      return { error: 'INVALID_SUBDIR' };
    }

    if (!(await styleService.getActiveById(styleId))) {
      return { error: 'STYLE_NOT_FOUND' };
    }

    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');
```
```typescript
// app/api/styles/[id]/site-export/route.ts — current:
type ExportSiteErrorKind = 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS';

const ERROR_MESSAGES: Record<ExportSiteErrorKind, string> = {
  NOTHING_TO_EXPORT: 'This Style Bible has no pages to export.',
  ALREADY_EXISTS: 'That folder name is already used — pick another.',
  INVALID_SUBDIR: 'subdir must contain only lowercase letters, numbers, and hyphens.',
  EXPORT_IN_PROGRESS: 'Another export to this folder is already running — try again in a moment.',
};

// replacement:
type ExportSiteErrorKind = 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS' | 'STYLE_NOT_FOUND';

const ERROR_MESSAGES: Record<ExportSiteErrorKind, string> = {
  NOTHING_TO_EXPORT: 'This Style Bible has no pages to export.',
  ALREADY_EXISTS: 'That folder name is already used — pick another.',
  INVALID_SUBDIR: 'subdir must contain only lowercase letters, numbers, and hyphens.',
  EXPORT_IN_PROGRESS: 'Another export to this folder is already running — try again in a moment.',
  STYLE_NOT_FOUND: 'This Style Bible was deleted.',
};
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/services/SiteExporter.ts app/api/styles/[id]/site-export/route.ts test/siteExporter.test.ts test/siteExportRoute.test.ts
git commit -m "$(cat <<'EOF'
fix: exportSite() refuses a soft-deleted style

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `JobService` — add direct unit test coverage

**Files:**
- Test: `test/jobService.test.ts` (new) — no production code change.

**Interfaces:**
- Consumes: `jobService.resetForRetry(id)`, `jobService.delete(id)`, `jobService.getByBatchId(batchId)` — all already implemented, unchanged.

**Note on the TDD cycle:** this is a coverage gap, not a bug — `resetForRetry`, `delete`, and `getByBatchId` already behave correctly. Step 2 below is expected to pass immediately; included for completeness, not because a failure is anticipated.

- [ ] **Step 1: Write the test**
```typescript
// test/jobService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;
const STYLE_ID = '55555555-5555-5555-5555-555555555555';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobservice-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'test style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('JobService.resetForRetry', () => {
  it('clears result_path and sets status back to pending', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'failed', result_path = 'some-old-file.png' WHERE id = ?`).run(job.id);

    const reset = await jobService.resetForRetry(job.id);
    expect(reset?.status).toBe('pending');
    expect(reset?.result_path).toBeNull();
  });
});

describe('JobService.delete', () => {
  it('removes the row entirely (a hard delete, not a soft-delete)', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' });

    await jobService.delete(job.id);

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT id FROM jobs WHERE id = ?').get(job.id);
    expect(row).toBeUndefined();
    expect(await jobService.getById(job.id)).toBeNull();
  });
});

describe('JobService.getByBatchId', () => {
  it('returns only the jobs sharing that batch id, not sibling jobs from a different batch', async () => {
    const db = DatabaseConnection.getInstance();
    const batchA = '66666666-6666-6666-6666-666666666666';
    const batchB = '77777777-7777-7777-7777-777777777777';

    const jobA1 = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a' });
    const jobA2 = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'b' });
    const jobB1 = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'c' });

    db.prepare('UPDATE jobs SET batch_id = ? WHERE id IN (?, ?)').run(batchA, jobA1.id, jobA2.id);
    db.prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchB, jobB1.id);

    const batchAJobs = await jobService.getByBatchId(batchA);
    expect(batchAJobs.map(j => j.id).sort()).toEqual([jobA1.id, jobA2.id].sort());
    expect(batchAJobs.map(j => j.id)).not.toContain(jobB1.id);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/jobService.test.ts`
Expected: PASS immediately — confirms existing behavior.

- [ ] **Step 3-4: N/A** — no production code change.
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add test/jobService.test.ts
git commit -m "$(cat <<'EOF'
test: add direct unit coverage for JobService.resetForRetry/delete/getByBatchId

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 14: `GitService.exportToJson()` — collapse 5 identical loops into 1

**Files:**
- Modify: `lib/services/GitService.ts` (`exportToJson` — does not overlap with Part A's edit to `restoreTrustForUnchangedComponents`)
- Test: `test/gitServiceExportRefactor.test.ts` (new)

**Interfaces:**
- Consumes: `styleService.getAll()`, `assetService.getAll()`, `userService.getAll()`, `presetService.getAll()`, `pageService.getAll()` — all unchanged.
- Produces: `gitService.exportToJson(): Promise<void>` — identical output, refactored implementation. `importFromJson()` is untouched.

- [ ] **Step 1: Write the failing test**
```typescript
// test/gitServiceExportRefactor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { userService } from '@/lib/services/UserService';
import { presetService } from '@/lib/services/PresetService';
import { pageService } from '@/lib/services/PageService';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitexportrefactor-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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

describe('GitService.exportToJson() — one loop over descriptors instead of five near-identical ones', () => {
  it('writes byte-identical JSON for one of each entity type (style, asset, user, preset, page)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin', imagePath: 'goblin.png' });
    const user = await userService.create({ name: 'Alice' });
    const preset = await presetService.create({
      name: 'Landing', createdBy: 'user-1', prompt: 'p', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });

    await gitService.exportToJson();

    const expectations: { dir: string; file: string; entity: unknown }[] = [
      { dir: 'styles', file: `style-${style.id}.json`, entity: style },
      { dir: 'assets', file: `asset-${asset.id}.json`, entity: asset },
      { dir: 'users', file: `user-${user.id}.json`, entity: user },
      { dir: 'presets', file: `preset-${preset.id}.json`, entity: preset },
      { dir: 'pages', file: `page-${page.id}.json`, entity: page },
    ];

    for (const { dir, file, entity } of expectations) {
      const content = await fsPromises.readFile(path.join(tempRoot, 'data', dir, file), 'utf-8');
      expect(content).toBe(JSON.stringify(entity, null, 2));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/gitServiceExportRefactor.test.ts`
Expected: this test actually PASSES against today's unrefactored code too (it describes *current* behavior, which the refactor must preserve byte-for-byte). Run it once before refactoring to confirm it's green, then treat any red after Step 3 as a refactor regression to fix.

- [ ] **Step 3: Implement**
```typescript
// lib/services/GitService.ts — current (exportToJson):
  async exportToJson(): Promise<void> {
    await this.ensureDirectoriesExist();

    const styles = await styleService.getAll();
    const assets = await assetService.getAll();
    const users = await userService.getAll();
    const presets = await presetService.getAll();
    const pages = await pageService.getAll();

    const stylesDir = path.join(getProjectRoot(), 'data', 'styles');
    const assetsDir = path.join(getProjectRoot(), 'data', 'assets');
    const usersDir = path.join(getProjectRoot(), 'data', 'users');
    const presetsDir = path.join(getProjectRoot(), 'data', 'presets');
    const pagesDir = path.join(getProjectRoot(), 'data', 'pages');

    for (const style of styles) {
      const filePath = path.join(stylesDir, `style-${style.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(style, null, 2), 'utf-8');
    }

    for (const asset of assets) {
      const filePath = path.join(assetsDir, `asset-${asset.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(asset, null, 2), 'utf-8');
    }

    for (const user of users) {
      const filePath = path.join(usersDir, `user-${user.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(user, null, 2), 'utf-8');
    }

    for (const preset of presets) {
      const filePath = path.join(presetsDir, `preset-${preset.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(preset, null, 2), 'utf-8');
    }

    for (const page of pages) {
      const filePath = path.join(pagesDir, `page-${page.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(page, null, 2), 'utf-8');
    }
  }

// replacement:
  async exportToJson(): Promise<void> {
    await this.ensureDirectoriesExist();

    const exportGroups: { items: { id: string }[]; dir: string; prefix: string }[] = [
      { items: await styleService.getAll(), dir: 'styles', prefix: 'style' },
      { items: await assetService.getAll(), dir: 'assets', prefix: 'asset' },
      { items: await userService.getAll(), dir: 'users', prefix: 'user' },
      { items: await presetService.getAll(), dir: 'presets', prefix: 'preset' },
      { items: await pageService.getAll(), dir: 'pages', prefix: 'page' },
    ];

    for (const { items, dir, prefix } of exportGroups) {
      const targetDir = path.join(getProjectRoot(), 'data', dir);
      for (const item of items) {
        const filePath = path.join(targetDir, `${prefix}-${item.id}.json`);
        await fsPromises.writeFile(filePath, JSON.stringify(item, null, 2), 'utf-8');
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it still passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/services/GitService.ts test/gitServiceExportRefactor.test.ts
git commit -m "$(cat <<'EOF'
refactor: collapse GitService.exportToJson()'s 5 identical loops into 1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Delete `UserService.getActiveUsers()` — point its one caller at `getAll()`

**Files:**
- Modify: `lib/services/UserService.ts`
- Modify: `app/login/page.tsx` (or `LoginForm.tsx` — verify the exact caller file yourself; the audit named `app/login/page.tsx`)
- Test: `test/userService.test.ts` (remove the stale assertion, add the new one)

**Interfaces:**
- Produces: `userService.getActiveUsers` removed entirely; the login page now calls `userService.getAll()` directly.

- [ ] **Step 1: Write the failing test**
```typescript
// test/userService.test.ts — add inside the existing describe('userService reads', ...) block:
  it('no longer exposes getActiveUsers — getAll() is the single source of truth now that the only caller (login page) was migrated to it', () => {
    expect((userService as any).getActiveUsers).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/userService.test.ts`
Expected: FAIL with `expected [Function] to be undefined`.

- [ ] **Step 3: Implement**
```typescript
// lib/services/UserService.ts — current:
  /** No soft-delete concept for users (unlike styles/assets) — this exists
   *  so call sites can express "the users I'd show someone" without
   *  assuming getAll()'s shape is stable long-term. */
  async getActiveUsers(): Promise<User[]> {
    return this.getAll();
  }

// replacement: delete this method entirely.
```
```typescript
// app/login/page.tsx (or LoginForm.tsx, wherever the real caller is) — current:
  const users = await userService.getActiveUsers();

// replacement:
  const users = await userService.getAll();
```
```typescript
// test/userService.test.ts — also remove the now-stale line inside
// describe('userService reads', ...) → it('getAll returns every user, ...'):
    expect((await userService.getActiveUsers()).length).toBe(2);
// (delete this line — getAll() is already asserted immediately above it)
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/services/UserService.ts app/login/page.tsx test/userService.test.ts
git commit -m "$(cat <<'EOF'
refactor: delete UserService.getActiveUsers(), point the login page at getAll()

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: `createPlaceholderPng()` — drop the always-identical `fill` parameter

**Files:**
- Modify: `lib/utils/placeholderImage.ts` (whole file)
- Modify: `lib/services/ImageGenerator.ts` (the two `createPlaceholderPng(...)` call sites only — does not overlap with the AI-pipeline section's edit to the `GenerateOptions`-consuming parts of this same file in Part C Task 6)
- Test: `test/placeholderImage.test.ts` (new)

**Interfaces:**
- Produces: `createPlaceholderPng(size: number): Buffer` — `fill` parameter removed (both call sites always passed the identical literal `[0xe8, 0xa3, 0x3d, 0xff]`). `size` is untouched — it genuinely varies per call and must stay a parameter.

- [ ] **Step 1: Write the failing test**
```typescript
// test/placeholderImage.test.ts
import { describe, it, expect } from 'vitest';
import { createPlaceholderPng } from '@/lib/utils/placeholderImage';

describe('createPlaceholderPng', () => {
  it('draws a valid PNG with only a size argument — the fill color was always the same literal at both call sites', () => {
    const png = createPlaceholderPng(4);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/placeholderImage.test.ts`
Expected: FAIL with `TypeError: Cannot read properties of undefined (reading '0')` — today's signature still requires `fill`.

- [ ] **Step 3: Implement**

Replace the whole file:
```typescript
// lib/utils/placeholderImage.ts
import zlib from 'zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// GameForge's own --accent amber, so a mock placeholder reads as
// "this is a stand-in," not a broken/empty image — the only fill color
// either call site in ImageGenerator.ts ever passed, so it's a constant
// here instead of a parameter.
const FILL: [number, number, number, number] = [0xe8, 0xa3, 0x3d, 0xff];

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Hand-rolled minimal PNG encoder (signature + IHDR + IDAT + IEND) —
 * no image library needed for a solid-color placeholder. Draws a
 * bordered square so a mock generation is visibly a placeholder, not
 * an empty/broken image.
 */
export function createPlaceholderPng(size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const border = [0x3c, 0x35, 0x2a, 0xff]; // matches the app's --border token
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const onEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const px = onEdge ? border : FILL;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = px[0];
      raw[offset + 1] = px[1];
      raw[offset + 2] = px[2];
      raw[offset + 3] = px[3];
    }
  }

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
```
```typescript
// lib/services/ImageGenerator.ts — current (two call sites):
const PLACEHOLDER_PNG = createPlaceholderPng(PLACEHOLDER_SIZE, [0xe8, 0xa3, 0x3d, 0xff]);
// ...
    const placeholder = createPlaceholderPng(longSide, [0xe8, 0xa3, 0x3d, 0xff]);

// replacement:
const PLACEHOLDER_PNG = createPlaceholderPng(PLACEHOLDER_SIZE);
// ...
    const placeholder = createPlaceholderPng(longSide);
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add lib/utils/placeholderImage.ts lib/services/ImageGenerator.ts test/placeholderImage.test.ts
git commit -m "$(cat <<'EOF'
refactor: hardcode createPlaceholderPng's fill color, drop the never-varying parameter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Flag the unshipped `kie.ai` provider in the old multi-provider docs

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-multi-provider-theme-generation.md`
- Modify: `docs/superpowers/specs/2026-09-04-multi-provider-theme-generation-design.md`
- Test: none — doc-only.

**Interfaces:** none. Confirmed against `lib/services/claudeApiProviders.ts`, whose `ClaudeApiProvider.name` union is `'anthropic' | 'cheaperinference'` — `kie.ai` was never added.

- [ ] **Step 1 (the only real step): Implement**

Add a blockquote note near the top of both files, right after the existing header/`REQUIRED SUB-SKILL` line and before the `**Goal:**`/`Status:` line:
```md
> **Note (added during a later audit):** kie.ai support described below was never shipped — the final implementation only has `anthropic`/`cheaperinference` (see `lib/services/claudeApiProviders.ts`). This section is historical, not a guide to current behavior.
```
Don't delete or rewrite the historical content — just flag it.

- [ ] **Step 2: Commit**
```bash
git add docs/superpowers/plans/2026-09-04-multi-provider-theme-generation.md docs/superpowers/specs/2026-09-04-multi-provider-theme-generation-design.md
git commit -m "$(cat <<'EOF'
docs: flag kie.ai as never-shipped in the old multi-provider theme-gen docs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Part C: AI Generation Pipeline

### Task 18: Extract shared Claude tool-call helper with signal support

**Files:**
- Create: `lib/services/claudeToolCall.ts`
- Modify: `lib/services/ClaudeApiThemeGenerator.ts` (whole file)
- Modify: `lib/services/ThemeGenerator.ts` (interface)
- Modify: `lib/services/ComponentGenerator.ts` (whole file)
- Modify: `lib/services/PageLayoutSuggester.ts` (whole file)
- Test: `test/themeGenerator.test.ts`, `test/componentGeneratorReferenceImage.test.ts`, `test/pageLayoutSuggester.test.ts` (each extended)

**Interfaces:**
- Consumes: `ClaudeApiProvider` (`lib/services/claudeApiProviders.ts`) — `{ name, requestUrl, model, buildAuthHeaders(apiKey) }`.
- Produces: `export async function callClaudeTool(params: ClaudeToolCallParams): Promise<unknown>` where
  ```typescript
  export interface ClaudeToolCallParams {
    provider: ClaudeApiProvider;
    apiKey: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    messages: Array<{ role: string; content: unknown }>;
    maxTokens?: number;
    signal?: AbortSignal;
    operationLabel: string;   // e.g. "theme generation" — used in the HTTP-failure message
    truncatedMessage: string; // e.g. "the theme could not be generated" — used in the max_tokens message
  }
  ```
  Also changes caller-facing signatures: `ThemeGenerator.generate(prompt, styleId, referenceImage?, basedOnContent?, signal?)`, `ComponentGenerator.generate(prompt, styleId, componentType?, referenceImage?, basedOnContent?, signal?)`, `PageLayoutSuggester.suggest(pageName, candidates, signal?)`. **Task 21 depends on the `callClaudeTool` export existing.**

- [ ] **Step 1: Write the failing test**

Add to `test/themeGenerator.test.ts` (inside the existing `describe('ClaudeApiThemeGenerator', ...)` block):
```typescript
  it('combines a caller-supplied signal with the internal request timeout, so aborting it aborts the request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_8', type: 'message', role: 'assistant',
        content: [{
          type: 'tool_use', id: 'tool_1', name: 'emit_theme',
          input: {
            colorBackground: '#1a1420', colorForeground: '#f0e6d2', colorAccent: '#e8a33d', colorBorder: '#4a3728',
            fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
          },
        }],
        stop_reason: 'tool_use',
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await gen.generate('x', STYLE_ID, undefined, undefined, controller.signal);

    const sentSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(sentSignal.aborted).toBe(false);
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });
```

Add to `test/componentGeneratorReferenceImage.test.ts` (inside `describe('ClaudeApiComponentGenerator with a reference image', ...)`):
```typescript
  it('combines a caller-supplied signal with the internal request timeout', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('a button', style.id, undefined, undefined, undefined, controller.signal);

    const sentSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(sentSignal.aborted).toBe(false);
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });
```

Add to `test/pageLayoutSuggester.test.ts` (inside `describe('ClaudeApiPageLayoutSuggester', ...)`):
```typescript
  it('combines a caller-supplied signal with the internal request timeout', async () => {
    const fetchMock = mockFetchOnce([0]);
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
    await suggester.suggest('Home', CANDIDATES, controller.signal);

    const sentSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(sentSignal.aborted).toBe(false);
    controller.abort();
    expect(sentSignal.aborted).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/themeGenerator.test.ts test/componentGeneratorReferenceImage.test.ts test/pageLayoutSuggester.test.ts`
Expected: FAIL with `expected false to be true` on `controller.abort(); expect(sentSignal.aborted).toBe(true);` in all three — today's `generate()`/`suggest()` never reads a trailing `signal` argument.

- [ ] **Step 3: Implement**

Create `lib/services/claudeToolCall.ts`:
```typescript
// lib/services/claudeToolCall.ts
//
// Shared by ClaudeApiThemeGenerator, ClaudeApiComponentGenerator, and
// ClaudeApiPageLayoutSuggester: the near-identical ~35-line block each had
// (build headers incl. anthropic-version, POST with a forced tool_choice,
// check res.ok, check stop_reason === 'max_tokens', find the tool_use block)
// now lives once here. Each caller still supplies its own tool
// name/description/schema and its own operationLabel/truncatedMessage
// strings so error messages stay as specific and diagnosable as before —
// this deliberately does not flatten them into one generic message.
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';

const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60_000;

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

// This project's @types/node is ^24.0.0 (Node 20+ typings), so
// AbortSignal.any() is available — used directly, no feature-detection
// fallback for a runtime this project doesn't target.
function combineWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

export interface ClaudeToolCallParams {
  provider: ClaudeApiProvider;
  apiKey: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens?: number;
  signal?: AbortSignal;
  /** e.g. "theme generation" — used in the HTTP-failure error message. */
  operationLabel: string;
  /** e.g. "the theme could not be generated" — used in the max_tokens error message. */
  truncatedMessage: string;
}

/**
 * Calls the Anthropic Messages API (or a provider proxying that same shape)
 * with a forced single tool call, and returns the tool_use block's raw
 * `input` — the caller does its own Zod parse against its own tool's
 * schema. Throws a specific Error for each of: HTTP failure, max_tokens
 * truncation, and a missing tool_use block.
 */
export async function callClaudeTool(params: ClaudeToolCallParams): Promise<unknown> {
  const { provider, apiKey, toolName, toolDescription, inputSchema, messages, maxTokens = 4096, signal, operationLabel, truncatedMessage } = params;

  const res = await fetch(provider.requestUrl, {
    method: 'POST',
    headers: {
      ...provider.buildAuthHeaders(apiKey),
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      tools: [{ name: toolName, description: toolDescription, input_schema: inputSchema }],
      tool_choice: { type: 'tool', name: toolName },
      messages,
    }),
    signal: combineWithTimeout(signal),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${operationLabel} failed via ${provider.name} (${res.status}): ${body || res.statusText}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Anthropic response (via ${provider.name}) was truncated (stop_reason: max_tokens) before completing the tool call — ${truncatedMessage}.`);
  }
  const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error(`Anthropic response (via ${provider.name}) contained no tool_use block for ${toolName}.`);
  }
  return toolUse.input;
}
```

In `lib/services/ClaudeApiThemeGenerator.ts`: add `import { callClaudeTool } from '@/lib/services/claudeToolCall';` near the top; delete the now-duplicated `ANTHROPIC_VERSION`/`REQUEST_TIMEOUT_MS` constants and the `ToolUseBlock`/`AnthropicMessageResponse` types (both now owned by `claudeToolCall.ts`); change `generate()`'s signature to accept a trailing `signal?: AbortSignal`; replace the inline fetch block with:
```typescript
    const toolInput = await callClaudeTool({
      provider: this.provider,
      apiKey: this.apiKey,
      toolName: 'emit_theme',
      toolDescription: 'Emit a website design token set matching the requested aesthetic.',
      inputSchema: TOOL_INPUT_SCHEMA,
      messages: [{ role: 'user', content }],
      signal,
      operationLabel: 'theme generation',
      truncatedMessage: 'the theme could not be generated',
    });

    const tokens = ThemeTokensSchema.parse(toolInput);
```
(replacing the old fetch/res.ok/stop_reason/tool_use block and the `ThemeTokensSchema.parse(toolUse.input)` line).

In `lib/services/ThemeGenerator.ts`, update the interface:
```typescript
export interface ThemeGenerator {
  generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal): Promise<GeneratedTheme>;
}
```

In `lib/services/ComponentGenerator.ts`: same pattern — add the `callClaudeTool` import, delete the duplicated types/constants, add `signal?: AbortSignal` as a trailing parameter to both the `ComponentGenerator` interface's `generate` and `ClaudeApiComponentGenerator.generate()`, replace the fetch block:
```typescript
    const toolInput = await callClaudeTool({
      provider: this.provider,
      apiKey: this.apiKey,
      toolName: 'emit_component',
      toolDescription: 'Emit a single website UI component as HTML and CSS.',
      inputSchema: TOOL_INPUT_SCHEMA,
      messages: [{ role: 'user', content }],
      signal,
      operationLabel: 'component generation',
      truncatedMessage: 'the component could not be generated',
    });

    const raw = z.object({ html: z.string(), css: z.string() }).parse(toolInput);
```
(`MockComponentGenerator` is unaffected — no `fetch` call, and its fewer-parameter `generate()` still structurally satisfies the updated interface).

In `lib/services/PageLayoutSuggester.ts`: same pattern — add the import, delete duplicated types/constants, add `signal?: AbortSignal` to both the interface's `suggest` and `ClaudeApiPageLayoutSuggester.suggest()`, replace the fetch block:
```typescript
    const input = await callClaudeTool({
      provider: this.provider,
      apiKey: this.apiKey,
      toolName: 'emit_page_layout',
      toolDescription: 'Emit the ordered list of component indices that belong on this page.',
      inputSchema: TOOL_INPUT_SCHEMA,
      messages: [{ role: 'user', content: buildLayoutPrompt(pageName, candidates) }],
      maxTokens: 1024,
      signal,
      operationLabel: 'page layout suggestion',
      truncatedMessage: 'the layout could not be suggested',
    });
```
then replace every remaining `toolUse.input` reference in the validation block with `input`, and delete the now-dead `toolUse`/`data`-lookup lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/themeGenerator.test.ts test/componentGeneratorReferenceImage.test.ts test/pageLayoutSuggester.test.ts`
Expected: all pass, including every pre-existing test in these files unchanged (the HTTP-failure, max_tokens, missing-tool_use, dedup-steering, and fallback tests all assert on message substrings or mocked-fetch-call shape that `callClaudeTool` reproduces exactly — no edits needed).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add lib/services/claudeToolCall.ts lib/services/ClaudeApiThemeGenerator.ts lib/services/ThemeGenerator.ts lib/services/ComponentGenerator.ts lib/services/PageLayoutSuggester.ts test/themeGenerator.test.ts test/componentGeneratorReferenceImage.test.ts test/pageLayoutSuggester.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract shared Claude tool-call helper with signal support

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Add request timeout and response-shape validation to `PixellabGenerator`

**Files:**
- Modify: `lib/services/PixellabGenerator.ts`
- Test: `test/pixellabGenerator.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new — still `PixellabGenerator.generate(prompt, styleId, options?)`.
- Produces: no signature change in this task. Behavior change: `generate()` now always combines `options?.signal` with an internal 60s deadline, and throws a specific error on a malformed response shape instead of a raw `TypeError`. **Tasks 21 and 25 extend this same test file.**

- [ ] **Step 1: Write the failing test**

Create `test/pixellabGenerator.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { PixellabGenerator } from '@/lib/services/PixellabGenerator';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pixellabgen-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('PixellabGenerator.generate() timeout', () => {
  it('aborts and throws when the request exceeds the internal timeout, even with no caller signal', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);

    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const pending = generator.generate('a goblin', 'style-1');
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe('PixellabGenerator.generate() response shape validation', () => {
  it('throws a specific error when the response is missing image.base64, not a raw TypeError', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ usage: { type: 'generation' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const error = await generator.generate('a goblin', 'style-1').catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toMatch(/unexpected response shape|image\.base64/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pixellabGenerator.test.ts`
Expected: FAIL — the timeout test hangs/times out (no internal deadline exists today); the shape test fails with a raw `TypeError` instead of the expected message.

- [ ] **Step 3: Implement**

Add near the top, after the existing `MIN_SIZE`/`MAX_SIZE`/`DEFAULT_SIZE` constants:
```typescript
const REQUEST_TIMEOUT_MS = 60_000;

// Same combining approach as lib/services/claudeToolCall.ts's
// combineWithTimeout — duplicated rather than imported, since this file's
// fetch calls are a different API shape (Pixellab, not Anthropic
// Messages) and don't otherwise share anything with that module.
function combineWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

function isPixfluxResponse(data: unknown): data is PixfluxResponse {
  return (
    !!data &&
    typeof data === 'object' &&
    'image' in data &&
    !!(data as { image?: unknown }).image &&
    typeof (data as { image: { base64?: unknown } }).image.base64 === 'string'
  );
}
```
Then replace the fetch call and response handling:
```typescript
// current:
    const res = await fetch(`${API_BASE}/create-image-pixflux`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pixellab generation failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as PixfluxResponse;
    const format = data.image.format || 'png';
    const filename = `pixellab-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${format}`;

// replacement:
    const res = await fetch(`${API_BASE}/create-image-pixflux`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: combineWithTimeout(options?.signal),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pixellab generation failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as unknown;
    if (!isPixfluxResponse(data)) {
      throw new Error('Pixellab generation returned an unexpected response shape (missing image.base64).');
    }
    const format = data.image.format || 'png';
    const filename = `pixellab-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${format}`;
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` — `test/pixellabGeneratorReferenceImage.test.ts` stays green (`AbortSignal.any([timeoutSignal])` with no caller signal still produces a real `AbortSignal`; `generateUiAsset()`'s own fetch calls are untouched).

- [ ] **Step 6: Commit**
```bash
git add lib/services/PixellabGenerator.ts test/pixellabGenerator.test.ts
git commit -m "$(cat <<'EOF'
fix: add request timeout and response-shape guard to PixellabGenerator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Document that `worker.ts` still constructs no `AbortController`

**Files:**
- Modify: `worker.ts` (one comment, above the `case 'image':` block)

**Interfaces:** none — no behavior change.

This task deliberately has no test: there is no behavior to test. Every generator now *accepts* a signal (Tasks 18-19), but nothing in this app has a cancel-job feature to produce one — building one was not asked for by the audit (it flagged the asymmetry in signal *support*, not a missing feature) and would be scope creep.

- [ ] **Step 1: Implement**
```typescript
      case 'image': {
        // No AbortController is constructed here — every generator (Theme,
        // Component, PageLayout, Pixellab/Image) now accepts an optional
        // signal (see Tasks 18-19), but nothing in this app has a cancel-job
        // feature to produce one yet. Wiring one up is out of scope until
        // a cancel-job feature is actually requested.
        const spriteReferenceImage = referenceImage ?? (await loadSpriteBasedOnImage(options.basedOnAssetId, job.id));
```
- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 3: Commit**
```bash
git add worker.ts
git commit -m "$(cat <<'EOF'
docs: note that worker.ts still constructs no AbortController

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 21: Retry/backoff for transient 429/5xx failures

**Depends on Task 18** (`claudeToolCall.ts`) **and Task 19** (`PixellabGenerator.ts`'s timeout helpers).

**Files:**
- Modify: `lib/services/claudeToolCall.ts`
- Modify: `lib/services/PixellabGenerator.ts`
- Modify: `test/themeGenerator.test.ts`, `test/pageLayoutSuggester.test.ts` (one-line fixups — see Step 5)
- Test: `test/claudeToolCall.test.ts` (new), `test/pixellabGenerator.test.ts` (append)

**Interfaces:**
- Consumes: `callClaudeTool(params)` (Task 18), `PixellabGenerator.generate(...)` (Task 19) — no signature change.
- Produces: a `429` or `5xx` response now retries up to 2 more times (1s, then 3s backoff) before throwing the same error message as before; any other non-ok status (e.g. `400`) still throws immediately.

- [ ] **Step 1: Write the failing test**

Create `test/claudeToolCall.test.ts`:
```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callClaudeTool } from '@/lib/services/claudeToolCall';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function baseParams(overrides: Partial<Parameters<typeof callClaudeTool>[0]> = {}) {
  return {
    provider: ANTHROPIC_PROVIDER,
    apiKey: 'fake-key',
    toolName: 'emit_theme',
    toolDescription: 'x',
    inputSchema: {},
    messages: [{ role: 'user', content: 'hi' }],
    operationLabel: 'theme generation',
    truncatedMessage: 'the theme could not be generated',
    ...overrides,
  };
}

describe('callClaudeTool retry on transient failures', () => {
  it('retries on 429 twice then succeeds on the 3rd attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 't1', name: 'emit_theme', input: { ok: true } }],
        stop_reason: 'tool_use',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = callClaudeTool(baseParams());
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await pending).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws immediately after exactly one call on a non-retryable 400', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callClaudeTool(baseParams())).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

Append to `test/pixellabGenerator.test.ts`:
```typescript
describe('PixellabGenerator.generate() retry on transient failures', () => {
  it('retries on 429 twice then succeeds on the 3rd attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ image: { type: 'base64', base64: Buffer.from('ok').toString('base64'), format: 'png' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const pending = generator.generate('a goblin', 'style-1');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    const result = await pending;
    expect(result.path).toMatch(/\.png$/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws immediately after exactly one call on a non-retryable 400', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    await expect(generator.generate('a goblin', 'style-1')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/claudeToolCall.test.ts test/pixellabGenerator.test.ts`
Expected: FAIL on the 429-retry tests (`expected 3 but got 1` — no retry loop exists yet). The 400 tests already pass (kept as the explicit non-retry guarantee).

- [ ] **Step 3: Implement**

In `lib/services/claudeToolCall.ts`, add below the existing `REQUEST_TIMEOUT_MS` constant:
```typescript
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 3000];

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!isRetryable || attempt === MAX_RETRIES) return res;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
  throw new Error('unreachable'); // loop above always returns
}
```
Then change `callClaudeTool`'s `const res = await fetch(provider.requestUrl, {` to `const res = await fetchWithRetry(provider.requestUrl, {` (rest of that call unchanged).

In `lib/services/PixellabGenerator.ts`, add the same two constants and helper right after the `combineWithTimeout`/`isPixfluxResponse` helpers added in Task 19, then change `const res = await fetch(\`${API_BASE}/create-image-pixflux\`, {` to `const res = await fetchWithRetry(\`${API_BASE}/create-image-pixflux\`, {`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/claudeToolCall.test.ts test/pixellabGenerator.test.ts`

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: `test/themeGenerator.test.ts`'s existing `'throws with the response status when the API call itself fails'` test and `test/pageLayoutSuggester.test.ts`'s `'throws a clear error when the HTTP response is not ok'` test each use a single `429`/`500` `mockResolvedValueOnce` — after this change they'll retry 2 more times, and since the mock was only set up once, the 2nd/3rd calls fall through to `undefined` and throw a `TypeError` instead of the expected message. **Fix both by changing their `mockResolvedValueOnce` to `mockResolvedValue`** (repeats the same response across all 3 attempts) — a one-line diff in each file, not a new test.

- [ ] **Step 6: Commit**
```bash
git add lib/services/claudeToolCall.ts lib/services/PixellabGenerator.ts test/claudeToolCall.test.ts test/pixellabGenerator.test.ts test/themeGenerator.test.ts test/pageLayoutSuggester.test.ts
git commit -m "$(cat <<'EOF'
fix: retry transient 429/5xx failures with backoff

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Persist and surface the specific failure reason for a failed job

**Files:**
- Create: `lib/database/migrations/015_add_error_message_to_jobs.sql`
- Modify: `lib/database/schema.ts` (`JobSchema`)
- Modify: `worker.ts` (new `markJobFailed` helper + 3 call sites)
- Modify: `app/components/JobCard.tsx` (render block)
- Test: `test/migration-015.test.ts` (new), `test/jobErrorMessage.test.ts` (new)

**Interfaces:**
- Produces: `JobSchema` gains `error_message: z.string().nullable()`; `Job` type gains `error_message: string | null`. `worker.ts` gains a private `markJobFailed(db, jobId, errorMessage)` helper used by all 3 of its `status = 'failed'` call sites. **Correction confirmed during drafting: `lib/services/JobService.ts` has no call site setting `status = 'failed'` — all 3 are in `worker.ts`.**

- [ ] **Step 1: Write the failing test**

Create `test/migration-015.test.ts` (mirrors `test/migration-014.test.ts`):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration015-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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

describe('migration 015', () => {
  it('adds a nullable error_message column to jobs', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
      VALUES ('33333333-3333-3333-3333-333333333333', 'test style', 'user-1', '{}', 0, 1000, 1000)
    `).run();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
      VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'user-1', 'sprite', 'a goblin', 'pending', NULL, 1000, 1000, '{}')
    `).run();
    const row = db.prepare('SELECT error_message FROM jobs WHERE id = ?').get('44444444-4444-4444-4444-444444444444') as any;
    expect(row.error_message).toBeNull();

    db.prepare('UPDATE jobs SET error_message = ? WHERE id = ?').run('boom', '44444444-4444-4444-4444-444444444444');
    const updated = db.prepare('SELECT error_message FROM jobs WHERE id = ?').get('44444444-4444-4444-4444-444444444444') as any;
    expect(updated.error_message).toBe('boom');
  });
});
```

Create `test/jobErrorMessage.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import * as ImageGeneratorModule from '@/lib/services/ImageGenerator';
import { processJob } from './../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-joberrormsg-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe("a thrown generator error is persisted as the job's error_message", () => {
  it("stores the error's message and marks the job failed", async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin', outputKind: 'image',
    });

    vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockRejectedValue(new Error('Pixellab generation failed (500): server exploded')),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const db = DatabaseConnection.getInstance();
    const updated = db.prepare('SELECT status, error_message FROM jobs WHERE id = ?').get(job.id) as any;
    expect(updated.status).toBe('failed');
    expect(updated.error_message).toBe('Pixellab generation failed (500): server exploded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migration-015.test.ts test/jobErrorMessage.test.ts`
Expected: FAIL — `SQLITE_ERROR: no such column: error_message`.

- [ ] **Step 3: Implement**

Create `lib/database/migrations/015_add_error_message_to_jobs.sql`:
```sql
ALTER TABLE jobs ADD COLUMN error_message TEXT;
```

In `lib/database/schema.ts`, add `error_message: z.string().nullable(),` to `JobSchema` (right after `result_path`).

In `worker.ts`, add a helper right above `processJob`:
```typescript
function markJobFailed(db: ReturnType<typeof DatabaseConnection.getInstance>, jobId: string, errorMessage: string): void {
  db.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`).run(errorMessage, Date.now(), jobId);
}
```
Then replace all 3 existing `db.prepare(\`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?\`).run(Date.now(), job.id);` call sites (the malformed-options-JSON catch, the invalid-UI-sheet-options check, and the main catch-all) with `markJobFailed(db, job.id, <the relevant error message — e.g. \`e instanceof Error ? e.message : String(e)\`, \`parsed.error.message\`, or \`error.message\` depending on which call site>);`.

In `app/components/JobCard.tsx`, add right after the existing prompt `<div>`:
```tsx
        {job.status === 'failed' && job.error_message && (
          <div style={{ fontSize: 12, color: 'var(--reject)', marginBottom: 12 }}>
            {job.error_message}
          </div>
        )}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` — other tests asserting on a failed job's row (`test/workerValidation.test.ts`, `test/workerThemeRouting.test.ts`, `test/promotion.test.ts`) only select `status`/`result_path`, not the full row shape, so they're unaffected.

- [ ] **Step 6: Commit**
```bash
git add lib/database/migrations/015_add_error_message_to_jobs.sql lib/database/schema.ts worker.ts app/components/JobCard.tsx test/migration-015.test.ts test/jobErrorMessage.test.ts
git commit -m "$(cat <<'EOF'
feat: persist and surface the specific reason a job failed

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 23: Wire sprite width/height through end-to-end

**Files:**
- Modify: `lib/services/ImageGenerator.ts` (`GenerateOptions` interface only — does not overlap with Part B Task 16's edit to the `createPlaceholderPng` call sites in this same file)
- Modify: `lib/services/PixellabGenerator.ts` (`generate()` signature simplification)
- Modify: `app/api/generate/route.ts` (`GenerateSchema`, `RESERVED_OPTION_KEYS`, options-merging)
- Modify: `worker.ts` (extract width/height from `job.options`)
- Modify: `app/dashboard/generate/page.tsx` (size selector)
- Test: `test/generateSizeWiring.test.ts` (new)

**Interfaces:**
- Produces: `GenerateOptions` gains `width?: number; height?: number`. `PixellabGenerator.generate()`'s signature simplifies from `options?: GenerateOptions & { width?: number; height?: number }` to `options?: GenerateOptions`. `GenerateSchema` (route) gains `width`/`height` (16-400, matching `PixellabGenerator`'s own clamp range); job `options` blob gains the same two keys, mirroring the existing `referenceStrength`/`basedOnAssetId` pattern.

- [ ] **Step 1: Write the failing test**
```typescript
// test/generateSizeWiring.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import * as ImageGeneratorModule from '@/lib/services/ImageGenerator';
import { processJob } from './../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-sizewiring-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe("worker.processJob() threads options.width/height into the image generator", () => {
  it('extracts explicit width/height from job.options and passes them to generate()', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin',
      outputKind: 'image', options: { width: 128, height: 32 },
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin', metadata: { width: 128, height: 32, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin', style.id, {
      referenceImage: undefined, referenceStrength: undefined, width: 128, height: 32,
    });
  });

  it('passes width/height as undefined when omitted (unchanged existing behavior)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin', outputKind: 'image',
    });

    const generateSpy = vi.spyOn(ImageGeneratorModule, 'getImageGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.png', prompt: 'a goblin', metadata: { width: 64, height: 64, format: 'png' } }),
      generateUiAsset: vi.fn(),
    } as any);

    await processJob(job);

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('a goblin', style.id, {
      referenceImage: undefined, referenceStrength: undefined, width: undefined, height: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/generateSizeWiring.test.ts`
Expected: FAIL on the first test — `worker.ts` doesn't read `options.width`/`options.height` yet (the second test already passes by coincidence and stays green as the regression guard).

- [ ] **Step 3: Implement**

In `lib/services/ImageGenerator.ts`, add `width?: number; height?: number;` to the `GenerateOptions` interface.

In `lib/services/PixellabGenerator.ts`, simplify `generate()`'s signature from `options?: GenerateOptions & { width?: number; height?: number }` to `options?: GenerateOptions`.

In `app/api/generate/route.ts`, add to `GenerateSchema`:
```typescript
  // 16-400 matches PixellabGenerator's own MIN_SIZE/MAX_SIZE clamp range —
  // validated here too so an out-of-range value is rejected with a clear
  // 400 instead of being silently clamped deep in the generator.
  width: z.number().int().min(16).max(400).optional(),
  height: z.number().int().min(16).max(400).optional(),
```
Add `'width'` and `'height'` to `RESERVED_OPTION_KEYS`. After the existing `if (input.basedOnAssetId) { mergedOptions.basedOnAssetId = input.basedOnAssetId; }` block, add:
```typescript
    if (input.width !== undefined) {
      mergedOptions.width = input.width;
    }
    if (input.height !== undefined) {
      mergedOptions.height = input.height;
    }
```

In `worker.ts`, after the existing `const referenceStrength = typeof options.referenceStrength === 'number' ? options.referenceStrength : undefined;` line, add:
```typescript
  const width = typeof options.width === 'number' ? options.width : undefined;
  const height = typeof options.height === 'number' ? options.height : undefined;
```
Then in the `case 'image':` branch's non-sheet call, change:
```typescript
// current:
          : await getImageGenerator().generate(job.prompt, job.style_id, { referenceImage: spriteReferenceImage, referenceStrength });

// replacement:
          : await getImageGenerator().generate(job.prompt, job.style_id, { referenceImage: spriteReferenceImage, referenceStrength, width, height });
```

In `app/dashboard/generate/page.tsx`, add state:
```typescript
  // Mirrors PixellabGenerator.ts's DEFAULT_SIZE (64) - not imported
  // directly, since that module pulls in Node-only fs/crypto imports
  // unsuitable for this 'use client' page.
  const SPRITE_SIZE_PRESETS = [32, 64, 128] as const;
  const [spriteSize, setSpriteSize] = useState<number>(64);
```
Add `width: spriteSize, height: spriteSize,` to the POST body's JSON. Add a size `<select>` field after the reference-image field:
```tsx
          <div className="field">
            <label htmlFor="spriteSize">Size</label>
            <select id="spriteSize" value={spriteSize} onChange={e => setSpriteSize(Number(e.target.value))}>
              {SPRITE_SIZE_PRESETS.map(size => (
                <option key={size} value={size}>{size}x{size}</option>
              ))}
            </select>
          </div>
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` — `test/workerReferenceImage.test.ts`'s existing `toHaveBeenCalledWith(...)` assertions stay green unchanged, since vitest's comparison ignores `undefined`-valued object keys.

- [ ] **Step 6: Commit**
```bash
git add lib/services/ImageGenerator.ts lib/services/PixellabGenerator.ts app/api/generate/route.ts worker.ts app/dashboard/generate/page.tsx test/generateSizeWiring.test.ts
git commit -m "$(cat <<'EOF'
feat: wire sprite width/height through the generate form end-to-end

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Error-path and sanitization-applied tests for `ClaudeApiComponentGenerator`

**Depends on Task 18** (the post-refactor `generate()` signature).

**Files:**
- Test: `test/componentGeneratorReferenceImage.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/componentGeneratorReferenceImage.test.ts`:
```typescript
describe('ClaudeApiComponentGenerator error paths', () => {
  it('throws when the response has no tool_use block', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'I refuse to use the tool.' }],
        stop_reason: 'end_turn',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow(/tool_use/i);
  });

  it('throws when the tool_use input fails html/css schema validation', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 't1', name: 'emit_component', input: { html: '<button>Go</button>' } }], // missing css
        stop_reason: 'tool_use',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow();
  });

  it('throws a distinct max_tokens error when the response was truncated before completing the tool call', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Thinking about the ' }],
        stop_reason: 'max_tokens',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow(/max_tokens/i);
  });

  it('throws with the response status when the API call itself fails', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await expect(generator.generate('a button', style.id)).rejects.toThrow(/429/);
  });
});

describe("ClaudeApiComponentGenerator sanitizes the raw model output before writing", () => {
  it("writes html with a disallowed attribute/tag stripped, not the model's raw output", async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{
          type: 'tool_use', id: 't1', name: 'emit_component',
          input: {
            html: '<button onclick="alert(1)">Go</button><script>alert(2)</script>',
            css: '.x { color: var(--color-accent); }',
          },
        }],
        stop_reason: 'tool_use',
      }), { status: 200 })
    ));

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await generator.generate('a button', style.id);

    const filePath = path.join(tempRoot, 'storage', 'components', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).not.toContain('onclick');
    expect(content).not.toContain('<script>');
    expect(content).toContain('<button>Go</button>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/componentGeneratorReferenceImage.test.ts`
Expected: these all PASS already against the post-Task-18 code — this is coverage for existing, already-correct behavior, not a bug fix. Confirm each is load-bearing by temporarily commenting out the `sanitizeComponentHtml`/`sanitizeComponentCss` calls in `ComponentGenerator.ts`'s `generate()` and re-running — the sanitization test then fails. Revert before continuing.

- [ ] **Step 3-4:** No implementation change; confirm green.
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add test/componentGeneratorReferenceImage.test.ts
git commit -m "$(cat <<'EOF'
test: cover ClaudeApiComponentGenerator's error paths and sanitization

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 25: Direct unit tests for `PixellabGenerator.generate()` and `MockGenerator.generate()`

**Depends on Task 19/21** (the test file these append to).

**Files:**
- Test: `test/pixellabGenerator.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Add `import { MockGenerator } from '@/lib/services/ImageGenerator';` to the top, then append:
```typescript
describe('PixellabGenerator.generate() happy path', () => {
  it('writes the decoded image to storage/images/ and returns metadata at the default size', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ image: { type: 'base64', base64: Buffer.from('fake-png-bytes').toString('base64'), format: 'png' } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const result = await generator.generate('a goblin', 'style-1');

    expect(result.path).toMatch(/^pixellab-.*\.png$/);
    expect(result.metadata).toEqual({ width: 64, height: 64, format: 'png' }); // DEFAULT_SIZE
    const filePath = path.join(tempRoot, 'storage', 'images', result.path);
    const bytes = await fsPromises.readFile(filePath);
    expect(bytes.toString()).toBe('fake-png-bytes');
  });

  it('clamps an out-of-range width/height to the 16-400 bounds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ image: { type: 'base64', base64: Buffer.from('x').toString('base64'), format: 'png' } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    const result = await generator.generate('a goblin', 'style-1', { width: 5, height: 99999 });

    expect(result.metadata.width).toBe(16);
    expect(result.metadata.height).toBe(400);
  });

  it('throws a clear error when the HTTP response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('server exploded', { status: 500 })));
    const generator = new PixellabGenerator('fake-key');
    await expect(generator.generate('a goblin', 'style-1')).rejects.toThrow(/500/);
  });
});

describe('MockGenerator.generate() abort/timer behavior', () => {
  it('rejects immediately with an AbortError when the signal is already aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort();
    const gen = new MockGenerator();
    await expect(gen.generate('a goblin', 'style-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with an AbortError if the signal aborts before the 2-second placeholder delay elapses', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const gen = new MockGenerator();
    const pending = gen.generate('a goblin', 'style-1', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves with the placeholder image after the delay when never aborted', async () => {
    vi.useFakeTimers();
    const gen = new MockGenerator();
    const pending = gen.generate('a goblin', 'style-1');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(result.metadata).toEqual({ width: 64, height: 64, format: 'png' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pixellabGenerator.test.ts`
Expected: these PASS against current code — the happy path, `!res.ok` branch, `clampSize`, and `MockGenerator`'s abort/timer logic already work correctly, just untested. Confirm each is load-bearing by temporarily breaking the corresponding source line (e.g. `clampSize`'s `Math.max(MIN_SIZE, ...)` → `value`) and re-running, then revert.

- [ ] **Step 3-4:** No implementation change; confirm green.
- [ ] **Step 5: Run the full suite**
- [ ] **Step 6: Commit**
```bash
git add test/pixellabGenerator.test.ts
git commit -m "$(cat <<'EOF'
test: cover PixellabGenerator.generate() and MockGenerator.generate()

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Part D: Dashboard UX

### Task 26: `useStyles`/`useJobStore` swallow network failures

**Files:**
- Modify: `lib/hooks/useStyles.ts` (whole file)
- Modify: `lib/store/useJobStore.ts` (whole file)

**Interfaces:**
- Produces: `useStyles()` now returns `{ styles, loading, error, refresh }` (added `error: string | null`). `useJobStore` state now includes `error: string | null`. **Task 27 depends on this.**

- [ ] **Step 1: Wrap `useStyles`'s two fetches in try/catch, add `error` state**

Replace the whole file:
```typescript
// lib/hooks/useStyles.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Style } from '@/lib/database/schema';

export function useStyles() {
  const [styles, setStyles] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/styles');
      const body = await res.json();
      if (body.success) {
        setStyles(body.data);
        setError(null);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/styles');
        const body = await res.json();
        if (ignore) return;
        if (body.success) {
          setStyles(body.data);
          setError(null);
        }
      } catch {
        if (!ignore) setError('Could not reach the server.');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return { styles, loading, error, refresh };
}
```

- [ ] **Step 2: Same fix for `useJobStore`'s `refreshActive`**

Replace the whole file:
```typescript
// lib/store/useJobStore.ts
import { create } from 'zustand';
import type { Job } from '@/lib/database/schema';

interface JobStore {
  jobs: Job[];
  lastRefreshedAt: number | null;
  error: string | null;
  refreshActive: () => Promise<void>;
}

export const useJobStore = create<JobStore>((set) => ({
  jobs: [],
  lastRefreshedAt: null,
  error: null,
  async refreshActive() {
    try {
      const res = await fetch('/api/jobs/active');
      const body = await res.json();
      if (body.success) {
        set({ jobs: body.data, lastRefreshedAt: Date.now(), error: null });
      }
    } catch {
      set({ error: 'Could not reach the server.' });
    }
  },
}));
```

- [ ] **Step 3: Manually verify in a running dev server** — load the Style Bibles page and the Jobs page normally (no regression).
- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 5: Commit**
```bash
git add lib/hooks/useStyles.ts lib/store/useJobStore.ts
git commit -m "$(cat <<'EOF'
fix: surface network failures from useStyles and useJobStore instead of swallowing them

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 27: Surface `useStyles()`'s new `error` across its six consuming pages

**Depends on Task 26.**

**Files:**
- Modify: `app/dashboard/styles/page.tsx`
- Modify: `app/dashboard/themes/page.tsx`
- Modify: `app/dashboard/generate/page.tsx`
- Modify: `app/dashboard/components/page.tsx`
- Modify: `app/dashboard/ui-sheets/page.tsx`
- Modify: `app/dashboard/export/page.tsx` (**added to the audit's original 5-page list**: Part A Task 3 introduced this page's `useStyles()` call site after the audit ran — folded in here for consistency with the other 5)

**Interfaces:**
- Consumes: `useStyles()`'s new `error` field (Task 26).

- [ ] **Step 1: `app/dashboard/styles/page.tsx`**

```typescript
// current:
  const { styles, loading, refresh } = useStyles();
// replacement:
  const { styles, loading, error: stylesError, refresh } = useStyles();
```
Add `{stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}` right before the existing `{!loading && styles.length === 0 ? (` empty-state check.

- [ ] **Step 2: `app/dashboard/themes/page.tsx`, `app/dashboard/generate/page.tsx`, `app/dashboard/components/page.tsx`, `app/dashboard/ui-sheets/page.tsx`**

Each of these destructures `useStyles()` as `const { styles, loading: stylesLoading } = useStyles();` — change to `const { styles, loading: stylesLoading, error: stylesError } = useStyles();` and add the same `{stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}` line right before each page's existing `{!stylesLoading && styles.length === 0 ? (` empty-state check.

- [ ] **Step 3: `app/dashboard/export/page.tsx`** (the page Part A Task 3 just added a `useStyles()` call to)
```typescript
// current (from Part A Task 3):
  const { styles, loading: stylesLoading } = useStyles();
// replacement:
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
```
Add `{stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 14 }}>{stylesError}</p>}` right after the `<StyleBiblePicker .../>` line, before the subdir field.

- [ ] **Step 4: Manually verify in a running dev server** — go offline in DevTools, reload each of the 6 pages, confirm "Could not reach the server." renders; go back online and reload to confirm it clears.
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add app/dashboard/styles/page.tsx app/dashboard/themes/page.tsx app/dashboard/generate/page.tsx app/dashboard/components/page.tsx app/dashboard/ui-sheets/page.tsx app/dashboard/export/page.tsx
git commit -m "$(cat <<'EOF'
fix: surface useStyles() fetch errors on every page that consumes it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 28: Surface `useJobStore()`'s new `error` in Themes/Generate/Components/Jobs

**Depends on Task 26.**

**Files:**
- Modify: `app/dashboard/themes/page.tsx`
- Modify: `app/dashboard/generate/page.tsx`
- Modify: `app/dashboard/components/page.tsx`
- Modify: `app/dashboard/jobs/page.tsx`

- [ ] **Step 1: `app/dashboard/themes/page.tsx`, `app/dashboard/generate/page.tsx`, `app/dashboard/components/page.tsx`**

Each has `const refreshActive = useJobStore(s => s.refreshActive); usePolling(refreshActive, 2000);`. Add `const jobsError = useJobStore(s => s.error);` right after the `refreshActive` line. Add `{jobsError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{jobsError}</p>}` right after each page's existing `<h2 className="frame-label" ...>Live queue</h2>` heading, before the `{jobs.length === 0 ? (` check.

- [ ] **Step 2: `app/dashboard/jobs/page.tsx` — combine with its existing local `error`**

This page already has its own `error` state for promote/discard/retry action failures. Add `const storeError = useJobStore(s => s.error);` right after its `refreshActive` line, then change:
```typescript
// current:
      {error && (
        <p className="card" style={{ borderColor: 'var(--reject-dim)', color: 'var(--reject)', marginBottom: 16 }}>
          {error}
        </p>
      )}
// replacement:
      {(error || storeError) && (
        <p className="card" style={{ borderColor: 'var(--reject-dim)', color: 'var(--reject)', marginBottom: 16 }}>
          {error || storeError}
        </p>
      )}
```

- [ ] **Step 3: Manually verify in a running dev server** — on Generate/Themes/Components, go offline and wait ~2s for a polling tick to fail; confirm the message appears near "Live queue". On Jobs, confirm the existing error card shows the store's message when there's no local action error.
- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 5: Commit**
```bash
git add app/dashboard/themes/page.tsx app/dashboard/generate/page.tsx app/dashboard/components/page.tsx app/dashboard/jobs/page.tsx
git commit -m "$(cat <<'EOF'
fix: surface useJobStore() polling errors on pages that read the job queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 29: Wrap the Assets page's unguarded fetches

**Files:**
- Modify: `app/dashboard/assets/page.tsx` (whole file)

- [ ] **Step 1: Add local `error` state, wrap the mount effect and `loadMore` in try/catch**

In the mount `useEffect`, wrap the `fetch`/`.json()` call in try/catch, setting a new `error` state (`'Could not reach the server.'`) on catch and clearing it on success, mirroring Task 26's `useStyles()` shape exactly (including the `ignore`-flag guard). Do the same inside `loadMore()`.

- [ ] **Step 2: Render the error near the top**

Add `{error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}` right after the page subtitle, before the existing empty-state check.

- [ ] **Step 3: Manually verify in a running dev server** — load the Assets page normally, then go offline and click "Load more" (or reload) to confirm the error message appears.
- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 5: Commit**
```bash
git add app/dashboard/assets/page.tsx
git commit -m "$(cat <<'EOF'
fix: handle fetch failures on the Assets page instead of swallowing them

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 30: Style Bible create/fork ignore the server response

**Depends on Task 27** (this task's diff assumes Task 27's `stylesError` line already landed in this same file).

**Files:**
- Modify: `app/dashboard/styles/page.tsx`

- [ ] **Step 1: Add `createError`/`forkError` state, matching `importError`'s existing separation**

Add `const [createError, setCreateError] = useState<string | null>(null);` right after the existing `creating` state, and `const [forkError, setForkError] = useState<string | null>(null);` right after `forkingId`.

- [ ] **Step 2: Fix `handleCreate` to check the response, matching `handleImport`'s pattern**
```typescript
// current:
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await fetch('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      await refresh();
    } finally {
      setCreating(false);
    }
  }
// replacement:
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setCreateError(body.error ?? 'Could not create Style Bible.');
        return;
      }
      setName('');
      await refresh();
    } catch {
      setCreateError('Could not reach the server.');
    } finally {
      setCreating(false);
    }
  }
```

- [ ] **Step 3: Fix `handleFork` the same way**
```typescript
// current:
  async function handleFork(styleId: string) {
    setForkingId(styleId);
    try {
      await fetch(`/api/styles/${styleId}/fork`, { method: 'POST' });
      await refresh();
    } finally {
      setForkingId(null);
    }
  }
// replacement:
  async function handleFork(styleId: string) {
    setForkingId(styleId);
    setForkError(null);
    try {
      const res = await fetch(`/api/styles/${styleId}/fork`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setForkError(body.error ?? 'Could not fork this Style Bible.');
        return;
      }
      await refresh();
    } catch {
      setForkError('Could not reach the server.');
    } finally {
      setForkingId(null);
    }
  }
```

- [ ] **Step 4: Render `createError` under the create form, and `forkError` alongside `stylesError`**

Add `{createError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -16, marginBottom: 16 }}>{createError}</p>}` right after the create `</form>`. Add `{forkError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{forkError}</p>}` right after Task 27's `{stylesError && ...}` line.

- [ ] **Step 5: Manually verify in a running dev server** — create a Style Bible with an invalid name (if the API rejects it) and confirm `createError` shows; fork a style while offline and confirm `forkError` shows.
- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 7: Commit**
```bash
git add app/dashboard/styles/page.tsx
git commit -m "$(cat <<'EOF'
fix: check the server response on Style Bible create and fork instead of ignoring it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 31: Dead-end "Loading…" on fetch failure

**Files:**
- Modify: `app/dashboard/assets/[id]/page.tsx`
- Modify: `app/dashboard/jobs/[id]/split/page.tsx`

**Interfaces:** both files already declare a local `error` state used elsewhere on the page — reused here rather than adding a second one, matching `jobs/[id]/edit/page.tsx`/`jobs/[id]/edit-component/page.tsx`'s existing convention.

- [ ] **Step 1: `app/dashboard/assets/[id]/page.tsx` — set `error` instead of silently returning**

In the mount effect, change `if (ignore || !body.success) return;` to:
```typescript
        if (ignore) return;
        if (!body.success) {
          setError(body.error ?? 'Could not load this asset.');
          return;
        }
```
wrap the whole effect body in try/catch, setting `error` to `'Could not reach the server.'` on catch.

- [ ] **Step 2: Render the error instead of being stuck on "Loading…"**
```typescript
// current:
  if (!asset) return <p className="page-subtitle">Loading…</p>;
// replacement:
  if (error && !asset) return <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>;
  if (!asset) return <p className="page-subtitle">Loading…</p>;
```

- [ ] **Step 3: `app/dashboard/jobs/[id]/split/page.tsx` — same fix**

Apply the identical pattern: set `error` instead of silently returning on `!body.success`, wrap in try/catch, and change `if (!job) return <p className="page-subtitle">Loading…</p>;` to check `error` first, same as Step 2.

- [ ] **Step 4: Manually verify in a running dev server** — navigate to an asset/split page with a bad id and confirm an error message renders instead of permanent "Loading…".
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add "app/dashboard/assets/[id]/page.tsx" "app/dashboard/jobs/[id]/split/page.tsx"
git commit -m "$(cat <<'EOF'
fix: show a load error instead of a permanent Loading state on asset/split pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 32: Inconsistent destructive-action confirmation

**Files:**
- Modify: `app/dashboard/presets/page.tsx` (`handleDelete`)
- Modify: `app/dashboard/jobs/page.tsx` (`handleDiscard`)
- Modify: `app/dashboard/drive/DriveBrowser.tsx` (`handleTrash`)

- [ ] **Step 1: Preset delete**

At the top of `handleDelete`, add `if (!window.confirm(\`Delete preset "${presets.find(p => p.id === id)?.name ?? 'this preset'}"? This can't be undone from the UI.\`)) return;` (matching `assets/[id]/page.tsx`'s existing `window.confirm` pattern).

- [ ] **Step 2: Job discard**
```typescript
// current:
  const handleDiscard = (jobId: string) =>
    withBusy(jobId, () => fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }));
// replacement:
  const handleDiscard = (jobId: string) => {
    if (!window.confirm("Discard this job? This can't be undone from the UI.")) return;
    return withBusy(jobId, () => fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }));
  };
```

- [ ] **Step 3: Drive "Trash"**

At the top of `handleTrash`, add `if (!window.confirm(\`Move "${items.find(i => i.id === itemId)?.name ?? 'this item'}" to trash?\`)) return;`.

- [ ] **Step 4: Manually verify in a running dev server** — click Delete on a preset, Discard on a job, Trash on a Drive item; confirm each shows a native confirm dialog naming the thing, and cancelling leaves it untouched.
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add app/dashboard/presets/page.tsx app/dashboard/jobs/page.tsx app/dashboard/drive/DriveBrowser.tsx
git commit -m "$(cat <<'EOF'
fix: confirm before preset delete, job discard, and Drive trash, matching existing delete patterns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 33: Keyboard-inaccessible clickable elements

**Files:**
- Modify: `app/dashboard/drive/DriveBrowser.tsx` (folder-navigation card)
- Modify: `app/dashboard/assets/[id]/page.tsx` (state-tag removal badge)

**Interfaces:** no new CSS class needed — `app/globals.css` has no "plain button" precedent, so both fixes use inline style overrides, matching this codebase's established one-off convention.

- [ ] **Step 1: DriveBrowser — real `<button>` for folder navigation instead of a clickable `<div>`**

Remove the card-wide `onClick={() => isFolder && openFolder(item)}` and `cursor: isFolder ? 'pointer' : 'default'` from the outer `<div className="card" ...>`. Remove the `onClick={e => e.stopPropagation()}` guards on the rename/action sub-`<div>`s (no longer needed once the outer div has no click handler to propagate into — this also fixes a pre-existing bug where clicking anywhere on a folder card mid-rename would still navigate into it). Replace the non-renaming folder-name `<div>{isFolder ? '📁 ' : ''}{item.name}</div>` with:
```tsx
                ) : isFolder ? (
                  <button
                    type="button"
                    onClick={() => openFolder(item)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', fontSize: 13, wordBreak: 'break-word' }}
                  >
                    📁 {item.name}
                  </button>
                ) : (
                  <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{item.name}</div>
                )}
```

- [ ] **Step 2: Asset state-tag removal — real `<button>` instead of a clickable `<span>`**
```tsx
// current:
              {states.map(s => (
                <span key={s} className="badge" style={{ cursor: 'pointer' }} onClick={() => setStates(states.filter(x => x !== s))}>
                  {s} x
                </span>
              ))}
// replacement:
              {states.map(s => (
                <button
                  key={s}
                  type="button"
                  className="badge"
                  style={{ cursor: 'pointer', background: 'none' }}
                  onClick={() => setStates(states.filter(x => x !== s))}
                >
                  {s} x
                </button>
              ))}
```
(`.badge` already sets `border`/`padding`/`border-radius`/`color` explicitly, overriding default button chrome on their own — only `background` needs the explicit override).

- [ ] **Step 3: Manually verify in a running dev server** — Tab to a Drive folder card and press Enter/Space to confirm it navigates in; Tab to a state tag on an asset detail page and press Enter/Space to confirm it removes the state.
- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 5: Commit**
```bash
git add app/dashboard/drive/DriveBrowser.tsx "app/dashboard/assets/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
fix: replace clickable div/span with real buttons for keyboard accessibility

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 34: `DriveBrowser` has no empty-state message

**Files:**
- Modify: `app/dashboard/drive/DriveBrowser.tsx`

**Interfaces:** reuses the existing `.empty-state` class, same convention as Assets/Styles/Presets/Jobs.

- [ ] **Step 1: Render an empty-state message when a folder has no items**
```tsx
// current:
      {loading && items.length === 0 ? (
        <p className="page-subtitle">Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
// replacement:
      {loading && items.length === 0 ? (
        <p className="page-subtitle">Loading…</p>
      ) : !loading && items.length === 0 ? (
        <div className="empty-state">
          {selectMode ? 'This folder is empty.' : 'This folder is empty. Upload a file or create a new folder above.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
```

- [ ] **Step 2: Manually verify in a running dev server** — navigate into an empty Drive folder and confirm the empty-state message renders.
- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 4: Commit**
```bash
git add app/dashboard/drive/DriveBrowser.tsx
git commit -m "$(cat <<'EOF'
fix: add empty-state message to DriveBrowser, matching other list pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 35: UI Sheets gives no feedback that a generation was queued

**Depends on Task 27** (this task's diff assumes Task 27's `stylesError` destructure already landed in this file).

**Files:**
- Modify: `app/dashboard/ui-sheets/page.tsx`

**Interfaces:** Consumes `useJobStore`'s `jobs`/`refreshActive`/`error`, `usePolling`, `JobCard`. Jobs created from this page have `asset_type: 'ui_sheet'` but `output_kind` defaults to `'image'` (confirmed in `lib/services/JobService.ts`), so filtering by `asset_type === 'ui_sheet'` is the correct way to scope the queue, matching how Themes/Components filter by `output_kind`.

- [ ] **Step 1: Add imports**

Add `import { usePolling } from '@/lib/hooks/usePolling';`, `import { useJobStore } from '@/lib/store/useJobStore';`, `import { JobCard } from '@/app/components/JobCard';`.

- [ ] **Step 2: Wire up the job store**
```typescript
// after the existing (post-Task-27) useStyles() destructure line:
  const jobs = useJobStore(s => s.jobs).filter(j => j.asset_type === 'ui_sheet');
  const refreshActive = useJobStore(s => s.refreshActive);
  const jobsError = useJobStore(s => s.error);
  usePolling(refreshActive, 2000);
```

- [ ] **Step 3: Add the Live queue section, matching Themes/Generate/Components exactly**

Right before the final closing `</>` of the component's return, add:
```tsx
      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>
        Live queue
      </h2>
      {jobsError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{jobsError}</p>}
      {jobs.length === 0 ? (
        <div className="empty-state">Nothing in flight. Queue a generation above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.map(job => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
```

- [ ] **Step 4: Manually verify in a running dev server** — queue a generation and confirm a `JobCard` appears under "Live queue" within ~2s and updates as the worker processes it.
- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**
```bash
git add app/dashboard/ui-sheets/page.tsx
git commit -m "$(cat <<'EOF'
feat: add a live queue to UI Sheets so a queued generation is visible

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 36: Missing `aria-label`s and unlabeled inputs

**Files:**
- Modify: `app/components/PageEditor.tsx` (↑/↓ reorder buttons)
- Modify: `app/dashboard/ui-sheets/page.tsx` (piece-removal button)
- Modify: `app/dashboard/jobs/[id]/split/page.tsx` (include/exclude button)
- Modify: `app/dashboard/drive/DriveBrowser.tsx` (search box, new-folder-name input)

**Interfaces:** no utility class exists for a visually-hidden label — uses the standard inline clip-to-1px technique, matching this codebase's inline-style convention for one-off layout tweaks.

- [ ] **Step 1: PageEditor reorder buttons** — add `aria-label="Move up"` / `aria-label="Move down"` to the two `↑`/`↓` buttons.
- [ ] **Step 2: UI Sheets piece-removal button** — add `aria-label="Remove piece"` to the `x` glyph button.
- [ ] **Step 3: Split-page include/exclude button** — add `aria-label={box.included ? 'Exclude piece from split' : 'Include piece in split'}`.
- [ ] **Step 4: DriveBrowser search box and new-folder-name input** — add a visually-hidden `<label htmlFor="drive-search">Search this folder</label>` / `<label htmlFor="drive-new-folder-name">New folder name</label>` (style: `{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }`) paired with `id="drive-search"` / `id="drive-new-folder-name"` on each input.
- [ ] **Step 5: Manually verify in a running dev server** — using the browser's Accessibility Tree inspector, confirm the ↑/↓/x/include-exclude buttons announce a name, and the Drive search/new-folder inputs announce a label.
- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`

- [ ] **Step 7: Commit**
```bash
git add app/components/PageEditor.tsx app/dashboard/ui-sheets/page.tsx "app/dashboard/jobs/[id]/split/page.tsx" app/dashboard/drive/DriveBrowser.tsx
git commit -m "$(cat <<'EOF'
fix: add aria-labels to icon-only buttons and labels to placeholder-only inputs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

**Out of scope (Part D):** canvas drag-resize handles in `ui-sheets/page.tsx` and `jobs/[id]/split/page.tsx` are mouse-only — building full keyboard-equivalent resize for a direct-manipulation canvas tool is a disproportionate feature addition relative to every other fix in this plan, not a mechanical gap-close. Not fixed here.

---

## Final Verification

- [ ] Run `npx tsc --noEmit` — expect clean.
- [ ] Run `npx vitest run` — expect all tests passing.
- [ ] Manually walk the dashboard end to end: Style Bibles (create/fork/delete with offline + invalid-input checks), Generate (size selector, live queue error), Jobs (retry on a non-complete/failed job gets 409, discard confirmation), Drive (folder nav via keyboard, empty-state, trash confirmation), Assets (delete as non-owner gets 403), Export (style picker, scoped export, path-traversal attempt gets 400).

## Reconciliation notes (full list, for the controller executing this plan)

- **The one real conflict**: both the security-hardening pass and the core-services pass independently rewrote `app/api/export/route.ts` and both created `test/exportRoute.test.ts`. Resolved by merging into Tasks 1-3 above (GodotExporter signature → combined route hardening → style-picker page), in that dependency order.
- **`AssetService.update()`/`softDelete()` signature change** (Task 4): verified no section other than Part A's own Task 4 calls these directly — Parts B, C, D don't touch `AssetService`.
- **`StyleService`**: Task 5 (softDelete ownership) and Task 10 (getActiveById + fork) touch different methods in the same file — no line overlap, compose cleanly in either order, though this plan sequences Task 5 before Task 10 since Part A precedes Part B.
- **`GitService.ts`**: Task 4 (`restoreTrustForUnchangedComponents`) and Task 14 (`exportToJson`) touch different methods in the same file — no overlap.
- **`lib/services/ImageGenerator.ts`**: Task 16 (drop `createPlaceholderPng`'s `fill` param) touches the `PLACEHOLDER_PNG` constant and its one other call site; Task 23 (width/height wiring) touches the `GenerateOptions` interface definition — different regions, no overlap.
- **`JobSchema`/job rows**: Task 22 adds `error_message`. Checked every other section's test fixtures for exact-shape equality on a `Job` object that could break — none exist; all assert on specific fields.
- **`useStyles()`/`useJobStore`'s new `error` fields** (Task 26): Task 27 was extended (beyond the original 5-page list) to also cover `app/dashboard/export/page.tsx`, since Part A Task 3 added that page's `useStyles()` call site after the dashboard-UX audit pass ran.
- **`JobCard.tsx`**: Task 22 (AI pipeline) adds the `error_message` render block; Task 35 (Dashboard UX) renders `<JobCard>` on a new page (UI Sheets) that didn't use it before — composes automatically, no direct conflict.
- Every other cross-cutting fact each of the 4 drafting passes reported was checked against every other pass's file list and found to have no further overlaps.

