# Stack/Prompt Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save a reusable "recipe" — prompt, tech-stack labels, an optional starting-theme prompt, and a wishlist of components — and apply it in one action to scaffold a new (or existing) Style Bible's starting generation batch.

**Architecture:** A new `presets` table (JSON-blob columns for tags/components, mirroring `styles.parameters`'s existing convention), a `PresetService` mirroring `StyleService`'s direct-SQL shape, and one new "apply" operation that atomically creates a Style Bible (if requested) plus one job per preset item, all sharing a `batch_id`, inside a single `better-sqlite3` transaction. Frontend is a new `/dashboard/presets` page plus a "Save as preset" entry point on the existing Style Bible Hub page.

**Tech Stack:** Next.js 16 App Router, better-sqlite3 (direct SQL, no ORM), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-stack-prompt-presets-design.md`

## Global Constraints

- Direct SQL only, no ORM — every service method uses `DatabaseConnection.getInstance().prepare(...)`.
- No wrapper classes, DTOs, factories, repository patterns, or custom error classes (per `AGENTS.md`).
- Every mutating API route requires `getCurrentUser(req)` from `lib/utils/session.ts`; 401 if null. Read (`GET`) routes require no auth, matching `GET /api/styles` and `GET /api/assets`.
- Presets have **no ownership restriction** — any logged-in user can edit/delete any preset (matches jobs/assets, not Style Bibles' owner-only-edit model). Confirmed explicitly with the user during brainstorming.
- `tech_stack_tags` and `components` are stored as JSON-serialized strings, matching `styles.parameters`'s and `jobs.options`'s existing convention — parsed at the API/service boundary, never queried into by SQL.
- The apply operation (style creation if new + every job insert + `batch_id` stamping) MUST run inside one synchronous `db.transaction()` — a mid-loop failure must leave zero partial rows, not the orphaned-job risk the existing (lower-stakes) multi-candidate loop in `app/api/generate/route.ts` accepts.
- Disable buttons on submission (existing convention, e.g. `disabled={saving}`).
- `try/catch` with `console.error` logging on all file/DB operations that can fail from external state (git-synced imports, concurrent processes) — though this feature does no file I/O.

---

### Task 1: Migration + schema

**Files:**
- Create: `lib/database/migrations/012_add_presets.sql`
- Modify: `lib/database/schema.ts`
- Test: `test/presetSchema.test.ts`

**Interfaces:**
- Produces: `PresetSchema`, `Preset` type, `PresetComponentSchema`, `PresetComponent` type — every later task imports these from `@/lib/database/schema`.

- [ ] **Step 1: Write the migration**

Create `lib/database/migrations/012_add_presets.sql`:

```sql
CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  prompt TEXT NOT NULL,
  tech_stack_tags TEXT NOT NULL DEFAULT '[]',
  theme_prompt TEXT,
  components TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Add the Zod schemas**

In `lib/database/schema.ts`, after `UserSchema` (end of file), add:

```ts
export const PresetComponentSchema = z.object({
  assetType: z.string().min(1),
  prompt: z.string().min(1),
});
export type PresetComponent = z.infer<typeof PresetComponentSchema>;

export const PresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  prompt: z.string().min(1),
  tech_stack_tags: z.string(), // JSON-serialized string[]
  theme_prompt: z.string().nullable(),
  components: z.string(), // JSON-serialized PresetComponent[]
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Preset = z.infer<typeof PresetSchema>;
```

- [ ] **Step 3: Write a test proving the migration applies cleanly and the schema round-trips**

Create `test/presetSchema.test.ts`:

```ts
// test/presetSchema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { PresetSchema } from '@/lib/database/schema';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetschema-'));
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

describe('presets table + PresetSchema', () => {
  it('accepts a full row with a null theme_prompt', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, 'SaaS Landing', 'user-1', 'minimalist SaaS landing page', '["Tailwind","React"]', NULL, '[{"assetType":"nav bar","prompt":"a nav bar"}]', 0, ?, ?)
    `).run('11111111-1111-1111-1111-111111111111', now, now);

    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get('11111111-1111-1111-1111-111111111111');
    const parsed = PresetSchema.parse(row);
    expect(parsed.theme_prompt).toBeNull();
    expect(JSON.parse(parsed.tech_stack_tags)).toEqual(['Tailwind', 'React']);
    expect(JSON.parse(parsed.components)).toEqual([{ assetType: 'nav bar', prompt: 'a nav bar' }]);
  });

  it('defaults tech_stack_tags and components to empty-array JSON when omitted', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, is_deleted, created_at, updated_at)
      VALUES (?, 'Bare', 'user-1', 'x', 0, ?, ?)
    `).run('22222222-2222-2222-2222-222222222222', now, now);

    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get('22222222-2222-2222-2222-222222222222');
    const parsed = PresetSchema.parse(row);
    expect(JSON.parse(parsed.tech_stack_tags)).toEqual([]);
    expect(JSON.parse(parsed.components)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/presetSchema.test.ts`
Expected: 2 tests pass, migration `012_add_presets.sql` logs as applied.

- [ ] **Step 5: Commit**

```bash
git add lib/database/migrations/012_add_presets.sql lib/database/schema.ts test/presetSchema.test.ts
git commit -m "feat: add presets table and PresetSchema"
```

---

### Task 2: PresetService CRUD

**Files:**
- Create: `lib/services/PresetService.ts`
- Test: `test/presetService.test.ts`

**Interfaces:**
- Consumes: `PresetSchema`, `Preset`, `PresetComponentSchema` from Task 1.
- Produces: `presetService` singleton with `getActivePresets()`, `getById(id)`, `create(input)`, `update(id, patch)`, `softDelete(id)` — later tasks (API routes, `applyPreset`) import `presetService` from `@/lib/services/PresetService`.

- [ ] **Step 1: Write the failing tests**

Create `test/presetService.test.ts`:

```ts
// test/presetService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetservice-'));
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

describe('PresetService', () => {
  it('creates a preset and reads it back', async () => {
    const preset = await presetService.create({
      name: 'SaaS Landing',
      createdBy: 'user-1',
      prompt: 'minimalist SaaS landing page, dark mode',
      techStackTags: JSON.stringify(['Tailwind', 'React']),
      themePrompt: 'dark, high-contrast, indigo accent',
      components: JSON.stringify([{ assetType: 'nav bar', prompt: 'a nav bar' }]),
    });
    expect(preset.name).toBe('SaaS Landing');
    expect(preset.is_deleted).toBe(0);

    const fetched = await presetService.getById(preset.id);
    expect(fetched?.id).toBe(preset.id);
  });

  it('getActivePresets excludes soft-deleted presets, newest first', async () => {
    const first = await presetService.create({
      name: 'First', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const second = await presetService.create({
      name: 'Second', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    await presetService.softDelete(first.id);

    const active = await presetService.getActivePresets();
    expect(active.map(p => p.id)).toEqual([second.id]);
  });

  it('update() has no ownership check - any caller can edit any preset', async () => {
    const preset = await presetService.create({
      name: 'Original', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const updated = await presetService.update(preset.id, { name: 'Renamed by someone else' });
    expect(updated?.name).toBe('Renamed by someone else');
  });

  it('update() returns null for a nonexistent preset', async () => {
    const result = await presetService.update('00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(result).toBeNull();
  });

  it('softDelete() flips is_deleted to 1', async () => {
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    await presetService.softDelete(preset.id);
    const fetched = await presetService.getById(preset.id);
    expect(fetched?.is_deleted).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/presetService.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/PresetService'`

- [ ] **Step 3: Write PresetService.ts**

Create `lib/services/PresetService.ts`:

```ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { PresetSchema, type Preset } from '@/lib/database/schema';

class PresetServiceImpl {
  async getActivePresets(): Promise<Preset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM presets WHERE is_deleted = 0 ORDER BY created_at DESC').all();
    return rows.map(row => PresetSchema.parse(row));
  }

  async getById(id: string): Promise<Preset | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id);
    return row ? PresetSchema.parse(row) : null;
  }

  async create(input: {
    name: string;
    createdBy: string;
    prompt: string;
    techStackTags: string;
    themePrompt: string | null;
    components: string;
  }): Promise<Preset> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.name, input.createdBy, input.prompt, input.techStackTags, input.themePrompt, input.components, now, now);
    return (await this.getById(id))!;
  }

  /** No ownership check - presets are shared, any logged-in user may edit any preset. */
  async update(id: string, patch: {
    name?: string;
    prompt?: string;
    techStackTags?: string;
    themePrompt?: string | null;
    components?: string;
  }): Promise<Preset | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE presets SET name = ?, prompt = ?, tech_stack_tags = ?, theme_prompt = ?, components = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.prompt ?? existing.prompt,
      patch.techStackTags ?? existing.tech_stack_tags,
      patch.themePrompt !== undefined ? patch.themePrompt : existing.theme_prompt,
      patch.components ?? existing.components,
      Date.now(),
      id
    );
    return this.getById(id);
  }

  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE presets SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

export const presetService = new PresetServiceImpl();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/presetService.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/PresetService.ts test/presetService.test.ts
git commit -m "feat: add PresetService CRUD"
```

---

### Task 3: applyPreset transaction

**Files:**
- Modify: `lib/services/PresetService.ts`
- Test: `test/presetApply.test.ts`

**Interfaces:**
- Consumes: `presetService` (Task 2), `styleService.getById` (existing, `lib/services/StyleService.ts`).
- Produces: `presetService.applyPreset(presetId, target, createdBy)` returning
  `Promise<{ styleId: string; batchId: string; jobIds: string[] } | { error: 'PRESET_NOT_FOUND' | 'STYLE_NOT_FOUND' | 'NOTHING_TO_GENERATE' }>` — Task 5 (the apply API route) calls this directly.

- [ ] **Step 1: Write the failing tests**

Create `test/presetApply.test.ts`:

```ts
// test/presetApply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetapply-'));
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

async function makeFullPreset() {
  return presetService.create({
    name: 'SaaS Landing',
    createdBy: 'user-1',
    prompt: 'minimalist SaaS landing page',
    techStackTags: JSON.stringify(['Tailwind']),
    themePrompt: 'dark, indigo accent',
    components: JSON.stringify([
      { assetType: 'nav bar', prompt: 'a nav bar' },
      { assetType: 'hero section', prompt: 'a hero section' },
    ]),
  });
}

describe('presetService.applyPreset', () => {
  it('creates a new style and one job per item (theme + components), all sharing one batch_id', async () => {
    const preset = await makeFullPreset();
    const result = await presetService.applyPreset(preset.id, { newStyleName: 'My New Bible' }, 'user-2');

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    const style = await styleService.getById(result.styleId);
    expect(style?.name).toBe('My New Bible');
    expect(style?.created_by).toBe('user-2');

    expect(result.jobIds).toHaveLength(3); // 1 theme + 2 components

    const db = DatabaseConnection.getInstance();
    const jobs = db.prepare('SELECT * FROM jobs WHERE style_id = ?').all(result.styleId) as any[];
    expect(jobs).toHaveLength(3);
    expect(jobs.every(j => j.batch_id === result.batchId)).toBe(true);
    expect(jobs.filter(j => j.output_kind === 'theme')).toHaveLength(1);
    expect(jobs.filter(j => j.output_kind === 'component')).toHaveLength(2);
    expect(jobs.every(j => j.status === 'pending')).toBe(true);
    expect(jobs.every(j => j.created_by === 'user-2')).toBe(true);
  });

  it('applies to an existing style without creating a new one', async () => {
    const existing = await styleService.create({ name: 'Existing Bible', createdBy: 'user-1', parameters: '{}' });
    const preset = await makeFullPreset();

    const result = await presetService.applyPreset(preset.id, { existingStyleId: existing.id }, 'user-2');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.styleId).toBe(existing.id);

    const db = DatabaseConnection.getInstance();
    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    expect(styleCount).toBe(1);
  });

  it('returns PRESET_NOT_FOUND for a nonexistent preset', async () => {
    const result = await presetService.applyPreset('00000000-0000-0000-0000-000000000000', { newStyleName: 'x' }, 'user-1');
    expect(result).toEqual({ error: 'PRESET_NOT_FOUND' });
  });

  it('returns STYLE_NOT_FOUND for a nonexistent existingStyleId', async () => {
    const preset = await makeFullPreset();
    const result = await presetService.applyPreset(preset.id, { existingStyleId: '00000000-0000-0000-0000-000000000000' }, 'user-1');
    expect(result).toEqual({ error: 'STYLE_NOT_FOUND' });
  });

  it('returns NOTHING_TO_GENERATE for a preset with no theme_prompt and no components, and creates nothing', async () => {
    const preset = await presetService.create({
      name: 'Empty', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const result = await presetService.applyPreset(preset.id, { newStyleName: 'Should not exist' }, 'user-1');
    expect(result).toEqual({ error: 'NOTHING_TO_GENERATE' });

    const db = DatabaseConnection.getInstance();
    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    expect(styleCount).toBe(0);
  });

  it('rolls back the whole transaction - a malformed components JSON string leaves zero style/job rows', async () => {
    // Inserted directly, bypassing PresetService.create's normal flow - this
    // shape can only arise from a corrupted/hostile git-synced import, not
    // from anything the app itself would write (matches the established
    // path-traversal test precedent in test/assetExportRoute.test.ts).
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    const presetId = '33333333-3333-3333-3333-333333333333';
    db.prepare(`
      INSERT INTO presets (id, name, created_by, prompt, tech_stack_tags, theme_prompt, components, is_deleted, created_at, updated_at)
      VALUES (?, 'Corrupt', 'user-1', 'x', '[]', 'a theme prompt', 'not valid json', 0, ?, ?)
    `).run(presetId, now, now);

    await expect(
      presetService.applyPreset(presetId, { newStyleName: 'Should not survive' }, 'user-1')
    ).rejects.toThrow();

    const styleCount = (db.prepare('SELECT COUNT(*) as c FROM styles').get() as { c: number }).c;
    const jobCount = (db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;
    expect(styleCount).toBe(0);
    expect(jobCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/presetApply.test.ts`
Expected: FAIL — `presetService.applyPreset is not a function`

- [ ] **Step 3: Implement applyPreset**

In `lib/services/PresetService.ts`, add the import and method:

```ts
import { styleService } from '@/lib/services/StyleService';
```

Add inside `PresetServiceImpl`, after `softDelete`:

```ts
  /**
   * Creates a Style Bible (if newStyleName given) plus one job per preset
   * item (the theme, if set, then every component), all sharing one
   * batch_id — atomically, inside a single db.transaction(). A mid-loop
   * failure (e.g. malformed components JSON on a corrupted row) rolls back
   * the whole operation rather than leaving a half-populated new style,
   * unlike the lower-stakes multi-candidate loop in app/api/generate/route.ts
   * which has no such transaction.
   */
  async applyPreset(
    presetId: string,
    target: { newStyleName?: string; existingStyleId?: string },
    createdBy: string
  ): Promise<
    | { styleId: string; batchId: string; jobIds: string[] }
    | { error: 'PRESET_NOT_FOUND' | 'STYLE_NOT_FOUND' | 'NOTHING_TO_GENERATE' }
  > {
    const preset = await this.getById(presetId);
    if (!preset) return { error: 'PRESET_NOT_FOUND' };

    if (target.existingStyleId) {
      const existing = await styleService.getById(target.existingStyleId);
      if (!existing) return { error: 'STYLE_NOT_FOUND' };
    }

    const db = DatabaseConnection.getInstance();

    // No custom Error subclass (AGENTS.md forbids them) - "nothing to
    // generate" is checked before any write happens, so it can just return
    // the error variant directly instead of throwing. better-sqlite3's
    // transaction() only rolls back on an uncaught throw; a normal return
    // here simply commits zero writes, which is correct - nothing was
    // written yet at this point in the callback.
    const runApply = db.transaction((): { styleId: string; batchId: string; jobIds: string[] } | { error: 'NOTHING_TO_GENERATE' } => {
      const components = JSON.parse(preset.components) as { assetType: string; prompt: string }[];
      if (!preset.theme_prompt && components.length === 0) {
        return { error: 'NOTHING_TO_GENERATE' };
      }

      let styleId: string;
      if (target.existingStyleId) {
        styleId = target.existingStyleId;
      } else {
        styleId = crypto.randomUUID();
        const now = Date.now();
        db.prepare(`
          INSERT INTO styles (id, name, created_by, parameters, forked_from, is_deleted, created_at, updated_at)
          VALUES (?, ?, ?, '{}', NULL, 0, ?, ?)
        `).run(styleId, target.newStyleName, createdBy, now, now);
      }

      const items: { assetType: string; prompt: string; outputKind: 'theme' | 'component' }[] = [];
      if (preset.theme_prompt) {
        items.push({ assetType: 'theme', prompt: preset.theme_prompt, outputKind: 'theme' });
      }
      for (const c of components) {
        items.push({ assetType: c.assetType, prompt: c.prompt, outputKind: 'component' });
      }

      const batchId = crypto.randomUUID();
      const jobIds: string[] = [];
      for (const item of items) {
        const jobId = crypto.randomUUID();
        const now = Date.now();
        db.prepare(`
          INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
          VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, '{}', ?, ?)
        `).run(jobId, styleId, createdBy, item.assetType, item.prompt, now, now, item.outputKind, batchId);
        jobIds.push(jobId);
      }

      return { styleId, batchId, jobIds };
    });

    // A malformed components JSON string (only reachable via a corrupted
    // row - see the forced-rollback test) throws a plain built-in
    // SyntaxError from JSON.parse above; better-sqlite3 rolls back
    // automatically on any uncaught throw from the callback, and that
    // error is left to propagate uncaught here too - it is not an expected
    // condition this method translates into a typed result.
    return runApply();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/presetApply.test.ts`
Expected: 6 tests pass, including the forced-rollback test.

- [ ] **Step 5: Commit**

```bash
git add lib/services/PresetService.ts test/presetApply.test.ts
git commit -m "feat: add PresetService.applyPreset with transactional rollback"
```

---

### Task 4: Preset CRUD API routes

**Files:**
- Create: `app/api/presets/route.ts`
- Create: `app/api/presets/[id]/route.ts`
- Test: `test/presetsRoute.test.ts`

**Interfaces:**
- Consumes: `presetService` (Task 2), `getCurrentUser` (`lib/utils/session.ts`, existing).
- Produces: `GET/POST /api/presets`, `GET/PUT/DELETE /api/presets/[id]` — Task 8 (the presets page UI) calls these.

- [ ] **Step 1: Write the failing tests**

Create `test/presetsRoute.test.ts`:

```ts
// test/presetsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { GET as listPresets, POST as createPreset } from '@/app/api/presets/route';
import { GET as getPreset, PUT as updatePreset, DELETE as deletePreset } from '@/app/api/presets/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetsroute-'));
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

function req(method: string, body?: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/presets/x', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('preset CRUD routes', () => {
  it('POST /api/presets requires login', async () => {
    const res = await createPreset(req('POST', { name: 'x', prompt: 'x' }));
    expect(res.status).toBe(401);
  });

  it('POST then GET list then GET one then PUT then DELETE, full round trip', async () => {
    const { cookieHeader } = await seedSession();

    const createRes = await createPreset(req('POST', {
      name: 'SaaS Landing',
      prompt: 'minimalist SaaS landing page',
      techStackTags: ['Tailwind'],
      themePrompt: 'dark, indigo accent',
      components: [{ assetType: 'nav bar', prompt: 'a nav bar' }],
    }, cookieHeader));
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()).data;
    expect(created.name).toBe('SaaS Landing');

    const listRes = await listPresets();
    const list = (await listRes.json()).data;
    expect(list.map((p: any) => p.id)).toContain(created.id);

    const getRes = await getPreset(req('GET'), { params: Promise.resolve({ id: created.id }) });
    expect((await getRes.json()).data.id).toBe(created.id);

    const putRes = await updatePreset(req('PUT', { name: 'Renamed' }, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    expect((await putRes.json()).data.name).toBe('Renamed');

    const deleteRes = await deletePreset(req('DELETE', undefined, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    expect(deleteRes.status).toBe(200);

    const listAfterDelete = (await (await listPresets()).json()).data;
    expect(listAfterDelete.map((p: any) => p.id)).not.toContain(created.id);
  });

  it('PUT requires login', async () => {
    const { cookieHeader } = await seedSession();
    const createRes = await createPreset(req('POST', { name: 'x', prompt: 'x' }, cookieHeader));
    const created = (await createRes.json()).data;

    const res = await updatePreset(req('PUT', { name: 'y' }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(401);
  });

  it('GET /api/presets/[id] returns 404 for a nonexistent id', async () => {
    const res = await getPreset(req('GET'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/presetsRoute.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the routes**

Create `app/api/presets/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const presets = await presetService.getActivePresets();
    return NextResponse.json({ success: true, data: presets });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const CreatePresetSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  techStackTags: z.array(z.string()).default([]),
  themePrompt: z.string().nullable().optional(),
  components: z.array(z.object({ assetType: z.string().min(1), prompt: z.string().min(1) })).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = CreatePresetSchema.parse(await req.json());
    const preset = await presetService.create({
      name: input.name,
      createdBy: user.id,
      prompt: input.prompt,
      techStackTags: JSON.stringify(input.techStackTags),
      themePrompt: input.themePrompt ?? null,
      components: JSON.stringify(input.components),
    });
    return NextResponse.json({ success: true, data: preset });
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

Create `app/api/presets/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const preset = await presetService.getById(id);
    if (!preset) return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: preset });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const UpdatePresetSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  techStackTags: z.array(z.string()).optional(),
  themePrompt: z.string().nullable().optional(),
  components: z.array(z.object({ assetType: z.string().min(1), prompt: z.string().min(1) })).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = UpdatePresetSchema.parse(await req.json());
    const updated = await presetService.update(id, {
      name: input.name,
      prompt: input.prompt,
      techStackTags: input.techStackTags !== undefined ? JSON.stringify(input.techStackTags) : undefined,
      themePrompt: input.themePrompt,
      components: input.components !== undefined ? JSON.stringify(input.components) : undefined,
    });
    if (!updated) return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: updated });
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
    const existing = await presetService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });

    await presetService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/presetsRoute.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/presets/route.ts "app/api/presets/[id]/route.ts" test/presetsRoute.test.ts
git commit -m "feat: add preset CRUD API routes"
```

---

### Task 5: Apply endpoint

**Files:**
- Create: `app/api/presets/[id]/apply/route.ts`
- Test: `test/presetApplyRoute.test.ts`

**Interfaces:**
- Consumes: `presetService.applyPreset` (Task 3), `getCurrentUser`.
- Produces: `POST /api/presets/[id]/apply` — Task 9 (the frontend apply flow) calls this.

- [ ] **Step 1: Write the failing tests**

Create `test/presetApplyRoute.test.ts`:

```ts
// test/presetApplyRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { presetService } from '@/lib/services/PresetService';
import { seedSession } from './helpers/testSession';
import { POST as applyPreset } from '@/app/api/presets/[id]/apply/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-presetapplyroute-'));
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

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/presets/x/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/presets/[id]/apply', () => {
  it('requires login', async () => {
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme', components: '[]',
    });
    const res = await applyPreset(req({ newStyleName: 'x' }), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(401);
  });

  it('rejects a body with neither newStyleName nor existingStyleId', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme', components: '[]',
    });
    const res = await applyPreset(req({}, cookieHeader), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(400);
  });

  it('rejects a body with BOTH newStyleName and existingStyleId', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme', components: '[]',
    });
    const res = await applyPreset(
      req({ newStyleName: 'x', existingStyleId: '11111111-1111-1111-1111-111111111111' }, cookieHeader),
      { params: Promise.resolve({ id: preset.id }) }
    );
    expect(res.status).toBe(400);
  });

  it('applies successfully and returns styleId/batchId/jobIds', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'x', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: 'a theme',
      components: JSON.stringify([{ assetType: 'nav bar', prompt: 'a nav bar' }]),
    });
    const res = await applyPreset(req({ newStyleName: 'New Bible' }, cookieHeader), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.jobIds).toHaveLength(2);
  });

  it('returns 400 for a preset with nothing to generate', async () => {
    const { cookieHeader } = await seedSession();
    const preset = await presetService.create({
      name: 'Empty', createdBy: 'user-1', prompt: 'x', techStackTags: '[]', themePrompt: null, components: '[]',
    });
    const res = await applyPreset(req({ newStyleName: 'x' }, cookieHeader), { params: Promise.resolve({ id: preset.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent preset', async () => {
    const { cookieHeader } = await seedSession();
    const res = await applyPreset(
      req({ newStyleName: 'x' }, cookieHeader),
      { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) }
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/presetApplyRoute.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

Create `app/api/presets/[id]/apply/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { presetService } from '@/lib/services/PresetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const ApplyPresetSchema = z.object({
  newStyleName: z.string().min(1).optional(),
  existingStyleId: z.string().uuid().optional(),
}).refine(
  data => (data.newStyleName ? 1 : 0) + (data.existingStyleId ? 1 : 0) === 1,
  { message: 'Provide exactly one of newStyleName or existingStyleId' }
);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = ApplyPresetSchema.parse(await req.json());
    const result = await presetService.applyPreset(id, input, user.id);

    if ('error' in result) {
      if (result.error === 'NOTHING_TO_GENERATE') {
        return NextResponse.json({ success: false, error: 'This preset has nothing to generate.' }, { status: 400 });
      }
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/presetApplyRoute.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add "app/api/presets/[id]/apply/route.ts" test/presetApplyRoute.test.ts
git commit -m "feat: add preset apply endpoint"
```

---

### Task 6: Similarity-route fix — filter batch siblings to theme-only

**Files:**
- Modify: `app/api/jobs/[id]/similarity/route.ts:64-74`
- Test: `test/jobSimilarity.test.ts` (check first whether this file already exists; if so, add to it — do not overwrite)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — internal fix only.

- [ ] **Step 1: Check for an existing test file**

Run: `ls test/ | grep -i similar`

If `test/jobSimilarityRoute.test.ts` (or similarly named) already exists, read it fully and add the new test case into its existing `describe` block, following its existing setup pattern exactly, rather than creating a new file. If no such file exists, create `test/jobSimilarity.test.ts` following the temp-DB pattern used in every other test this plan touches (copy the `beforeEach`/`afterEach` block from Task 3's `test/presetApply.test.ts` verbatim, changing only the `mkdtemp` prefix).

- [ ] **Step 2: Write the failing test**

Add this test case (adjust `describe`/imports to match whichever file you're using):

```ts
it('does not attempt to read a non-theme sibling in the same batch', async () => {
  // Two jobs share a batch_id: a theme job (the one we check) and a
  // component job (a sibling that should be skipped entirely, not
  // parsed as theme CSS).
  const db = DatabaseConnection.getInstance();
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const batchId = crypto.randomUUID();
  const now = Date.now();

  const themeJobId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
    VALUES (?, ?, 'user-1', 'theme', 'x', 'complete', 'missing-theme.css', ?, ?, '{}', 'theme', ?)
  `).run(themeJobId, style.id, now, now, batchId);

  const componentJobId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
    VALUES (?, ?, 'user-1', 'nav bar', 'x', 'complete', 'this-would-throw-if-parsed-as-css.html', ?, ?, '{}', 'component', ?)
  `).run(componentJobId, style.id, now, now, batchId);

  // The theme job's own result_path is also missing on disk - readThemeTokens
  // degrades to null for it too, so the request completes with flagged:false
  // either way. What this test actually proves is in the NEXT assertion:
  // the component sibling's .html path is never even attempted.
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = await getSimilarity(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: themeJobId }) });
  expect(res.status).toBe(200);

  const attemptedPaths = consoleSpy.mock.calls.map(call => String(call[1] ?? call[0]));
  expect(attemptedPaths.some(p => p.includes('this-would-throw-if-parsed-as-css.html'))).toBe(false);
  consoleSpy.mockRestore();
});
```

Add `import crypto from 'crypto';`, `import { vi } from 'vitest';` (if not already imported), `import { styleService } from '@/lib/services/StyleService';`, and `import { GET as getSimilarity } from '@/app/api/jobs/[id]/similarity/route';` to the top of whichever file you're using, if not already present.

- [ ] **Step 3: Run the test to verify it currently passes for the wrong reason, or fails**

Run: `npx vitest run <the test file>`

This test may already pass today by coincidence (the try/catch degrades any parse failure to a skip either way) — that's expected and fine; the point of Step 4 below is to make the *filter* explicit so the wasted read+parse-attempt (and its `console.error` call) stops happening at all. If it currently fails, note the failure mode before proceeding.

- [ ] **Step 4: Add the filter**

In `app/api/jobs/[id]/similarity/route.ts`, change:

```ts
    if (job.batch_id) {
      const siblings = await jobService.getByBatchId(job.batch_id);
      for (const sibling of siblings) {
        if (sibling.id === job.id || !sibling.result_path) continue;
```

to:

```ts
    if (job.batch_id) {
      const siblings = await jobService.getByBatchId(job.batch_id);
      for (const sibling of siblings) {
        if (sibling.id === job.id || !sibling.result_path || sibling.output_kind !== 'theme') continue;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run <the test file>`
Expected: PASS, and no `console.error` call mentioning `this-would-throw-if-parsed-as-css.html`.

- [ ] **Step 6: Commit**

```bash
git add "app/api/jobs/[id]/similarity/route.ts" <the test file>
git commit -m "fix: skip non-theme siblings in batch similarity check"
```

---

### Task 7: NavRail entry

**Files:**
- Modify: `app/components/NavRail.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Add the nav link**

In `app/components/NavRail.tsx`, in the `LINKS` array, add a new entry. Place it after `{ href: '/dashboard/styles', label: 'Style Bibles' }` (presets are closely related to Style Bibles):

```ts
  { href: '/dashboard/presets', label: 'Presets' },
```

- [ ] **Step 2: Manually verify**

This is a one-line UI change with no dedicated test (matches this codebase's convention — no `.test.tsx` files exist anywhere). It will be exercised end-to-end once Task 8 creates `/dashboard/presets`; there is nothing to test in isolation before that page exists. Proceed.

- [ ] **Step 3: Commit**

```bash
git add app/components/NavRail.tsx
git commit -m "feat: add Presets nav link"
```

---

### Task 8: Presets page — list, create, edit, delete

**Files:**
- Create: `app/dashboard/presets/page.tsx`
- Create: `app/components/PresetForm.tsx` (shared with Task 10's "Save as preset" entry point)

**Interfaces:**
- Consumes: `GET/POST /api/presets`, `GET/PUT/DELETE /api/presets/[id]` (Task 4).
- Produces: `PresetForm` component — exported as `export function PresetForm(props: PresetFormProps)`, consumed by Task 10.

- [ ] **Step 1: Read the existing Style Bibles page for the exact pattern to mirror**

Read `app/dashboard/styles/page.tsx` in full (already read once this session — confirm current state; a `View`/`Fork` button row was added in PR #14) before writing this task. The list/create-form layout, `className="card"`/`"grid"`/`"empty-state"` usage, and the `useState` + `fetch` + `await refresh()` pattern are what this page mirrors.

- [ ] **Step 2: Write `PresetForm.tsx`**

Create `app/components/PresetForm.tsx`:

```tsx
// app/components/PresetForm.tsx
'use client';

import { useState } from 'react';

export interface PresetFormComponent {
  assetType: string;
  prompt: string;
}

export interface PresetFormValue {
  name: string;
  prompt: string;
  techStackTags: string; // comma-separated, as typed
  themePrompt: string;   // empty string means "no theme"
  components: PresetFormComponent[];
}

const EMPTY_VALUE: PresetFormValue = {
  name: '',
  prompt: '',
  techStackTags: '',
  themePrompt: '',
  components: [],
};

export function PresetForm({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial?: Partial<PresetFormValue>;
  onSubmit: (value: PresetFormValue) => Promise<void>;
  submitLabel: string;
}) {
  const [value, setValue] = useState<PresetFormValue>({ ...EMPTY_VALUE, ...initial });
  const [newComponentType, setNewComponentType] = useState('');
  const [saving, setSaving] = useState(false);

  function addComponent() {
    const type = newComponentType.trim();
    if (!type) return;
    setValue(v => ({
      ...v,
      components: [...v.components, { assetType: type, prompt: `${v.prompt} ${type}`.trim() }],
    }));
    setNewComponentType('');
  }

  function updateComponentPrompt(index: number, prompt: string) {
    setValue(v => ({
      ...v,
      components: v.components.map((c, i) => (i === index ? { ...c, prompt } : c)),
    }));
  }

  function removeComponent(index: number) {
    setValue(v => ({ ...v, components: v.components.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !value.name.trim() || !value.prompt.trim()) return;
    setSaving(true);
    try {
      await onSubmit(value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
      <div className="field">
        <label htmlFor="preset-name">Name</label>
        <input id="preset-name" value={value.name} onChange={e => setValue(v => ({ ...v, name: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor="preset-prompt">Prompt</label>
        <textarea id="preset-prompt" rows={2} value={value.prompt} onChange={e => setValue(v => ({ ...v, prompt: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor="preset-tags">Tech-stack tags (comma-separated)</label>
        <input id="preset-tags" value={value.techStackTags} onChange={e => setValue(v => ({ ...v, techStackTags: e.target.value }))} placeholder="Tailwind, React, SaaS" />
      </div>
      <div className="field">
        <label htmlFor="preset-theme-prompt">Theme prompt (optional)</label>
        <textarea id="preset-theme-prompt" rows={2} value={value.themePrompt} onChange={e => setValue(v => ({ ...v, themePrompt: e.target.value }))} />
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Components</div>
        {value.components.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
            <span className="badge">{c.assetType}</span>
            <input
              value={c.prompt}
              onChange={e => updateComponentPrompt(i, e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={() => removeComponent(i)}>Remove</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={newComponentType}
            onChange={e => setNewComponentType(e.target.value)}
            placeholder="nav bar"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addComponent();
              }
            }}
          />
          <button type="button" className="btn" onClick={addComponent}>Add component</button>
        </div>
      </div>

      <button className="btn btn-primary" type="submit" disabled={saving || !value.name.trim() || !value.prompt.trim()}>
        {saving ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Write the presets page**

Create `app/dashboard/presets/page.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Preset, Style } from '@/lib/database/schema';
import { PresetForm, type PresetFormValue } from '@/app/components/PresetForm';

export default function PresetsPage() {
  const router = useRouter();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyMode, setApplyMode] = useState<'new' | 'existing'>('new');
  const [applyNewName, setApplyNewName] = useState('');
  const [applyExistingId, setApplyExistingId] = useState('');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [styles, setStyles] = useState<Style[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/presets');
    const body = await res.json();
    if (body.success) setPresets(body.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [presetsRes, stylesRes] = await Promise.all([
          fetch('/api/presets'),
          fetch('/api/styles'),
        ]);
        const presetsBody = await presetsRes.json();
        const stylesBody = await stylesRes.json();
        if (ignore) return;
        if (presetsBody.success) setPresets(presetsBody.data);
        if (stylesBody.success) setStyles(stylesBody.data);
      } catch {
        // Falls through to the empty-state below.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);

  async function handleCreate(value: PresetFormValue) {
    await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: value.name,
        prompt: value.prompt,
        techStackTags: value.techStackTags.split(',').map(t => t.trim()).filter(Boolean),
        themePrompt: value.themePrompt.trim() || null,
        components: value.components,
      }),
    });
    setCreating(false);
    await refresh();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/presets/${id}`, { method: 'DELETE' });
    await refresh();
  }

  async function handleUpdate(id: string, value: PresetFormValue) {
    await fetch(`/api/presets/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: value.name,
        prompt: value.prompt,
        techStackTags: value.techStackTags.split(',').map(t => t.trim()).filter(Boolean),
        themePrompt: value.themePrompt.trim() || null,
        components: value.components,
      }),
    });
    setEditingId(null);
    await refresh();
  }

  function presetToFormValue(preset: Preset): PresetFormValue {
    return {
      name: preset.name,
      prompt: preset.prompt,
      techStackTags: (JSON.parse(preset.tech_stack_tags) as string[]).join(', '),
      themePrompt: preset.theme_prompt ?? '',
      components: JSON.parse(preset.components),
    };
  }

  function openApply(presetId: string) {
    setApplyingId(presetId);
    setApplyMode('new');
    setApplyNewName('');
    setApplyExistingId('');
    setApplyError(null);
  }

  async function handleApply() {
    if (!applyingId || applyBusy) return;
    setApplyBusy(true);
    setApplyError(null);
    try {
      const body = applyMode === 'new'
        ? { newStyleName: applyNewName.trim() }
        : { existingStyleId: applyExistingId };
      const res = await fetch(`/api/presets/${applyingId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.success) {
        setApplyError(result.error ?? 'Could not apply this preset.');
        return;
      }
      router.push('/dashboard/jobs');
    } catch {
      setApplyError('Could not reach the server.');
    } finally {
      setApplyBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Presets</h1>
      <p className="page-subtitle">
        A reusable recipe — prompt, tech-stack labels, and a starting set of things to generate.
        Applying one queues a theme (if set) and every listed component as one batch.
      </p>

      {!creating ? (
        <button className="btn btn-primary" style={{ marginBottom: 24 }} onClick={() => setCreating(true)}>
          New Preset
        </button>
      ) : (
        <div style={{ marginBottom: 24 }}>
          <PresetForm onSubmit={handleCreate} submitLabel="Create Preset" />
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {!loading && presets.length === 0 ? (
        <div className="empty-state">No presets yet. Create the first one above.</div>
      ) : (
        <div className="grid">
          {presets.map(preset => {
            if (editingId === preset.id) {
              return (
                <div key={preset.id} style={{ gridColumn: '1 / -1' }}>
                  <PresetForm
                    initial={presetToFormValue(preset)}
                    onSubmit={value => handleUpdate(preset.id, value)}
                    submitLabel="Save Changes"
                  />
                  <button className="btn" style={{ marginTop: 8 }} onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              );
            }
            const tags: string[] = JSON.parse(preset.tech_stack_tags);
            const components: { assetType: string }[] = JSON.parse(preset.components);
            return (
              <div key={preset.id} className="card">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{preset.name}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 8 }}>{preset.prompt}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {tags.map(t => <span key={t} className="badge">{t}</span>)}
                  {preset.theme_prompt && <span className="badge">theme</span>}
                  <span className="badge">{components.length} component{components.length === 1 ? '' : 's'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={() => openApply(preset.id)}>Apply</button>
                  <button className="btn" onClick={() => setEditingId(preset.id)}>Edit</button>
                  <button className="btn" onClick={() => handleDelete(preset.id)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {applyingId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Apply preset</strong>
              <button className="btn" onClick={() => setApplyingId(null)}>Cancel</button>
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <label>
                <input type="radio" checked={applyMode === 'new'} onChange={() => setApplyMode('new')} /> New Style Bible
              </label>
              <label>
                <input type="radio" checked={applyMode === 'existing'} onChange={() => setApplyMode('existing')} /> Existing Style Bible
              </label>
            </div>
            {applyMode === 'new' ? (
              <input
                value={applyNewName}
                onChange={e => setApplyNewName(e.target.value)}
                placeholder="New Style Bible name"
                style={{ width: '100%', marginBottom: 12 }}
              />
            ) : (
              <select value={applyExistingId} onChange={e => setApplyExistingId(e.target.value)} style={{ width: '100%', marginBottom: 12 }}>
                <option value="">Choose a Style Bible…</option>
                {styles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            {applyError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{applyError}</p>}
            <button
              className="btn btn-primary"
              disabled={applyBusy || (applyMode === 'new' ? !applyNewName.trim() : !applyExistingId)}
              onClick={handleApply}
            >
              {applyBusy ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Manually verify**

No dedicated component test file (matches this codebase's existing convention of zero `.test.tsx` files — verified via `ls test/*.test.tsx` returning nothing in a prior session audit). This page is exercised end-to-end in Task 11's final verification pass, run against a real dev server.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/presets/page.tsx app/components/PresetForm.tsx
git commit -m "feat: add Presets page (list, create, delete, apply)"
```

---

### Task 9: "Save as preset" on the Style Bible Hub page

**Files:**
- Modify: `app/dashboard/styles/[id]/page.tsx`

**Interfaces:**
- Consumes: `PresetForm` (Task 8), the Hub page's already-fetched `assets` state (existing).
- Produces: nothing new.

- [ ] **Step 1: Read the current Hub page in full**

Read `app/dashboard/styles/[id]/page.tsx` (shipped in PR #14 this session, then modified again for the confirm-dialog and Copilot-fix commits — re-read its CURRENT state, not what's described elsewhere in this plan or in memory, before editing).

- [ ] **Step 2: Add a "Save as preset" button and modal**

Add state:

```ts
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [savePresetStatus, setSavePresetStatus] = useState<string | null>(null);
```

Add a handler that derives the prefill from the Hub's existing `assets` array (already fetched — no new API call):

```ts
  function buildPresetPrefill() {
    const promotedThemes = assets.filter(a => a.output_kind === 'theme');
    const promotedComponents = assets.filter(a => a.output_kind === 'component');
    const mostRecentTheme = promotedThemes[0]; // assets are already ordered newest-first by the API
    return {
      name: `${style?.name ?? 'Untitled'} preset`,
      prompt: '',
      techStackTags: '',
      themePrompt: mostRecentTheme?.prompt ?? '',
      components: promotedComponents.map(a => ({ assetType: a.asset_type, prompt: a.prompt })),
    };
  }

  async function handleSavePreset(value: import('@/app/components/PresetForm').PresetFormValue) {
    await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: value.name,
        prompt: value.prompt,
        techStackTags: value.techStackTags.split(',').map(t => t.trim()).filter(Boolean),
        themePrompt: value.themePrompt.trim() || null,
        components: value.components,
      }),
    });
    setShowSavePreset(false);
    setSavePresetStatus('Saved as a new preset.');
  }
```

Add the import at the top: `import { PresetForm } from '@/app/components/PresetForm';`

Add the button (placed near the existing Rename/Delete button row — inside the `isOwner &&` block is NOT required, since saving a preset from a bible you don't own is harmless and consistent with presets having no ownership restriction; place it as its own always-visible block after the existing owner-gated button row):

```tsx
      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={() => setShowSavePreset(true)}>Save as preset</button>
        {savePresetStatus && <p style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-dim)' }}>{savePresetStatus}</p>}
      </div>

      {showSavePreset && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 560, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Save as preset</strong>
              <button className="btn" onClick={() => setShowSavePreset(false)}>Cancel</button>
            </div>
            <PresetForm initial={buildPresetPrefill()} onSubmit={handleSavePreset} submitLabel="Save Preset" />
          </div>
        </div>
      )}
```

Place this block after the existing three asset-kind `<div>` sections (Themes/Components/Images), near the end of the returned JSX, before the closing `</>`.

- [ ] **Step 3: Manually verify**

No dedicated test — same reasoning as Task 8 (no `.test.tsx` convention in this codebase). Exercised in Task 11's final verification.

- [ ] **Step 4: Commit**

```bash
git add "app/dashboard/styles/[id]/page.tsx"
git commit -m "feat: add Save as preset to the Style Bible Hub page"
```

---

### Task 10: Final verification

**Files:** None created or modified — this task only runs checks.

**Interfaces:** None.

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: every test file passes, including all new files from Tasks 1-6.

- [ ] **Step 3: Grep sweep for anything half-wired**

Run:
```bash
grep -rn "PresetForm" app/ --include='*.tsx'
grep -rn "presetService" lib/ app/ --include='*.ts'
grep -rn "applyPreset" lib/ app/ --include='*.ts'
```
Expected: `PresetForm` used in both `app/dashboard/presets/page.tsx` and `app/dashboard/styles/[id]/page.tsx`; `presetService` used in all 4 route files plus its own service file; `applyPreset` used in the apply route and the service.

- [ ] **Step 4: Manual browser verification**

Start the dev server (`npm run dev`), create a test account if needed, and walk through: create a preset with a theme prompt + 2 components on `/dashboard/presets` → Edit it (change the name, confirm the form prefilled correctly, save) → Apply it as a new Style Bible → confirm redirect to `/dashboard/jobs` shows 3 pending jobs sharing a batch → go to the new Style Bible's Hub page (empty, since nothing promoted yet) → go to an existing Style Bible with promoted assets → click "Save as preset" → confirm the form prefills from that bible's promoted theme + components → save → confirm it appears on `/dashboard/presets`. Clean up any test accounts/data created purely for this verification the same way established earlier this session (a script run with the user's confirmation, or ask first) — do not leave throwaway rows in `data.db`.

- [ ] **Step 5: Commit (if Step 4 surfaced any fixes)**

Only if manual verification found something to fix. Otherwise this task ends at Step 4.
