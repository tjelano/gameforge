# Website Theme Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second generator to GameForge's existing Style Bible / Jobs pipeline — Claude produces website design tokens (CSS custom properties) instead of pixel art, reviewed and promoted through the exact same Jobs queue, and fully participating in the app's existing git-sync, cleanup, and export subsystems.

**Architecture:** A new `output_kind` column (`'image' | 'theme'`, structural, never inferred) on `jobs`/`assets` tells the worker which generator to call and the dashboard which preview to render. A new `ThemeGenerator` service (mock + real Anthropic, mirroring `ImageGenerator`'s existing mock/real split) calls Anthropic's Messages API with forced tool use — the request prompt includes the selected Style Bible's `parameters`, since unlike Pixellab (which has no such mechanism today either, confirmed by reading `PixellabGenerator.generate()` — it accepts but never uses `styleId`) Claude has no non-text channel to learn the target aesthetic, so this plan adds that wiring for real. The result is Zod-validated with a strict per-field CSS grammar (not just "non-empty string") and written to a new `storage/themes/` directory. Every existing subsystem that assumes "every asset is an image" — retry/discard's shared delete helper, git export/import/staging, and Godot export — gets an explicit `output_kind` branch so themes are neither silently mishandled nor treated as exportable to a 2D game engine. Review happens via a `sandbox=""` `<iframe>` rendering a fixed, GameForge-authored sample page — load-bearing, not cosmetic, since the generated CSS sets `:root` variables that would otherwise leak into and override the dashboard's own theming if rendered inline.

**Tech Stack:** Next.js App Router API routes, direct `fetch` against Anthropic's Messages API (no `@anthropic-ai/sdk` dependency, matching `PixellabGenerator`'s existing direct-fetch pattern), better-sqlite3, Zod, Vitest with real temp SQLite and real temp git repos (this project's established pattern, confirmed against `test/importFromJsonFields.test.ts` and `test/push.test.ts`).

**Spec:** docs/superpowers/specs/2026-09-04-website-theme-generation-design.md

**Note on the spec's Generation-mechanism section:** it justifies combining Style Bible parameters into the Anthropic prompt by saying this "exactly mirror[s] how pixel-art jobs already combine Style Bible parameters with a per-job prompt." That mirrored behavior does not actually exist — `PixellabGenerator.generate(prompt, styleId, options?)` accepts `styleId` but never reads it; pixel-art generation today is prompt-only. The *requirement* itself still stands on its own merits (documented in Task 2), it just isn't precedent-following the way the spec claims — worth the user's awareness, not worth re-opening the spec over.

## Global Constraints

- `output_kind` (`'image' | 'theme'`) is the **structural** discriminator for routing — set explicitly at job-creation time by the calling UI action, never inferred from `asset_type`, prompt text, or filename extension (this project's established principle from the UI Sheets feature: `asset_type` is display-label-only, never string-matched for routing).
- No component-level CSS generation — Claude generates design tokens only (colors, typography, spacing/radius values) as CSS custom properties. No button/card/nav CSS rules.
- No `@anthropic-ai/sdk` dependency — direct `fetch` against `https://api.anthropic.com/v1/messages`, matching `PixellabGenerator`'s existing convention.
- `storage/themes/` is a new sibling directory to `storage/images/`, never shared — but every existing subsystem that walks assets by their physical file (retry/discard deletion, git staging/export/import, Godot export) must be made explicitly `output_kind`-aware rather than left assuming `storage/images/` is the only place a referenced file can live.
- Theme token values are validated against a strict per-field CSS grammar (allowlist regex), not merely `.min(1)` — they get interpolated directly into a real CSS file rendered in a browser, so "non-empty string" is not enough to stop a CSS-breakout injection (e.g. a value that closes the custom-property declaration early and opens a new rule with a `url(...)` background).
- Every fs/process operation wrapped in try/catch with `console.error` logging on failure (project Hard Rule, `AGENTS.md`).
- Every new API response follows the `{success, data, error}` contract already used throughout this codebase.
- Direct SQL via better-sqlite3, no ORM; direct Zod validation at API boundaries, no DTOs (project Hard Rules).
- Tests that touch persistence use real temp SQLite files and, where GitService is involved, a real temp git repo (this project's established pattern, per `test/importFromJsonFields.test.ts` / `test/push.test.ts`); the one deliberate mock is `fetch`, for the actual external HTTP boundary — mirroring exactly how `PixellabGenerator`'s tests already mock `fetch`.

---

## File Map

| File | Responsibility |
|---|---|
| `lib/database/migrations/008_add_output_kind.sql` | New `output_kind` column (with CHECK constraint) on `jobs` and `assets` |
| `lib/database/schema.ts` | Add `output_kind` to `JobSchema`/`AssetSchema` (defaulted, for backward-compatible parsing) |
| `lib/services/JobService.ts` | `create()` accepts/stores `outputKind` |
| `lib/services/AssetService.ts` | `create()` accepts/stores `outputKind`; new `cleanupOrphanedThemes()` |
| `app/api/generate/route.ts` | Accepts `outputKind`, caps prompt length, rejects theme jobs carrying UI-sheet options |
| `app/api/assets/from-job/route.ts` | Copies `job.output_kind` into the promoted asset |
| `lib/services/ThemeGenerator.ts` | Interface, types, `ThemeTokensSchema` (strict grammar), `buildThemePrompt()`, `MockThemeGenerator`, lazy singleton |
| `lib/services/AnthropicThemeGenerator.ts` | Real Anthropic Messages API implementation, style-aware |
| `worker.ts` | Branch to `getThemeGenerator()` when `output_kind === 'theme'` |
| `lib/services/shared/assetSafety.ts` | `deleteFileIfSafe`/`deleteFileIfSafeSync` become `output_kind`-aware |
| `app/api/jobs/retry/route.ts`, `app/api/jobs/[id]/route.ts` | Pass `job.output_kind` into the delete helper |
| `lib/services/GitService.ts` | Stage/restore `storage/themes/*.css`; `importFromJson()` persists `output_kind` |
| `lib/services/GodotExporter.ts` | Skip `output_kind: 'theme'` assets (not a 2D image export target) |
| `app/api/themes/[filename]/route.ts` | Serves `.css` files from `storage/themes/` |
| `app/api/storage/cleanup/route.ts` | Also runs theme cleanup |
| `lib/utils/themePreview.ts` | `buildThemePreviewHtml()` — the fixed sample page, shared by Job/Asset cards and the detail page |
| `app/components/JobCard.tsx`, `app/components/AssetCard.tsx` | Render a sandboxed iframe preview for theme jobs/assets |
| `app/dashboard/assets/[id]/page.tsx` | Renders the iframe preview and hides Aseprite/image-only controls for theme assets |
| `app/dashboard/themes/page.tsx` | New page: Style Bible + prompt → queue a theme generation |
| `app/components/NavRail.tsx` | Add the new page to nav |

---

### Task 1: `output_kind` column and creation/promotion wiring

**Files:**
- Create: `lib/database/migrations/008_add_output_kind.sql`
- Modify: `lib/database/schema.ts`
- Modify: `lib/services/JobService.ts`
- Modify: `lib/services/AssetService.ts`
- Modify: `app/api/generate/route.ts`
- Modify: `app/api/assets/from-job/route.ts`
- Test: `test/migration-008.test.ts`
- Test: `test/outputKindWiring.test.ts`

**Interfaces:**
- Produces: `JobService.create(input: {..., outputKind?: 'image' | 'theme'})`, `AssetService.create(input: {..., outputKind?: 'image' | 'theme'})` — both default to `'image'` when omitted, for every existing caller that doesn't know about this field yet. `Job.output_kind` / `Asset.output_kind` fields on the Zod-inferred types, both `.default('image')` so a JSON blob or DB row missing the field still parses (needed by Task 4's git-import backward compatibility). Consumed by Task 3 (worker), Task 4 (git/asset-safety/Godot), and Task 6 (JobCard/AssetCard/detail page).

- [ ] **Step 1: Write the failing test**

```typescript
// test/migration-008.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migration-008.test.ts`
Expected: FAIL — migration file doesn't exist yet.

- [ ] **Step 3: Write the migration**

```sql
-- lib/database/migrations/008_add_output_kind.sql

ALTER TABLE jobs ADD COLUMN output_kind TEXT NOT NULL DEFAULT 'image' CHECK (output_kind IN ('image', 'theme'));
ALTER TABLE assets ADD COLUMN output_kind TEXT NOT NULL DEFAULT 'image' CHECK (output_kind IN ('image', 'theme'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migration-008.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Update the Zod schemas**

In `lib/database/schema.ts`, add near the top, after the imports:

```typescript
export const OutputKindSchema = z.enum(['image', 'theme']);
export type OutputKind = z.infer<typeof OutputKindSchema>;
```

Add one field to each existing schema — `.default('image')`, not a bare
required enum, so a JSON blob or row missing the field entirely (an
older git-synced asset export, or a hand-built test fixture) still
parses instead of hard-failing (Task 4's `GitService` import tests
depend on this):

```typescript
// AssetSchema gains:
  output_kind: OutputKindSchema.default('image'),

// JobSchema gains:
  output_kind: OutputKindSchema.default('image'),
```

- [ ] **Step 6: Write the failing test for the service/route wiring**

```typescript
// test/outputKindWiring.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;
const STYLE_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-outputkind-'));
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
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('JobService.create with outputKind', () => {
  it('defaults to \'image\' when outputKind is omitted', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'x' });
    expect(job.output_kind).toBe('image');
  });

  it('stores an explicit \'theme\' value', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    expect(job.output_kind).toBe('theme');
  });
});

describe('AssetService.create with outputKind', () => {
  it('defaults to \'image\' when outputKind is omitted', async () => {
    const asset = await assetService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'x.png' });
    expect(asset.output_kind).toBe('image');
  });

  it('stores an explicit \'theme\' value', async () => {
    const asset = await assetService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'x.css', outputKind: 'theme' });
    expect(asset.output_kind).toBe('theme');
  });
});

describe('POST /api/generate with outputKind', () => {
  it('threads outputKind through to the created job', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'dark fantasy', outputKind: 'theme' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.output_kind).toBe('theme');
  });

  it('defaults outputKind to \'image\' when omitted, preserving existing callers', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.data.output_kind).toBe('image');
  });

  it('rejects a theme job that also carries UI-sheet pieces options', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme',
        options: { pieces: [{ shape: 'rect', x: 0, y: 0, width: 10, height: 10 }] },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('rejects a prompt over 2000 characters', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'sprite', prompt: 'x'.repeat(2001) }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/assets/from-job copies output_kind through', () => {
  it('promoted asset inherits the job\'s output_kind', async () => {
    const job = await jobService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?`).run('theme.css', job.id);

    const { POST } = await import('@/app/api/assets/from-job/route');
    const req = new NextRequest('http://localhost/api/assets/from-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.output_kind).toBe('theme');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/outputKindWiring.test.ts`
Expected: FAIL.

- [ ] **Step 8: Wire `JobService.create()`**

In `lib/services/JobService.ts`, `create()` currently reads:

```typescript
  async create(input: {
    styleId: string;
    createdBy: string;
    assetType: string;
    prompt: string;
    options?: Record<string, unknown>;
  }): Promise<Job> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
    `).run(id, input.styleId, input.createdBy, input.assetType, input.prompt, now, now, JSON.stringify(input.options ?? {}));
    return (await this.getById(id))!;
  }
```

Replace with:

```typescript
  async create(input: {
    styleId: string;
    createdBy: string;
    assetType: string;
    prompt: string;
    options?: Record<string, unknown>;
    outputKind?: 'image' | 'theme';
  }): Promise<Job> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)
    `).run(id, input.styleId, input.createdBy, input.assetType, input.prompt, now, now, JSON.stringify(input.options ?? {}), input.outputKind ?? 'image');
    return (await this.getById(id))!;
  }
```

- [ ] **Step 9: Wire `AssetService.create()`**

In `lib/services/AssetService.ts`, `create()` currently reads:

```typescript
  async create(input: {
    styleId: string;
    createdBy: string;
    assetType: string;
    prompt: string;
    imagePath: string | null;
    sourceJobId?: string | null;
  }): Promise<Asset> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, input.styleId, input.createdBy, input.assetType, input.prompt, input.imagePath, Date.now(), input.sourceJobId ?? null);
    return (await this.getById(id))!;
  }
```

Replace with:

```typescript
  async create(input: {
    styleId: string;
    createdBy: string;
    assetType: string;
    prompt: string;
    imagePath: string | null;
    sourceJobId?: string | null;
    outputKind?: 'image' | 'theme';
  }): Promise<Asset> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, source_job_id, output_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.styleId, input.createdBy, input.assetType, input.prompt, input.imagePath, Date.now(), input.sourceJobId ?? null, input.outputKind ?? 'image');
    return (await this.getById(id))!;
  }
```

- [ ] **Step 10: Extend the generate route**

In `app/api/generate/route.ts`, `GenerateSchema` currently reads:

```typescript
const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  assetType: z.string().min(1),
  prompt: z.string().min(1),
  options: z.record(z.string(), z.unknown()).optional(),
});
```

Replace with:

```typescript
const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme']).optional(),
});
```

The handler currently reads:

```typescript
export async function POST(req: NextRequest) {
  try {
    const input = GenerateSchema.parse(await req.json());
    const job = await jobService.create(input);
    return NextResponse.json({ success: true, data: job });
  } catch (error: any) {
```

Add a theme/UI-sheet-options guard right after parsing — a theme job has
no meaningful use for `options.pieces` (that shape only exists for
Pixellab UI-sheet generation), so reject the nonsensical combination
before it ever reaches the worker:

```typescript
export async function POST(req: NextRequest) {
  try {
    const input = GenerateSchema.parse(await req.json());

    if (input.outputKind === 'theme') {
      const pieces = (input.options as { pieces?: unknown } | undefined)?.pieces;
      if (Array.isArray(pieces) && pieces.length > 0) {
        return NextResponse.json({ success: false, error: 'Theme jobs cannot include UI-sheet options.' }, { status: 400 });
      }
    }

    const job = await jobService.create(input);
    return NextResponse.json({ success: true, data: job });
  } catch (error: any) {
```

`JobService.create()`'s new `outputKind` field name already matches
`input.outputKind` — no other change needed in this file.

- [ ] **Step 11: Copy `output_kind` through on promotion**

In `app/api/assets/from-job/route.ts`, the INSERT currently reads:

```typescript
      const assetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(assetId, job.style_id, job.created_by, job.asset_type, job.prompt, job.result_path, Date.now());
```

Replace with:

```typescript
      const assetId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(assetId, job.style_id, job.created_by, job.asset_type, job.prompt, job.result_path, Date.now(), job.output_kind);
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run test/outputKindWiring.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 13: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green — this touches `JobSchema`/`AssetSchema`,
which every existing test constructing a `Job`/`Asset` row indirectly
relies on; confirm nothing broke.

- [ ] **Step 14: Commit**

```bash
git add lib/database/migrations/008_add_output_kind.sql lib/database/schema.ts lib/services/JobService.ts lib/services/AssetService.ts app/api/generate/route.ts app/api/assets/from-job/route.ts test/migration-008.test.ts test/outputKindWiring.test.ts
git commit -m "Add output_kind column and thread it through job/asset creation and promotion"
```

---

### Task 2: ThemeGenerator service (mock + real Anthropic, style-aware)

**Files:**
- Create: `lib/services/ThemeGenerator.ts`
- Create: `lib/services/AnthropicThemeGenerator.ts`
- Test: `test/themeGenerator.test.ts`

**Interfaces:**
- Consumes: `styleService.getById(id: string): Promise<Style | null>` (existing, `lib/services/StyleService.ts`) — `Style.parameters` is a JSON-serialized string blob (confirmed in `lib/database/schema.ts`: `parameters: z.string()`).
- Produces:
  ```typescript
  interface GeneratedTheme {
    path: string; // filename only, under storage/themes/
    prompt: string;
  }

  interface ThemeGenerator {
    generate(prompt: string, styleId: string): Promise<GeneratedTheme>;
  }

  const ThemeTokensSchema: z.ZodObject<{...}>; // strict per-field CSS grammar, see below
  function buildThemePrompt(styleParameters: string, jobPrompt: string): string;
  function getThemeGenerator(): ThemeGenerator; // lazy singleton, mock vs real
  ```
  Consumed by Task 3 (`worker.ts`).

**Why `styleId` is actually used here even though `PixellabGenerator` ignores it:** confirmed by reading `lib/services/PixellabGenerator.ts` — `generate(prompt, styleId, options?)` never reads `styleId` in its body; Pixellab generation is prompt-only today. That's not a pattern to copy for themes: pixel art can lean on Pixellab's own reference-image/style mechanisms outside this app entirely, but Claude's Messages API has no non-text channel — the *only* way "make this match the selected Style Bible" can mean anything for a theme job is putting the Style Bible's `parameters` into the prompt text. Without it, the Style Bible picker on the theme-generation page (Task 7) would have zero effect on the actual output.

- [ ] **Step 1: Write the failing test**

```typescript
// test/themeGenerator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { MockThemeGenerator, ThemeTokensSchema, buildThemePrompt } from '@/lib/services/ThemeGenerator';
import { AnthropicThemeGenerator } from '@/lib/services/AnthropicThemeGenerator';

let tempRoot: string;
const STYLE_ID = '66666666-6666-6666-6666-666666666666';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themegen-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

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
     VALUES (?, 'dark fantasy', 'user-1', ?, 0, 1000, 1000)`
  ).run(STYLE_ID, JSON.stringify({ mood: 'dark fantasy, parchment and iron' }));
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('buildThemePrompt', () => {
  it('includes both the style parameters and the job prompt', () => {
    const prompt = buildThemePrompt('{"mood":"dark fantasy"}', 'more parchment texture');
    expect(prompt).toContain('dark fantasy');
    expect(prompt).toContain('more parchment texture');
  });
});

describe('ThemeTokensSchema', () => {
  it('accepts a complete, valid token set', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: '#1a1420',
      colorForeground: '#f0e6d2',
      colorAccent: '#e8a33d',
      colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif",
      fontBody: "'EB Garamond', serif",
      spaceUnit: '8px',
      radiusBase: '4px',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a token set missing a required field', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: '#1a1420',
      colorAccent: '#e8a33d',
      colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif",
      fontBody: "'EB Garamond', serif",
      spaceUnit: '8px',
      radiusBase: '4px',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a color value that attempts to break out of the CSS declaration', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: "red; } body { background: url('https://evil.example/x') }",
      colorForeground: '#f0e6d2',
      colorAccent: '#e8a33d',
      colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif",
      fontBody: "'EB Garamond', serif",
      spaceUnit: '8px',
      radiusBase: '4px',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a length value with no valid unit', () => {
    const result = ThemeTokensSchema.safeParse({
      colorBackground: '#1a1420', colorForeground: '#f0e6d2', colorAccent: '#e8a33d', colorBorder: '#4a3728',
      fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif",
      spaceUnit: '8vw', radiusBase: '4px',
    });
    expect(result.success).toBe(false);
  });
});

describe('MockThemeGenerator', () => {
  it('writes a valid, fixed CSS file under storage/themes/', async () => {
    const gen = new MockThemeGenerator();
    const result = await gen.generate('dark fantasy, parchment and iron', STYLE_ID);

    expect(result.path).toMatch(/\.css$/);
    const filePath = path.join(tempRoot, 'storage', 'themes', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).toContain(':root');
    expect(content).toContain('--color-bg');
    expect(content).toContain('--color-accent');
    expect(content).toContain('--font-heading');
    expect(content).toContain('--space-unit');
    expect(content).toContain('--radius-base');
  });

  it('gives two calls distinct filenames even with the same millisecond timestamp', async () => {
    const gen = new MockThemeGenerator();
    const [a, b] = await Promise.all([
      gen.generate('x', STYLE_ID),
      gen.generate('x', STYLE_ID),
    ]);
    expect(a.path).not.toBe(b.path);
  });
});

describe('AnthropicThemeGenerator', () => {
  it('includes the Style Bible parameters in the Anthropic request body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
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

    const gen = new AnthropicThemeGenerator('fake-key');
    await gen.generate('more parchment texture', STYLE_ID);

    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body as string);
    const sentPrompt = sentBody.messages[0].content as string;
    expect(sentPrompt).toContain('dark fantasy, parchment and iron');
    expect(sentPrompt).toContain('more parchment texture');
  });

  it('sends a forced tool-use request with a timeout signal and writes the returned tokens as CSS', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
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

    const gen = new AnthropicThemeGenerator('fake-key');
    const result = await gen.generate('dark fantasy, parchment and iron', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'fake-key' }),
        signal: expect.any(AbortSignal),
      })
    );

    const filePath = path.join(tempRoot, 'storage', 'themes', result.path);
    const content = await fsPromises.readFile(filePath, 'utf-8');
    expect(content).toContain('--color-accent: #e8a33d;');
  });

  it('throws when the response has no tool_use block', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_2', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'I refuse to use the tool.' }],
        stop_reason: 'end_turn',
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow(/tool_use/i);
  });

  it('throws when the tool_use input fails ThemeTokensSchema validation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_3', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'emit_theme', input: { colorBackground: '#1a1420' } }],
        stop_reason: 'tool_use',
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow();
  });

  it('throws with the response status when the API call itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const gen = new AnthropicThemeGenerator('fake-key');
    await expect(gen.generate('x', STYLE_ID)).rejects.toThrow(/429/);
  });

  it('falls back to an empty style-parameters block when the style no longer exists, without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'msg_4', type: 'message', role: 'assistant',
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

    const gen = new AnthropicThemeGenerator('fake-key');
    const NONEXISTENT_STYLE_ID = '77777777-7777-7777-7777-777777777777';
    await expect(gen.generate('x', NONEXISTENT_STYLE_ID)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/themeGenerator.test.ts`
Expected: FAIL — neither module exists yet.

- [ ] **Step 3: Write `ThemeGenerator.ts`**

```typescript
// lib/services/ThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { z } from 'zod';
import { AnthropicThemeGenerator } from '@/lib/services/AnthropicThemeGenerator';

// Deliberately an allowlist grammar per token type, not a full CSS value
// parser — these values are interpolated directly into a real CSS file
// that renders in a browser (see tokensToCss below), so ".min(1)" alone
// would let a value close the custom-property declaration early and
// inject arbitrary rules (e.g. a url(...) background making a network
// request). Common, real CSS values for each type all still match.
const CSS_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)|hsla\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*,\s*(0|1|0?\.\d+)\s*\)|[a-zA-Z]{3,20})$/;
const CSS_FONT_RE = /^[a-zA-Z0-9\s,'"-]{1,120}$/;
const CSS_LENGTH_RE = /^\d{1,3}(\.\d+)?(px|rem|em)$/;

export const ThemeTokensSchema = z.object({
  colorBackground: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorForeground: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorAccent: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorBorder: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  fontHeading: z.string().regex(CSS_FONT_RE, 'must be a plain font-family value'),
  fontBody: z.string().regex(CSS_FONT_RE, 'must be a plain font-family value'),
  spaceUnit: z.string().regex(CSS_LENGTH_RE, 'must be a CSS length in px, rem, or em'),
  radiusBase: z.string().regex(CSS_LENGTH_RE, 'must be a CSS length in px, rem, or em'),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

export interface GeneratedTheme {
  path: string; // filename only, under storage/themes/
  prompt: string;
}

export interface ThemeGenerator {
  generate(prompt: string, styleId: string): Promise<GeneratedTheme>;
}

export function tokensToCss(tokens: ThemeTokens): string {
  return `:root {
  --color-bg: ${tokens.colorBackground};
  --color-fg: ${tokens.colorForeground};
  --color-accent: ${tokens.colorAccent};
  --color-border: ${tokens.colorBorder};
  --font-heading: ${tokens.fontHeading};
  --font-body: ${tokens.fontBody};
  --space-unit: ${tokens.spaceUnit};
  --radius-base: ${tokens.radiusBase};
}
`;
}

export function buildThemePrompt(styleParameters: string, jobPrompt: string): string {
  return `You are generating a website design token set (CSS custom properties only — colors, fonts, a base spacing unit, a base border radius). Match this aesthetic:

Style Bible parameters (JSON): ${styleParameters}

Additional direction for this generation: ${jobPrompt}

Respond by calling the emit_theme tool with concrete token values.`;
}

const FIXED_MOCK_TOKENS: ThemeTokens = {
  colorBackground: '#1c1a17',
  colorForeground: '#ede7dc',
  colorAccent: '#e8a33d',
  colorBorder: '#3c352a',
  fontHeading: "'Space Grotesk', sans-serif",
  fontBody: "'Inter', sans-serif",
  spaceUnit: '8px',
  radiusBase: '3px',
};

export class MockThemeGenerator implements ThemeGenerator {
  async generate(prompt: string, _styleId: string): Promise<GeneratedTheme> {
    const filename = `mock-theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`;
    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(FIXED_MOCK_TOKENS));
    } catch (e) {
      console.error(`Failed to write mock theme file ${filename}:`, e);
      throw e;
    }
    return { path: filename, prompt };
  }
}

// Lazy, mock-vs-real singleton — same reasoning as getImageGenerator():
// ESM import hoisting would otherwise evaluate process.env.ANTHROPIC_API_KEY
// before worker.ts's own env-loading flag has landed it in process.env.
let cachedThemeGenerator: ThemeGenerator | undefined;

export function getThemeGenerator(): ThemeGenerator {
  if (!cachedThemeGenerator) {
    cachedThemeGenerator = process.env.ANTHROPIC_API_KEY
      ? new AnthropicThemeGenerator(process.env.ANTHROPIC_API_KEY)
      : new MockThemeGenerator();
  }
  return cachedThemeGenerator;
}
```

- [ ] **Step 4: Write `AnthropicThemeGenerator.ts`**

```typescript
// lib/services/AnthropicThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import {
  ThemeTokensSchema,
  tokensToCss,
  buildThemePrompt,
  type ThemeGenerator,
  type GeneratedTheme,
} from '@/lib/services/ThemeGenerator';

const API_BASE = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';
const REQUEST_TIMEOUT_MS = 60_000;

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    colorBackground: { type: 'string', description: 'Primary page background color as a hex code, e.g. "#1a1420".' },
    colorForeground: { type: 'string', description: 'Primary text color as a hex code, readable against colorBackground.' },
    colorAccent: { type: 'string', description: 'Accent color for buttons, links, highlights, as a hex code.' },
    colorBorder: { type: 'string', description: 'Border/divider color as a hex code.' },
    fontHeading: { type: 'string', description: 'A CSS font-family value for headings, e.g. "\'Cinzel\', serif".' },
    fontBody: { type: 'string', description: 'A CSS font-family value for body text.' },
    spaceUnit: { type: 'string', description: 'Base spacing unit as a CSS length in px, rem, or em, e.g. "8px".' },
    radiusBase: { type: 'string', description: 'Base border-radius as a CSS length in px, rem, or em, e.g. "4px".' },
  },
  required: ['colorBackground', 'colorForeground', 'colorAccent', 'colorBorder', 'fontHeading', 'fontBody', 'spaceUnit', 'radiusBase'],
};

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
}

/**
 * Real Anthropic Messages API, called directly via fetch (no
 * @anthropic-ai/sdk dependency — matches PixellabGenerator's own
 * direct-fetch convention). Forces a single tool call so the response
 * is reliably structured, rather than asking for JSON in prose.
 */
export class AnthropicThemeGenerator implements ThemeGenerator {
  constructor(private apiKey: string) {}

  async generate(prompt: string, styleId: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt);

    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [
          {
            name: 'emit_theme',
            description: 'Emit a website design token set matching the requested aesthetic.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_theme' },
        messages: [{ role: 'user', content: fullPrompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic theme generation failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error('Anthropic response contained no tool_use block for emit_theme.');
    }

    const tokens = ThemeTokensSchema.parse(toolUse.input);
    const filename = `theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`;

    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(tokens));
    } catch (e) {
      console.error(`Failed to write theme file ${filename}:`, e);
      throw e;
    }

    return { path: filename, prompt };
  }
}
```

`styleService.getById()` returning `null` (style soft-deleted or gone —
mirrors `styles.forked_from`'s existing soft-delete-tolerant handling
elsewhere in this app) falls back to `'{}'` rather than throwing: a
missing style shouldn't hard-fail a generation that a real user is
waiting on, it just means the prompt has no aesthetic context that run.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/themeGenerator.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 7: Commit**

```bash
git add lib/services/ThemeGenerator.ts lib/services/AnthropicThemeGenerator.ts test/themeGenerator.test.ts
git commit -m "Add ThemeGenerator: style-aware mock and real Anthropic implementations"
```

---

### Task 3: Worker integration

**Files:**
- Modify: `worker.ts`
- Test: `test/workerThemeRouting.test.ts`

**Interfaces:**
- Consumes: `getThemeGenerator()` (Task 2), `job.output_kind` (Task 1).

**Invariant this task relies on:** Task 1's `/api/generate` route rejects
any request with `outputKind: 'theme'` and a non-empty `options.pieces`
before a job row is ever created — so by the time `processJob` runs, a
theme job's `options.pieces` is always absent, and `isUiSheet` (computed
below from `options.pieces`) is always `false` for it. The branch order
below doesn't need to re-derive or re-check that; it's enforced upstream.

- [ ] **Step 1: Write the failing test**

```typescript
// test/workerThemeRouting.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;
const STYLE_ID = '44444444-4444-4444-4444-444444444444';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workertheme-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('worker.ts routes theme jobs to ThemeGenerator', () => {
  it('a job with output_kind=\'theme\' completes via the mock theme generator, writing a .css result', async () => {
    const db = DatabaseConnection.getInstance();
    const jobId = 'job-theme-1';
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES (?, ?, 'user-1', 'theme', 'dark fantasy', 'pending', NULL, 1000, 1000, '{}', 'theme')`
    ).run(jobId, STYLE_ID);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;

    const { processJob } = await import('@/worker');
    await processJob(job);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('complete');
    expect(updated.result_path).toMatch(/\.css$/);
  });

  it('a job with output_kind=\'image\' still routes to the existing pixel-art path', async () => {
    const db = DatabaseConnection.getInstance();
    const jobId = 'job-image-1';
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES (?, ?, 'user-1', 'sprite', 'a goblin', 'pending', NULL, 1000, 1000, '{}', 'image')`
    ).run(jobId, STYLE_ID);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;

    const { processJob } = await import('@/worker');
    await processJob(job);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
    expect(updated.status).toBe('complete');
    expect(updated.result_path).toMatch(/\.png$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workerThemeRouting.test.ts`
Expected: FAIL — the theme job never completes (worker doesn't know about `output_kind` yet, falls through to the image path, which doesn't produce a `.css` file).

- [ ] **Step 3: Update `worker.ts`**

Add the import at the top of the file:

```typescript
import { getThemeGenerator } from '@/lib/services/ThemeGenerator';
```

The current `try` block reads:

```typescript
  try {
    const result = sheetOptions
      ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
      : await getImageGenerator().generate(job.prompt, job.style_id);

    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ?, updated_at = ? WHERE id = ?`)
      .run(result.path, Date.now(), job.id);
    console.log(`✅ Job ${job.id} complete -> ${result.path}`);
  } catch (error: any) {
    db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    console.error(`❌ Job ${job.id} failed:`, error.message);
  }
```

Replace with a three-way branch, `output_kind` checked first:

```typescript
  try {
    const result = job.output_kind === 'theme'
      ? await getThemeGenerator().generate(job.prompt, job.style_id)
      : sheetOptions
        ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
        : await getImageGenerator().generate(job.prompt, job.style_id);

    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ?, updated_at = ? WHERE id = ?`)
      .run(result.path, Date.now(), job.id);
    console.log(`✅ Job ${job.id} complete -> ${result.path}`);
  } catch (error: any) {
    db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    console.error(`❌ Job ${job.id} failed:`, error.message);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workerThemeRouting.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add worker.ts test/workerThemeRouting.test.ts
git commit -m "Route theme jobs to ThemeGenerator in the worker"
```

---

### Task 4: Existing-subsystem `output_kind` awareness

Three existing subsystems assume every asset/job file lives in
`storage/images/`. Left unfixed: discarding or retrying a theme job
silently no-ops the file delete (ENOENT swallowed, the real
`storage/themes/` file orphaned until a manual cleanup run); git
push/pull never stages, commits, or restores any theme `.css` file at
all (themes would never actually sync across machines, defeating this
app's git-native premise); and Godot export tries to copy a `.css` file
out of `storage/images/`, fails with an ENOENT it misreports as an
export failure, and skips it — for an asset type Godot can't consume
regardless.

**Files:**
- Modify: `lib/services/shared/assetSafety.ts`
- Modify: `app/api/jobs/retry/route.ts`
- Modify: `app/api/jobs/[id]/route.ts`
- Modify: `lib/services/GitService.ts`
- Modify: `lib/services/GodotExporter.ts`
- Create: `storage/themes/.gitkeep`
- Test: `test/assetSafetyOutputKind.test.ts`
- Test: `test/gitServiceThemes.test.ts`
- Test: `test/godotExporterSkipsThemes.test.ts`

**Interfaces:**
- Consumes: `job.output_kind` / `asset.output_kind` (Task 1).
- Produces: `deleteFileIfSafe(filePath: string, outputKind: 'image' | 'theme'): Promise<void>`, `deleteFileIfSafeSync(filePath: string, outputKind: 'image' | 'theme'): void` — both now take an explicit `outputKind` (the caller already has the job/asset row in hand, so this avoids an extra DB lookup inside the helper).

- [ ] **Step 1: Create the storage directory placeholder**

```bash
mkdir -p storage/themes
```

```
# storage/themes/.gitkeep
```

(An empty file — same purpose as `storage/images/.gitkeep`: keeps the
otherwise-empty, gitignored-contents directory present in a fresh clone,
and gives this task's `GitService` tests a real directory to stage
files into.)

- [ ] **Step 2: Write the failing test for asset-safety deletion**

```typescript
// test/assetSafetyOutputKind.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { deleteFileIfSafe, deleteFileIfSafeSync } from '@/lib/services/shared/assetSafety';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetsafety-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('deleteFileIfSafe with outputKind', () => {
  it('deletes an unreferenced theme file from storage/themes/, not storage/images/', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'orphan.css'), ':root {}');
    await deleteFileIfSafe('orphan.css', 'theme');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'themes', 'orphan.css'))).rejects.toThrow();
  });

  it('still deletes an unreferenced image file from storage/images/ (regression)', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'orphan.png'), 'fake-png');
    await deleteFileIfSafe('orphan.png', 'image');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'images', 'orphan.png'))).rejects.toThrow();
  });

  it('does not touch storage/images/ when deleting a theme filename that happens to collide with an image filename there', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'same-name.css'), 'do-not-delete-me');
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'same-name.css'), ':root {}');
    await deleteFileIfSafe('same-name.css', 'theme');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'images', 'same-name.css'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'themes', 'same-name.css'))).rejects.toThrow();
  });
});

describe('deleteFileIfSafeSync with outputKind', () => {
  it('deletes an unreferenced theme file from storage/themes/', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'orphan-sync.css'), ':root {}');
    deleteFileIfSafeSync('orphan-sync.css', 'theme');
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'themes', 'orphan-sync.css'))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/assetSafetyOutputKind.test.ts`
Expected: FAIL — current signature ignores the second argument entirely and always deletes from `storage/images/`.

- [ ] **Step 4: Update `assetSafety.ts`**

Current file:

```typescript
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

export function isImageReferencedByAsset(imagePath: string): boolean {
  const db = DatabaseConnection.getInstance();
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM assets WHERE image_path = ?'
  ).get(imagePath) as { count: number };
  return result.count > 0;
}

// Sync version — works inside db.transaction() callbacks, which must
// be synchronous. Uses the plain `fs` module, not `fsPromises`.
export function deleteFileIfSafeSync(filePath: string): void {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', 'images', filePath);
    if (fs.existsSync(physicalPath)) {
      fs.unlinkSync(physicalPath);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}

// Async version — for use in normal async route handlers.
export async function deleteFileIfSafe(filePath: string): Promise<void> {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', 'images', filePath);
    try {
      await fsPromises.unlink(physicalPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.error(`Failed to delete ${filePath}:`, e);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}
```

Replace with:

```typescript
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

export function isImageReferencedByAsset(imagePath: string): boolean {
  // image_path values never collide across output_kind — an image
  // filename and a theme filename always differ by extension (.png/.jpg
  // vs .css) — so a plain lookup by path alone stays correct regardless
  // of which kind is being checked.
  const db = DatabaseConnection.getInstance();
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM assets WHERE image_path = ?'
  ).get(imagePath) as { count: number };
  return result.count > 0;
}

function storageDirFor(outputKind: 'image' | 'theme'): string {
  return outputKind === 'theme' ? 'themes' : 'images';
}

// Sync version — works inside db.transaction() callbacks, which must
// be synchronous. Uses the plain `fs` module, not `fsPromises`.
export function deleteFileIfSafeSync(filePath: string, outputKind: 'image' | 'theme'): void {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(outputKind), filePath);
    if (fs.existsSync(physicalPath)) {
      fs.unlinkSync(physicalPath);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}

// Async version — for use in normal async route handlers.
export async function deleteFileIfSafe(filePath: string, outputKind: 'image' | 'theme'): Promise<void> {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(outputKind), filePath);
    try {
      await fsPromises.unlink(physicalPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.error(`Failed to delete ${filePath}:`, e);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}
```

- [ ] **Step 5: Update the two callers**

In `app/api/jobs/retry/route.ts`, the current call:

```typescript
    if (job.result_path) {
      await deleteFileIfSafe(job.result_path);
    }
```

becomes:

```typescript
    if (job.result_path) {
      await deleteFileIfSafe(job.result_path, job.output_kind);
    }
```

In `app/api/jobs/[id]/route.ts`, the current call:

```typescript
    if (job.result_path) {
      await deleteFileIfSafe(job.result_path);
    }
```

becomes:

```typescript
    if (job.result_path) {
      await deleteFileIfSafe(job.result_path, job.output_kind);
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/assetSafetyOutputKind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Write the failing test for GitService theme support**

Mirrors the real-temp-git-repo harness already established in
`test/importFromJsonFields.test.ts` and `test/push.test.ts`.

```typescript
// test/gitServiceThemes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;
let bareRemote: string;
const STYLE_ID = '55555555-5555-5555-5555-555555555555';
const THEME_ASSET_ID = '66666666-6666-6666-6666-666666666666';
const OLD_JSON_ASSET_ID = '77777777-7777-7777-7777-777777777777';

async function setupRepoWithRemote(): Promise<void> {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gittheme-'));
  bareRemote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gittheme-remote-'));

  await simpleGit(bareRemote).init(['--bare']);

  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'styles'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'data', 'assets'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  const git = simpleGit(tempRoot);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.addRemote('origin', bareRemote);

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
}

beforeEach(async () => {
  await setupRepoWithRemote();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
  if (bareRemote) await fsPromises.rm(bareRemote, { recursive: true, force: true });
});

describe('GitService stages, pushes, and restores theme CSS files', () => {
  it('push() stages and commits a theme asset\'s CSS file under storage/themes/', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'theme-1.css'), ':root { --color-bg: #111; }');
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
       VALUES (?, ?, 'user-1', 'theme', 'x', 'theme-1.css', 1000, 0, 'theme')`
    ).run(THEME_ASSET_ID, STYLE_ID);

    const result = await gitService.push();
    expect(result.success).toBe(true);

    const log = await simpleGit(tempRoot).log();
    const show = await simpleGit(tempRoot).raw(['show', '--stat', log.latest!.hash]);
    expect(show).toContain('storage/themes/theme-1.css');
  });

  it('importFromJson() persists output_kind on a theme asset', async () => {
    await fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${THEME_ASSET_ID}.json`),
      JSON.stringify({
        id: THEME_ASSET_ID, style_id: STYLE_ID, created_by: 'user-1', asset_type: 'theme',
        prompt: 'dark fantasy', image_path: 'theme-1.css', created_at: 1000, is_deleted: 0,
        output_kind: 'theme',
      })
    );

    await gitService.importFromJson();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get(THEME_ASSET_ID) as any;
    expect(row.output_kind).toBe('theme');
  });

  it('importFromJson() defaults output_kind to \'image\' for an old JSON export that predates this field, without throwing', async () => {
    await fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${OLD_JSON_ASSET_ID}.json`),
      JSON.stringify({
        id: OLD_JSON_ASSET_ID, style_id: STYLE_ID, created_by: 'user-1', asset_type: 'sprite',
        prompt: 'a goblin', image_path: 'goblin.png', created_at: 1000, is_deleted: 0,
      })
    );

    await expect(gitService.importFromJson()).resolves.not.toThrow();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get(OLD_JSON_ASSET_ID) as any;
    expect(row.output_kind).toBe('image');
  });

  it('re-importing an asset updates output_kind (ON CONFLICT DO UPDATE), not just on first insert', async () => {
    const write = (outputKind: string) => fsPromises.writeFile(
      path.join(tempRoot, 'data', 'assets', `asset-${THEME_ASSET_ID}.json`),
      JSON.stringify({
        id: THEME_ASSET_ID, style_id: STYLE_ID, created_by: 'user-1', asset_type: 'theme',
        prompt: 'x', image_path: 'theme-1.css', created_at: 1000, is_deleted: 0, output_kind: outputKind,
      })
    );

    await write('image');
    await gitService.importFromJson();
    await write('theme');
    await gitService.importFromJson();

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT output_kind FROM assets WHERE id = ?').get(THEME_ASSET_ID) as any;
    expect(row.output_kind).toBe('theme');
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run test/gitServiceThemes.test.ts`
Expected: FAIL — `storage/themes/` is never staged, and `output_kind` is never written by `importFromJson()`.

- [ ] **Step 9: Update `GitService.ts`**

`ensureDirectoriesExist()` currently reads:

```typescript
  private async ensureDirectoriesExist(): Promise<void> {
    for (const dir of DATA_DIRS) {
      await fsPromises.mkdir(path.join(getProjectRoot(), dir), { recursive: true });
    }
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'images'), { recursive: true });
  }
```

Add the themes directory:

```typescript
  private async ensureDirectoriesExist(): Promise<void> {
    for (const dir of DATA_DIRS) {
      await fsPromises.mkdir(path.join(getProjectRoot(), dir), { recursive: true });
    }
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'images'), { recursive: true });
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'themes'), { recursive: true });
  }
```

`importFromJson()`'s asset INSERT currently reads:

```typescript
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, nine_slice_margins, states)
        VALUES (@id, @style_id, @created_by, @asset_type, @prompt, @image_path, @created_at, @is_deleted, @nine_slice_margins, @states)
        ON CONFLICT(id) DO UPDATE SET
          style_id = excluded.style_id,
          created_by = excluded.created_by,
          asset_type = excluded.asset_type,
          prompt = excluded.prompt,
          image_path = excluded.image_path,
          created_at = excluded.created_at,
          is_deleted = excluded.is_deleted,
          nine_slice_margins = excluded.nine_slice_margins,
          states = excluded.states
      `).run(data);
```

Replace with (adding `output_kind` to the column list, placeholders,
and the UPDATE clause — `data.output_kind` is always defined because
`AssetSchema`'s field is `.default('image')`, so this never binds
`undefined` even for an old JSON file that omits the field entirely):

```typescript
      db.prepare(`
        INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, nine_slice_margins, states, output_kind)
        VALUES (@id, @style_id, @created_by, @asset_type, @prompt, @image_path, @created_at, @is_deleted, @nine_slice_margins, @states, @output_kind)
        ON CONFLICT(id) DO UPDATE SET
          style_id = excluded.style_id,
          created_by = excluded.created_by,
          asset_type = excluded.asset_type,
          prompt = excluded.prompt,
          image_path = excluded.image_path,
          created_at = excluded.created_at,
          is_deleted = excluded.is_deleted,
          nine_slice_margins = excluded.nine_slice_margins,
          states = excluded.states,
          output_kind = excluded.output_kind
      `).run(data);
```

`stageFilesForCommit()` currently reads:

```typescript
  private async stageFilesForCommit(): Promise<void> {
    const git = this.git();
    await git.add('data/');

    const activeAssets = await assetService.getActiveAssets();
    const validImages: string[] = [];

    for (let i = 0; i < activeAssets.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = activeAssets.slice(i, i + IO_WRITE_BATCH_SIZE);
      const existenceChecks = chunk.map(async (asset) => {
        if (!asset.image_path) return null;
        const physicalPath = path.join(getProjectRoot(), 'storage', 'images', asset.image_path);
        try {
          await fsPromises.access(physicalPath, fs.constants.F_OK);
          return `storage/images/${asset.image_path}`;
        } catch {
          return null;
        }
      });
      const results = await Promise.all(existenceChecks);
      validImages.push(...results.filter((r): r is string => r !== null));
    }

    for (let i = 0; i < validImages.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = validImages.slice(i, i + IO_WRITE_BATCH_SIZE);
      await git.add(chunk);
    }

    const gitattributesPath = path.join(getProjectRoot(), '.gitattributes');
    if (fs.existsSync(gitattributesPath)) {
      await git.add('.gitattributes');
    }
  }
```

Replace with (each asset now resolves its own subdirectory by
`output_kind` before checking existence, so a theme asset's `.css` is
looked up under `storage/themes/` instead of `storage/images/`):

```typescript
  private async stageFilesForCommit(): Promise<void> {
    const git = this.git();
    await git.add('data/');

    const activeAssets = await assetService.getActiveAssets();
    const validPaths: string[] = [];

    for (let i = 0; i < activeAssets.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = activeAssets.slice(i, i + IO_WRITE_BATCH_SIZE);
      const existenceChecks = chunk.map(async (asset) => {
        if (!asset.image_path) return null;
        const subdir = asset.output_kind === 'theme' ? 'themes' : 'images';
        const physicalPath = path.join(getProjectRoot(), 'storage', subdir, asset.image_path);
        try {
          await fsPromises.access(physicalPath, fs.constants.F_OK);
          return `storage/${subdir}/${asset.image_path}`;
        } catch {
          return null;
        }
      });
      const results = await Promise.all(existenceChecks);
      validPaths.push(...results.filter((r): r is string => r !== null));
    }

    for (let i = 0; i < validPaths.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = validPaths.slice(i, i + IO_WRITE_BATCH_SIZE);
      await git.add(chunk);
    }

    const gitattributesPath = path.join(getProjectRoot(), '.gitattributes');
    if (fs.existsSync(gitattributesPath)) {
      await git.add('.gitattributes');
    }
  }
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/gitServiceThemes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 11: Write the failing test for Godot export**

```typescript
// test/godotExporterSkipsThemes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { godotExporter } from '@/lib/services/GodotExporter';

let tempRoot: string;
const STYLE_ID = '88888888-8888-8888-8888-888888888888';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-godottheme-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  const imagesDir = path.join(tempRoot, 'storage', 'images');
  await fsPromises.mkdir(imagesDir, { recursive: true });
  await fsPromises.writeFile(path.join(imagesDir, 'goblin.png'), 'fake-png');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES ('asset-image', ?, 'user-1', 'sprite', 'x', 'goblin.png', 1000, 0, 'image')`
  ).run(STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
     VALUES ('asset-theme', ?, 'user-1', 'theme', 'x', 'theme-1.css', 1000, 0, 'theme')`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GodotExporter.exportToGodot() skips theme assets', () => {
  it('exports only the image asset', async () => {
    const result = await godotExporter.exportToGodot('godot-test');
    expect(result.exported).toBe(1);
    expect(result.skipped).toBe(0);

    const exportedFiles = await fsPromises.readdir(result.targetDir);
    expect(exportedFiles).toEqual(['goblin.png']);
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `npx vitest run test/godotExporterSkipsThemes.test.ts`
Expected: FAIL — the theme asset is currently attempted, its `copyFile` throws ENOENT, and it's counted in `skipped` (so `result.skipped` is `1`, not the `0` this test expects).

- [ ] **Step 13: Update `GodotExporter.ts`**

Current:

```typescript
    const assets = await assetService.getActiveAssets();
```

Replace with (themes aren't 2D images Godot can import — skip them
entirely rather than attempting and failing the copy):

```typescript
    const assets = (await assetService.getActiveAssets()).filter(asset => asset.output_kind === 'image');
```

- [ ] **Step 14: Run test to verify it passes**

Run: `npx vitest run test/godotExporterSkipsThemes.test.ts`
Expected: PASS (1 test).

- [ ] **Step 15: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 16: Commit**

```bash
git add lib/services/shared/assetSafety.ts app/api/jobs/retry/route.ts app/api/jobs/[id]/route.ts lib/services/GitService.ts lib/services/GodotExporter.ts storage/themes/.gitkeep test/assetSafetyOutputKind.test.ts test/gitServiceThemes.test.ts test/godotExporterSkipsThemes.test.ts
git commit -m "Make asset-safety deletion, git sync, and Godot export output_kind-aware"
```

---

### Task 5: Theme file serving and storage cleanup

**Files:**
- Create: `app/api/themes/[filename]/route.ts`
- Modify: `lib/services/AssetService.ts` (add `cleanupOrphanedThemes()`)
- Modify: `app/api/storage/cleanup/route.ts`
- Modify: `app/dashboard/settings/storage/page.tsx`
- Test: `test/themeFileServing.test.ts`
- Test: `test/cleanupOrphanedThemes.test.ts`

**Interfaces:**
- Produces: `GET /api/themes/:filename` → CSS bytes with `Content-Type: text/css`, or `{success:false,error}` (400 unsafe filename, 404 not found). `AssetService.cleanupOrphanedThemes(): Promise<number>`. Consumed by Task 6 (preview builder references `/api/themes/:filename` as the iframe's stylesheet URL) and the Settings page.

**Inherited race, not a regression:** `cleanupOrphanedThemes()` below has
the same theoretical write/cleanup race `cleanupOrphanedImages()`
already has today — a file can be written by the generator, then
deleted as "orphaned" in the narrow window before the worker persists
`result_path` onto the job row. This plan mirrors the existing,
already-accepted pattern deliberately rather than inventing a themes-only
fix for a risk the whole image pipeline already carries; cleanup is a
manual, occasional admin action ("nothing runs automatically" — see the
Storage settings page), not something that runs concurrently with
generation in practice. A real fix (e.g. reserving the filename in the
DB before the file write) would need to apply to both pipelines and is
out of scope for a plan whose job is adding themes, not re-architecting
an existing, accepted risk.

- [ ] **Step 1: Write the failing test for theme file serving**

```typescript
// test/themeFileServing.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeserve-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/themes/[filename]', () => {
  it('serves a real CSS file with the correct content type', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'real.css'), ':root { --color-bg: #000; }');
    const { GET } = await import('@/app/api/themes/[filename]/route');
    const res = await GET(new NextRequest('http://localhost/api/themes/real.css'), { params: Promise.resolve({ filename: 'real.css' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(await res.text()).toContain('--color-bg: #000;');
  });

  it('404s for a filename that does not exist', async () => {
    const { GET } = await import('@/app/api/themes/[filename]/route');
    const res = await GET(new NextRequest('http://localhost/api/themes/nope.css'), { params: Promise.resolve({ filename: 'nope.css' }) });
    expect(res.status).toBe(404);
  });

  it('400s on a path-traversal filename, mirroring the images route\'s own guard', async () => {
    const { GET } = await import('@/app/api/themes/[filename]/route');
    const res = await GET(new NextRequest('http://localhost/api/themes/..%2Fsecrets.css'), { params: Promise.resolve({ filename: '../secrets.css' }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/themeFileServing.test.ts`
Expected: FAIL — route doesn't exist yet.

- [ ] **Step 3: Write the theme-serving route**

```typescript
// app/api/themes/[filename]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Same guard as app/api/images/[filename]/route.ts — filenames come
  // from the database, never user-typed paths, but this is a public
  // route, so reject anything that isn't a bare filename.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'themes', filename);

  try {
    const data = await fsPromises.readFile(physicalPath, 'utf-8');
    return new NextResponse(data, {
      headers: { 'Content-Type': 'text/css' },
    });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Theme not found' }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/themeFileServing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for theme cleanup**

```typescript
// test/cleanupOrphanedThemes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;
const STYLE_ID = '99999999-9999-9999-9999-999999999999';

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themecleanup-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  const themesDir = path.join(tempRoot, 'storage', 'themes');
  await fsPromises.mkdir(themesDir, { recursive: true });
  await fsPromises.writeFile(path.join(themesDir, '.gitkeep'), '');

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('AssetService.cleanupOrphanedThemes', () => {
  it('removes a .css file referenced by nothing, keeps .gitkeep', async () => {
    const themesDir = path.join(tempRoot, 'storage', 'themes');
    await fsPromises.writeFile(path.join(themesDir, 'orphan.css'), ':root {}');

    const removed = await assetService.cleanupOrphanedThemes();
    expect(removed).toBe(1);
    await expect(fsPromises.access(path.join(themesDir, 'orphan.css'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(themesDir, '.gitkeep'))).resolves.toBeUndefined();
  });

  it('keeps a .css file referenced by an active asset', async () => {
    const themesDir = path.join(tempRoot, 'storage', 'themes');
    await fsPromises.writeFile(path.join(themesDir, 'keep.css'), ':root {}');
    await assetService.create({ styleId: STYLE_ID, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'keep.css', outputKind: 'theme' });

    const removed = await assetService.cleanupOrphanedThemes();
    expect(removed).toBe(0);
    await expect(fsPromises.access(path.join(themesDir, 'keep.css'))).resolves.toBeUndefined();
  });

  it('keeps a .css file referenced by a pending/processing/complete job', async () => {
    const themesDir = path.join(tempRoot, 'storage', 'themes');
    await fsPromises.writeFile(path.join(themesDir, 'inflight.css'), ':root {}');
    const db = DatabaseConnection.getInstance();
    db.prepare(
      `INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind)
       VALUES ('job-1', ?, 'user-1', 'theme', 'x', 'complete', 'inflight.css', 1000, 1000, '{}', 'theme')`
    ).run(STYLE_ID);

    const removed = await assetService.cleanupOrphanedThemes();
    expect(removed).toBe(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/cleanupOrphanedThemes.test.ts`
Expected: FAIL — method doesn't exist yet.

- [ ] **Step 7: Add `cleanupOrphanedThemes()`**

In `lib/services/AssetService.ts`, add a new method to the class, right
after `cleanupOrphanedImages()`. It mirrors that method exactly, pointed
at `storage/themes/` instead of `storage/images/` — the same "protected
if referenced by any asset row (active or soft-deleted) or any
pending/processing/complete job" rule applies identically, and this is
deliberately NOT filtered by `output_kind` in either query — a theme
filename never appears in an image row's `image_path` or vice versa
(they always differ by extension), so the two storage directories never
share filenames and no extra filter is needed:

```typescript
  /**
   * Removes physical files in storage/themes/ that are no longer needed.
   * Same protection rule as cleanupOrphanedImages() (see its own comment
   * for the full reasoning) — deliberately not filtered by output_kind,
   * since a theme filename never appears in an image row's image_path
   * or vice versa; the two storage directories never share filenames.
   */
  async cleanupOrphanedThemes(): Promise<number> {
    const db = DatabaseConnection.getInstance();
    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');

    let filenames: string[];
    try {
      filenames = (await fsPromises.readdir(themesDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
        .map(entry => entry.name);
    } catch (e) {
      console.error('Failed to read storage/themes for cleanup:', e);
      return 0;
    }

    const assetPaths = new Set(
      (db.prepare('SELECT image_path FROM assets WHERE image_path IS NOT NULL').all() as { image_path: string }[])
        .map(row => row.image_path)
    );

    const activeJobPaths = new Set(
      (db.prepare(`
        SELECT result_path FROM jobs
        WHERE result_path IS NOT NULL
        AND status IN ('pending', 'processing', 'complete')
      `).all() as { result_path: string }[])
        .map(row => row.result_path)
    );

    const orphans = filenames.filter(f => !assetPaths.has(f) && !activeJobPaths.has(f));

    let removed = 0;
    for (let i = 0; i < orphans.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = orphans.slice(i, i + IO_WRITE_BATCH_SIZE);
      const results = await Promise.all(chunk.map(async (filename) => {
        const filePath = path.join(themesDir, filename);
        try {
          await fsPromises.unlink(filePath);
          return true;
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error(`Failed to remove orphaned theme ${filename}:`, e);
          return false;
        }
      }));
      removed += results.filter(Boolean).length;
    }

    return removed;
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/cleanupOrphanedThemes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Extend the cleanup route and Settings page**

`app/api/storage/cleanup/route.ts` currently reads:

```typescript
export async function POST() {
  try {
    const removed = await assetService.cleanupOrphanedImages();
    return NextResponse.json({ success: true, data: { removed } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

Replace with:

```typescript
export async function POST() {
  try {
    const removedImages = await assetService.cleanupOrphanedImages();
    const removedThemes = await assetService.cleanupOrphanedThemes();
    return NextResponse.json({ success: true, data: { removed: removedImages + removedThemes } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

In `app/dashboard/settings/storage/page.tsx`, the page's copy currently
reads (two `<p>` elements referencing "images" specifically):

```tsx
      <p className="page-subtitle">
        Generated images that no longer belong to any asset or in-flight job pile up in{' '}
        <code>storage/images/</code>. Clean them up on demand — nothing runs automatically here.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Clean up orphaned images</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 16 }}>
          Safe to run any time — active assets, soft-deleted assets, and pending/processing/complete jobs
          are never touched.
        </p>
```

Replace both to speak generically (this button now cleans both
directories in one action):

```tsx
      <p className="page-subtitle">
        Generated files that no longer belong to any asset or in-flight job pile up in{' '}
        <code>storage/images/</code> and <code>storage/themes/</code>. Clean them up on demand — nothing
        runs automatically here.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Clean up orphaned files</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 16 }}>
          Safe to run any time — active assets, soft-deleted assets, and pending/processing/complete jobs
          are never touched, in either directory.
        </p>
```

The button itself and its result-reporting code need matching wording
tweaks — find:

```tsx
          ? `Removed ${body.data.removed} orphaned image${body.data.removed === 1 ? '' : 's'}.`
```

Replace with:

```tsx
          ? `Removed ${body.data.removed} orphaned file${body.data.removed === 1 ? '' : 's'}.`
```

And the button label:

```tsx
        <button className="btn btn-primary" onClick={handleCleanup} disabled={running}>
          {running ? 'Cleaning…' : 'Clean Up Orphaned Images'}
        </button>
```

becomes:

```tsx
        <button className="btn btn-primary" onClick={handleCleanup} disabled={running}>
          {running ? 'Cleaning…' : 'Clean Up Orphaned Files'}
        </button>
```

- [ ] **Step 10: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 11: Commit**

```bash
git add app/api/themes/[filename]/route.ts lib/services/AssetService.ts app/api/storage/cleanup/route.ts app/dashboard/settings/storage/page.tsx test/themeFileServing.test.ts test/cleanupOrphanedThemes.test.ts
git commit -m "Add theme file serving route and orphaned-theme cleanup"
```

---

### Task 6: Sample preview builder and theme rendering (Job/Asset cards, Asset detail page)

**Files:**
- Create: `lib/utils/themePreview.ts`
- Modify: `app/components/JobCard.tsx`
- Modify: `app/components/AssetCard.tsx`
- Modify: `app/dashboard/assets/[id]/page.tsx`
- Test: `test/themePreview.test.ts`

**Interfaces:**
- Consumes: `output_kind`, `result_path`/`image_path` (Task 1); `GET /api/themes/:filename` (Task 5).
- Produces: `buildThemePreviewHtml(cssUrl: string): string` — a complete HTML document string, used as an `<iframe>`'s `srcDoc`.

**Why the iframes get `sandbox=""`:** the primary defense against a
malicious/malformed theme value is Task 2's strict per-field CSS
grammar (`ThemeTokensSchema`'s regexes) — that's what actually prevents
a token value from breaking out of its CSS declaration. `sandbox=""` is
defense in depth on top of that: the preview document has no
`<script>` tags and needs none, so disabling script execution entirely
(along with forms, top-navigation, and popups) costs nothing
functionally and closes off any risk from a future change to the
preview markup.

- [ ] **Step 1: Write the failing test**

```typescript
// test/themePreview.test.ts
import { describe, it, expect } from 'vitest';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

describe('buildThemePreviewHtml', () => {
  it('links the given CSS URL as a stylesheet', () => {
    const html = buildThemePreviewHtml('/api/themes/abc.css');
    expect(html).toContain('<link rel="stylesheet" href="/api/themes/abc.css">');
  });

  it('includes a heading, a paragraph, two buttons, a card, and a nav bar, all referencing CSS variables', () => {
    const html = buildThemePreviewHtml('/api/themes/abc.css');
    expect(html).toContain('<h1');
    expect(html).toContain('<p');
    expect(html).toContain('var(--color-accent)');
    expect(html).toContain('var(--color-bg)');
    expect(html).toContain('var(--font-heading)');
    expect(html).toContain('nav');
    // Two distinct buttons: a primary (accent-filled) and a secondary (outlined).
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });

  it('is a complete, valid HTML document (has html/head/body)', () => {
    const html = buildThemePreviewHtml('/api/themes/abc.css');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/themePreview.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `themePreview.ts`**

```typescript
// lib/utils/themePreview.ts

/**
 * A complete, standalone HTML document for the theme-review iframe — see
 * the design spec's "Review and promotion" section for why this MUST be
 * an iframe (a separate document) rather than injected into the
 * dashboard's own DOM: the generated CSS sets :root variables that would
 * otherwise override GameForge's own theme variables.
 *
 * Every element here references only var(--...) — none of these variable
 * NAMES are invented by this file; they match exactly what
 * ThemeGenerator.tokensToCss() writes (--color-bg, --color-fg,
 * --color-accent, --color-border, --font-heading, --font-body,
 * --space-unit, --radius-base). Contains no <script> tags by design —
 * every caller renders this inside a sandbox="" iframe, which disables
 * script execution entirely.
 */
export function buildThemePreviewHtml(cssUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${cssUrl}">
<style>
  body {
    margin: 0;
    padding: calc(var(--space-unit, 8px) * 3);
    background: var(--color-bg, #fff);
    color: var(--color-fg, #111);
    font-family: var(--font-body, sans-serif);
  }
  h1 {
    font-family: var(--font-heading, serif);
    margin: 0 0 var(--space-unit, 8px) 0;
  }
  p {
    margin: 0 0 calc(var(--space-unit, 8px) * 2) 0;
  }
  nav {
    display: flex;
    gap: var(--space-unit, 8px);
    padding-bottom: calc(var(--space-unit, 8px) * 2);
    margin-bottom: calc(var(--space-unit, 8px) * 2);
    border-bottom: 1px solid var(--color-border, #ccc);
  }
  nav a {
    color: var(--color-fg, #111);
    text-decoration: none;
  }
  .card {
    padding: calc(var(--space-unit, 8px) * 2);
    border: 1px solid var(--color-border, #ccc);
    border-radius: var(--radius-base, 4px);
    margin-bottom: calc(var(--space-unit, 8px) * 2);
  }
  button {
    font-family: var(--font-body, sans-serif);
    padding: calc(var(--space-unit, 8px) * 0.75) calc(var(--space-unit, 8px) * 1.5);
    border-radius: var(--radius-base, 4px);
    border: 1px solid var(--color-border, #ccc);
    cursor: pointer;
  }
  .btn-primary {
    background: var(--color-accent, #333);
    color: var(--color-bg, #fff);
    border: none;
  }
  .btn-secondary {
    background: transparent;
    color: var(--color-fg, #111);
  }
</style>
</head>
<body>
  <nav>
    <a href="#">Home</a>
    <a href="#">About</a>
    <a href="#">Contact</a>
  </nav>
  <h1>Sample heading</h1>
  <p>A sample paragraph of body text, styled by the generated theme.</p>
  <div class="card">
    <p style="margin: 0;">A sample card, for spacing and border-radius.</p>
  </div>
  <button class="btn-primary">Primary action</button>
  <button class="btn-secondary">Secondary action</button>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/themePreview.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Render the preview in `JobCard`**

`app/components/JobCard.tsx` currently renders the thumbnail block
unconditionally as an `<img>` (or a placeholder `···`). Add the import:

```tsx
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';
```

Replace the thumbnail block:

```tsx
      <div
        style={{
          width: 72,
          height: 72,
          flexShrink: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {job.result_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${job.result_path}`}
            alt={job.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <span className="frame-label">···</span>
        )}
      </div>
```

With a version that branches on `job.output_kind`:

```tsx
      <div
        style={{
          width: 72,
          height: 72,
          flexShrink: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {job.output_kind === 'theme' && job.result_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}`)}
            title={`Theme preview: ${job.prompt}`}
            sandbox=""
            style={{ width: 260, height: 180, border: 'none', transform: 'scale(0.28)', transformOrigin: 'top left' }}
          />
        ) : job.result_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${job.result_path}`}
            alt={job.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <span className="frame-label">···</span>
        )}
      </div>
```

(The iframe is deliberately rendered at a real size, `260x180`, then
scaled down with CSS `transform: scale()` to fit the same 72x72 thumbnail
slot the image case uses — an iframe rendered directly at 72x72 would
make the sample page's text/buttons illegibly cramped; scaling a
larger render down keeps it readable-at-a-glance, matching what a real
thumbnail is for.)

- [ ] **Step 6: Render the preview in `AssetCard`**

`app/components/AssetCard.tsx` has the same shape of thumbnail block.
Add the same import and apply the equivalent change — the existing
block:

```tsx
      <div
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {asset.image_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${asset.image_path}`}
            alt={asset.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <span className="frame-label">no image</span>
        )}
      </div>
```

becomes:

```tsx
      <div
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {asset.output_kind === 'theme' && asset.image_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 320, height: 320, border: 'none', transform: 'scale(0.5)', transformOrigin: 'top left' }}
          />
        ) : asset.image_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/images/${asset.image_path}`}
            alt={asset.prompt}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <span className="frame-label">no image</span>
        )}
      </div>
```

- [ ] **Step 7: Render the preview on the Asset detail page and hide image-only controls**

`app/dashboard/assets/[id]/page.tsx` currently renders, unconditionally
whenever `asset.image_path` is truthy, an `<img>` tag pointed at
`/api/images/${asset.image_path}` plus an "Edit in Aseprite" button —
both wrong for a theme asset (the file lives under `/api/themes/`, not
`/api/images/`, and "open in a pixel-art editor" makes no sense for a
CSS file). Add the import:

```tsx
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';
```

The current block:

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
            {editStatus && (
              <p style={{ marginTop: 8, fontSize: 13, color: editFailed ? 'var(--reject)' : 'var(--ink-dim)' }}>
                {editStatus}
              </p>
            )}
          </div>
        </>
      )}
```

Replace with a branch on `asset.output_kind` — the theme case renders
a larger, sandboxed preview iframe and skips the Aseprite button
entirely; the existing image case is otherwise untouched:

```tsx
      {asset.output_kind === 'theme' && asset.image_path && (
        <iframe
          srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
          title={`Theme preview: ${asset.prompt}`}
          sandbox=""
          style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 24 }}
        />
      )}

      {asset.output_kind !== 'theme' && asset.image_path && (
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
            {editStatus && (
              <p style={{ marginTop: 8, fontSize: 13, color: editFailed ? 'var(--reject)' : 'var(--ink-dim)' }}>
                {editStatus}
              </p>
            )}
          </div>
        </>
      )}
```

The 9-slice-margins and States cards below stay exactly as they are —
they're inert-but-harmless for a theme asset (an unused UI affordance,
not a broken one); scoping them out too is unnecessary surface area for
what this task needs to fix.

- [ ] **Step 8: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green. No new automated test for the three
components themselves — this project's established convention doesn't
unit-test simple rendering components; correctness here is confirmed in
Task 8's manual walkthrough.

- [ ] **Step 9: Commit**

```bash
git add lib/utils/themePreview.ts app/components/JobCard.tsx app/components/AssetCard.tsx "app/dashboard/assets/[id]/page.tsx" test/themePreview.test.ts
git commit -m "Render sandboxed theme previews on Job/Asset cards and the asset detail page"
```

---

### Task 7: Theme generation page and nav entry

**Files:**
- Create: `app/dashboard/themes/page.tsx`
- Modify: `app/components/NavRail.tsx`

**Interfaces:**
- Consumes: `StyleBiblePicker` (existing, `@/app/components/StyleBiblePicker`), `useStyles` (existing, `@/lib/hooks/useStyles`), `useJobStore`/`usePolling` (existing), `JobCard` (Task 6's rendering applies automatically here too, since it's the same component).

- [ ] **Step 1: Write the page**

This mirrors `app/dashboard/generate/page.tsx` closely — same Style
Bible picker, same live-queue rendering via the shared `JobCard`, same
`useJobStore`/`usePolling` wiring — the only differences are the prompt
copy and posting `outputKind: 'theme'` instead of omitting it:

```tsx
// app/dashboard/themes/page.tsx
'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { usePolling } from '@/lib/hooks/usePolling';
import { useJobStore } from '@/lib/store/useJobStore';
import { getClientId } from '@/lib/utils/clientId';
import { JobCard } from '@/app/components/JobCard';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

export default function ThemesPage() {
  const { styles, loading: stylesLoading } = useStyles();
  const jobs = useJobStore(s => s.jobs).filter(j => j.output_kind === 'theme');
  const refreshActive = useJobStore(s => s.refreshActive);
  usePolling(refreshActive, 2000);

  const [styleId, setStyleId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeStyleId = styleId || styles[0]?.id || '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeStyleId || !prompt.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          styleId: activeStyleId,
          createdBy: getClientId(),
          assetType: 'theme',
          prompt: prompt.trim(),
          outputKind: 'theme',
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Generation failed to queue.');
      } else {
        setPrompt('');
        refreshActive();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Themes</h1>
      <p className="page-subtitle">
        Generate a website design token set (colors, typography, spacing) from a Style Bible. GameForge
        keeps every generation until you promote it to an asset or discard it — same as pixel art.
      </p>

      {!stylesLoading && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 32 }}>
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before generating a theme.
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 32, maxWidth: 480 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />

          <div className="field">
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="warm, editorial, generous whitespace"
            />
          </div>

          {error && (
            <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -8, marginBottom: 16 }}>{error}</p>
          )}

          <button className="btn btn-primary" type="submit" disabled={submitting || !prompt.trim()}>
            {submitting ? 'Queuing…' : 'Queue generation'}
          </button>
        </form>
      )}

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>
        Live queue
      </h2>
      {jobs.length === 0 ? (
        <div className="empty-state">Nothing in flight. Queue a generation above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.map(job => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Add the nav entry**

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
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
];
```

Add one entry after "UI Sheets" (both are generation-entry-point pages,
grouped together):

```typescript
const LINKS = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/themes', label: 'Themes' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
];
```

- [ ] **Step 3: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green. No new automated test for this page — same
reasoning as Task 6's cards; verified in Task 8's manual walkthrough.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/themes/page.tsx app/components/NavRail.tsx
git commit -m "Add Themes page and nav entry"
```

---

### Task 8: Manual real-world verification

**Files:** none (verification only).

The Anthropic API call, the actual visual preview rendering, and a real
git push/pull round-trip cannot be meaningfully exercised by the
automated suite alone. This task is a manual check, same discipline as
this project's prior features' real-API walkthroughs.

- [ ] **Step 1: Run the full automated suite one more time**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 2: Configure a real Anthropic API key**

Add `ANTHROPIC_API_KEY=<your real key>` to `.env.local` (git-ignored,
matching `PIXELLAB_API_KEY`'s existing entry there).

- [ ] **Step 3: Start the dev server and the worker**

Run `npm run dev` and `npm run dev:worker` in two terminals. Confirm
`.env.local` really has the key — this walkthrough should spend exactly
one real Anthropic call, not several.

- [ ] **Step 4: Walk the whole flow in a real browser**

1. Visit `/dashboard/themes`. Pick (or create) a Style Bible whose
   aesthetic is distinctive (e.g. "dark fantasy, parchment and iron" —
   something whose influence on the output would be obviously
   recognizable), write a short additional prompt (e.g. "warm, generous
   whitespace"), submit.
2. Watch the job complete on `/dashboard/jobs` (a real Anthropic call —
   should take a few seconds, not the 10-90s a Pixellab image generation
   takes). Confirm the worker log shows a `theme-*.css` result, not a
   `mock-theme-*.css` one.
3. Confirm the Jobs page renders a real, distinct-looking preview (not a
   blank/broken iframe) — the sample heading, paragraph, both buttons,
   the card, and the nav bar should all visibly reflect the generated
   colors/fonts/spacing, and that look should plausibly match the Style
   Bible picked in step 1 — this is the check that Task 2's
   style-parameters-in-prompt wiring actually mattered, not just that a
   theme rendered at all.
4. Open the generated `.css` file directly (`http://localhost:3000/api/themes/<filename>`)
   in a new tab — confirm it's real, readable CSS with all 8 custom
   properties present and populated with sensible-looking values (not
   empty strings, not literally the mock's fixed values).
5. Promote the job. Confirm it now appears on `/dashboard/assets` with
   the same preview rendering, sized down for the grid. Open its detail
   page (`/dashboard/assets/<id>`) and confirm it shows the larger
   preview iframe with no "Edit in Aseprite" button and no broken
   `<img>` — the exact regression Task 6 fixed.
6. Confirm the rest of the GameForge dashboard's own styling (the nav
   rail, the page background, existing buttons elsewhere on the page)
   looks completely normal throughout this whole flow — this is the
   direct check that the iframe isolation is actually working, not just
   present in the code.
7. If this project has a configured git remote reachable from this
   machine: run a Sync (push) from the Export/Sync UI, then confirm via
   `git log --stat` in the repo that the commit includes the theme
   asset's `.css` file under `storage/themes/` — the direct check that
   Task 4's git-staging fix actually works end-to-end, not just in the
   unit test's synthetic harness.
8. Discard or Retry one theme job (whichever the Jobs page offers) and
   confirm the underlying `storage/themes/*.css` file is actually gone
   afterward (check the filesystem directly) — the direct check that
   Task 4's `deleteFileIfSafe` fix works for a real job, not just the
   unit test.

- [ ] **Step 5: Clean up test artifacts**

Stop the dev server and worker. Remove any styles/jobs/assets created
purely for this walkthrough if they'd otherwise clutter a fresh
`data.db` someone else might look at — follow this project's existing
pattern of leaving the working tree clean after manual verification
(see prior sessions' cleanup of `data.db*`, `.worker.lock`, and generated
files under `storage/images/`/`storage/themes/`).

- [ ] **Step 6: Invoke `pre-push-review` before pushing**

Per this project's standing rule — before the `git push` that lands this
feature, run the `pre-push-review` skill against the full diff since the
last push, using a fresh subagent, before pushing. Address anything it
finds; if it finds nothing, push normally.
