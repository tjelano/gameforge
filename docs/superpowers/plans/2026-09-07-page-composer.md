# Page Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user arrange N of a Style Bible's promoted components into an ordered page, preview it live with correctly-scoped combined CSS and the bible's theme applied, and download it as one standalone HTML file.

**Architecture:** A new `pages` table storing an ordered JSON array of component asset ids (no stored document — the combined HTML is computed on demand). A pure `composePageHtml` function does the actual work: per-component CSS scoping via `postcss` selector-rewriting (verified against the real installed library) plus HTML wrapping, so multiple components' CSS can never collide. The existing per-style theme-CSS-lookup logic gets extracted out of the component-serve route into a shared `AssetService` method so both routes use one implementation.

**Tech Stack:** Next.js 16 App Router, better-sqlite3 (direct SQL, no ORM), Zod, `postcss` (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-page-composer-design.md`

## Global Constraints

- Direct SQL only, no ORM — every service method uses `DatabaseConnection.getInstance().prepare(...)`.
- No wrapper classes, DTOs, factories, repository patterns, or custom error classes (AGENTS.md).
- Pages have **no ownership restriction** — matches Presets and jobs/assets, not Style Bibles' owner-only-edit model.
- `component_asset_ids` is a JSON-serialized string column, matching `styles.parameters`/`presets.components`'s established convention.
- A page has **no stored file** — the combined document is computed on every request to the render route, the same way a component's own preview is already recomposed on every request rather than baked.
- Every mutating API route requires `getCurrentUser(req)`, 401 if null. Every GET route (list, get-one, render) is unauthenticated, matching every sibling route in this app.
- A stale/invalid entry in `component_asset_ids` (soft-deleted, wrong kind, nonexistent) must be skipped and logged, never fail the whole render.
- Disable buttons on submission (existing convention).

---

### Task 1: Migration + schema

**Files:**
- Create: `lib/database/migrations/013_add_pages.sql`
- Modify: `lib/database/schema.ts`
- Test: `test/pageSchema.test.ts`

**Interfaces:**
- Produces: `PageSchema`, `Page` type — every later task imports these from `@/lib/database/schema`.

- [ ] **Step 1: Write the migration**

Create `lib/database/migrations/013_add_pages.sql`:

```sql
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  component_asset_ids TEXT NOT NULL DEFAULT '[]',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Add the Zod schema**

In `lib/database/schema.ts`, after `PresetSchema`/`Preset` (end of file), add:

```ts
export const PageSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  component_asset_ids: z.string(), // JSON-serialized string[]
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Page = z.infer<typeof PageSchema>;
```

- [ ] **Step 3: Write a test proving the migration applies cleanly and the schema round-trips**

Create `test/pageSchema.test.ts`:

```ts
// test/pageSchema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { PageSchema } from '@/lib/database/schema';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pageschema-'));
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

describe('pages table + PageSchema', () => {
  it('accepts a full row with an ordered component_asset_ids array', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO pages (id, style_id, name, created_by, component_asset_ids, is_deleted, created_at, updated_at)
      VALUES (?, ?, 'Landing Page', 'user-1', '["c1","c2"]', 0, ?, ?)
    `).run('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', now, now);

    const row = db.prepare('SELECT * FROM pages WHERE id = ?').get('11111111-1111-1111-1111-111111111111');
    const parsed = PageSchema.parse(row);
    expect(JSON.parse(parsed.component_asset_ids)).toEqual(['c1', 'c2']);
  });

  it('defaults component_asset_ids to an empty-array JSON when omitted', () => {
    const db = DatabaseConnection.getInstance();
    const now = Date.now();
    db.prepare(`
      INSERT INTO pages (id, style_id, name, created_by, is_deleted, created_at, updated_at)
      VALUES (?, ?, 'Bare', 'user-1', 0, ?, ?)
    `).run('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', now, now);

    const row = db.prepare('SELECT * FROM pages WHERE id = ?').get('33333333-3333-3333-3333-333333333333');
    const parsed = PageSchema.parse(row);
    expect(JSON.parse(parsed.component_asset_ids)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pageSchema.test.ts`
Expected: 2 tests pass, migration `013_add_pages.sql` logs as applied.

- [ ] **Step 5: Commit**

```bash
git add lib/database/migrations/013_add_pages.sql lib/database/schema.ts test/pageSchema.test.ts
git commit -m "feat: add pages table and PageSchema"
```

---

### Task 2: PageService CRUD

**Files:**
- Create: `lib/services/PageService.ts`
- Test: `test/pageService.test.ts`

**Interfaces:**
- Consumes: `PageSchema`, `Page` from Task 1.
- Produces: `pageService` singleton with `getActivePagesForStyle(styleId)`, `getById(id)`, `create(input)`, `update(id, patch)`, `softDelete(id)` — later tasks import `pageService` from `@/lib/services/PageService`.

- [ ] **Step 1: Write the failing tests**

Create `test/pageService.test.ts`:

```ts
// test/pageService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pageservice-'));
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

describe('PageService', () => {
  it('creates a page (empty component list) and reads it back', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Landing Page', createdBy: 'user-1' });
    expect(page.name).toBe('Landing Page');
    expect(JSON.parse(page.component_asset_ids)).toEqual([]);
    expect(page.is_deleted).toBe(0);

    const fetched = await pageService.getById(page.id);
    expect(fetched?.id).toBe(page.id);
  });

  it('getActivePagesForStyle scopes to one style and excludes soft-deleted pages, newest first', async () => {
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });
    const first = await pageService.create({ styleId: styleA.id, name: 'First', createdBy: 'user-1' });
    const second = await pageService.create({ styleId: styleA.id, name: 'Second', createdBy: 'user-1' });
    await pageService.create({ styleId: styleB.id, name: 'Other style', createdBy: 'user-1' });
    await pageService.softDelete(first.id);

    const active = await pageService.getActivePagesForStyle(styleA.id);
    expect(active.map(p => p.id)).toEqual([second.id]);
  });

  it('update() sets name and component_asset_ids, with no ownership check', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Original', createdBy: 'user-1' });
    const updated = await pageService.update(page.id, {
      name: 'Renamed by someone else',
      componentAssetIds: JSON.stringify(['c1', 'c2', 'c3']),
    });
    expect(updated?.name).toBe('Renamed by someone else');
    expect(JSON.parse(updated!.component_asset_ids)).toEqual(['c1', 'c2', 'c3']);
  });

  it('update() with only a name patch leaves component_asset_ids untouched', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify(['c1']) });
    const updated = await pageService.update(page.id, { name: 'Renamed' });
    expect(JSON.parse(updated!.component_asset_ids)).toEqual(['c1']);
  });

  it('update() returns null for a nonexistent page', async () => {
    const result = await pageService.update('00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(result).toBeNull();
  });

  it('softDelete() flips is_deleted to 1', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.softDelete(page.id);
    const fetched = await pageService.getById(page.id);
    expect(fetched?.is_deleted).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pageService.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/PageService'`

- [ ] **Step 3: Write PageService.ts**

Create `lib/services/PageService.ts`:

```ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { PageSchema, type Page } from '@/lib/database/schema';

class PageServiceImpl {
  /** Active pages belonging to one Style Bible, newest first. */
  async getActivePagesForStyle(styleId: string): Promise<Page[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM pages WHERE style_id = ? AND is_deleted = 0 ORDER BY created_at DESC'
    ).all(styleId);
    return rows.map(row => PageSchema.parse(row));
  }

  async getById(id: string): Promise<Page | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
    return row ? PageSchema.parse(row) : null;
  }

  async create(input: { styleId: string; name: string; createdBy: string }): Promise<Page> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO pages (id, style_id, name, created_by, component_asset_ids, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', 0, ?, ?)
    `).run(id, input.styleId, input.name, input.createdBy, now, now);
    return (await this.getById(id))!;
  }

  /** No ownership check - pages are shared, any logged-in user may edit any page. */
  async update(id: string, patch: {
    name?: string;
    componentAssetIds?: string;
  }): Promise<Page | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE pages SET name = ?, component_asset_ids = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.componentAssetIds ?? existing.component_asset_ids,
      Date.now(),
      id
    );
    return this.getById(id);
  }

  async softDelete(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE pages SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

export const pageService = new PageServiceImpl();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pageService.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/PageService.ts test/pageService.test.ts
git commit -m "feat: add PageService CRUD"
```

---

### Task 3: Extract loadThemeCssForStyle into AssetService

**Files:**
- Modify: `lib/services/AssetService.ts`
- Modify: `app/api/components/[filename]/route.ts`
- Test: `test/componentFileRoute.test.ts` (existing — must pass UNCHANGED, proving this is behavior-preserving), plus new direct tests in a new file `test/assetServiceThemeCss.test.ts`

**Interfaces:**
- Produces: `assetService.loadThemeCssForStyle(styleId: string | null): Promise<string | null>` — Task 7 (the render route) calls this directly.

- [ ] **Step 1: Read the current implementation**

Read `app/api/components/[filename]/route.ts` in full. It currently has an unexported function:

```ts
async function loadThemeCssForStyle(styleId: string | null): Promise<string | null> {
  if (!styleId) return null;
  try {
    const themes = await assetService.getActiveThemeAssetsForStyle(styleId);
    if (themes.length === 0) return null;
    const themeFilename = themes[0].image_path;
    if (!themeFilename || themeFilename.includes('/') || themeFilename.includes('\\') || themeFilename.includes('..')) {
      return null;
    }
    const themePath = path.join(getProjectRoot(), 'storage', 'themes', themeFilename);
    const rawCss = await fsPromises.readFile(themePath, 'utf-8');
    return sanitizeComponentCss(rawCss);
  } catch (e) {
    console.error(`Could not load theme CSS for style ${styleId}:`, e);
    return null;
  }
}
```

Also read `test/componentFileRoute.test.ts` in full — 9 existing tests, 5 of which exercise this exact function's behavior indirectly through the route (theme injection, missing theme, no styleId, path-traversal theme filename, hostile theme CSS). **These 9 tests are your proof this extraction changed nothing — do not modify this test file in this task. If any of these 9 tests fail after your change, the extraction broke something; fix your extraction, not the test.**

- [ ] **Step 2: Move the function into AssetService.ts as an exported method**

In `lib/services/AssetService.ts`, add the necessary imports at the top (`fsPromises` is already imported; add `path` if not already present — check first) and add this method to `AssetServiceImpl`, placed near `getActiveThemeAssetsForStyle`:

```ts
  /**
   * A style's most-recently-promoted theme's CSS, re-sanitized through the
   * same boundary component CSS goes through. Theme CSS is validated by a
   * completely separate pipeline (ThemeTokensSchema) at generation/edit
   * time only, never re-checked at serve time the way component files now
   * are - reusing sanitizeComponentCss here closes that gap. Returns null
   * (no theme available) for any reason the theme can't be used: no
   * styleId, no promoted theme, unreadable file, or failed sanitization.
   * Shared by the component-serve route and the page-render route.
   */
  async loadThemeCssForStyle(styleId: string | null): Promise<string | null> {
    if (!styleId) return null;
    try {
      const themes = await this.getActiveThemeAssetsForStyle(styleId);
      if (themes.length === 0) return null;
      const themeFilename = themes[0].image_path;
      if (!themeFilename || themeFilename.includes('/') || themeFilename.includes('\\') || themeFilename.includes('..')) {
        return null;
      }
      const themePath = path.join(getProjectRoot(), 'storage', 'themes', themeFilename);
      const rawCss = await fsPromises.readFile(themePath, 'utf-8');
      return sanitizeComponentCss(rawCss);
    } catch (e) {
      console.error(`Could not load theme CSS for style ${styleId}:`, e);
      return null;
    }
  }
```

Add `import { sanitizeComponentCss } from '@/lib/services/componentSanitize';` to `AssetService.ts`'s imports.

- [ ] **Step 3: Update the component-serve route to call the extracted method**

In `app/api/components/[filename]/route.ts`, delete the local `loadThemeCssForStyle` function entirely, and change the call site from:

```ts
const themeCss = await loadThemeCssForStyle(styleId);
```

to:

```ts
const themeCss = await assetService.loadThemeCssForStyle(styleId);
```

`assetService` is already imported in this file (it's used elsewhere). Remove any imports that are now unused in this file as a result of deleting the local function (check `path`, `fsPromises`, `getProjectRoot`, `sanitizeComponentCss` — some may still be needed for the route's OWN remaining logic, e.g. reading the component file itself; only remove what's genuinely unused after the deletion).

- [ ] **Step 4: Run the existing tests to prove nothing changed**

Run: `npx vitest run test/componentFileRoute.test.ts`
Expected: all 9 tests pass, unmodified.

- [ ] **Step 5: Add direct tests against the extracted method itself**

Create `test/assetServiceThemeCss.test.ts`:

```ts
// test/assetServiceThemeCss.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themecss-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
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

describe('assetService.loadThemeCssForStyle', () => {
  it('returns null for a null styleId', async () => {
    expect(await assetService.loadThemeCssForStyle(null)).toBeNull();
  });

  it('returns null when the style has no promoted theme', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    expect(await assetService.loadThemeCssForStyle(style.id)).toBeNull();
  });

  it('returns the sanitized CSS of the most recently promoted theme', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const filename = 'theme.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), ':root { --color-accent: #ff6600; }');
    await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: filename, outputKind: 'theme',
    });
    const css = await assetService.loadThemeCssForStyle(style.id);
    expect(css).toContain('--color-accent: #ff6600');
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/assetServiceThemeCss.test.ts test/componentFileRoute.test.ts`
Expected: 3 new tests pass, all 9 existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add lib/services/AssetService.ts "app/api/components/[filename]/route.ts" test/assetServiceThemeCss.test.ts
git commit -m "refactor: extract loadThemeCssForStyle into AssetService"
```

---

### Task 4: composePageHtml

**Files:**
- Create: `lib/services/pageDocument.ts`
- Test: `test/pageDocument.test.ts`

**Interfaces:**
- Produces: `composePageHtml(items: {html: string; css: string}[], themeCss?: string): string` — Task 7 (the render route) calls this directly.

- [ ] **Step 1: Write the failing tests**

Create `test/pageDocument.test.ts`:

```ts
// test/pageDocument.test.ts
import { describe, it, expect } from 'vitest';
import { composePageHtml } from '@/lib/services/pageDocument';

describe('composePageHtml', () => {
  it('wraps each component in a uniquely-scoped container, in order', () => {
    const html = composePageHtml([
      { html: '<button class="btn">A</button>', css: '.btn { color: red; }' },
      { html: '<button class="btn">B</button>', css: '.btn { color: blue; }' },
    ]);
    // Both components' HTML present, in order.
    const indexA = html.indexOf('>A<');
    const indexB = html.indexOf('>B<');
    expect(indexA).toBeGreaterThan(-1);
    expect(indexB).toBeGreaterThan(indexA);
  });

  it('scopes identically-named classes so they do not collide', () => {
    const html = composePageHtml([
      { html: '<div class="title">A</div>', css: '.title { color: red; }' },
      { html: '<div class="title">B</div>', css: '.title { color: blue; }' },
    ]);
    // The two ".title" rules must be scoped under DIFFERENT prefixes -
    // extract every "<prefix> .title" occurrence and confirm there are two
    // distinct prefixes, not one shared rule applying to both.
    const matches = [...html.matchAll(/(\.page-item-\d+)\s+\.title/g)].map(m => m[1]);
    expect(new Set(matches).size).toBe(2);
  });

  it('neutralizes a broad selector (body) by scoping it under the wrapper, where no real <body> exists', () => {
    const html = composePageHtml([
      { html: '<p>hi</p>', css: 'body { margin: 0; }' },
    ]);
    expect(html).not.toMatch(/^\s*body\s*\{/m); // never appears unscoped
    expect(html).toContain('body { margin: 0; }'); // still present, but scoped
    expect(html).toMatch(/\.page-item-0\s+body/);
  });

  it('injects theme CSS exactly once regardless of component count', () => {
    const themeCss = ':root { --color-accent: #ff6600; }';
    const html = composePageHtml([
      { html: '<p>A</p>', css: '.a {}' },
      { html: '<p>B</p>', css: '.b {}' },
      { html: '<p>C</p>', css: '.c {}' },
    ], themeCss);
    const occurrences = html.split('--color-accent: #ff6600').length - 1;
    expect(occurrences).toBe(1);
  });

  it('omits theme CSS entirely when none is given', () => {
    const html = composePageHtml([{ html: '<p>hi</p>', css: '.a {}' }]);
    expect(html).not.toContain(':root');
  });

  it('leaves var(...) references inside declaration values untouched by scoping', () => {
    const html = composePageHtml([
      { html: '<button class="btn">Go</button>', css: '.btn { background: var(--color-accent); padding: calc(var(--space-unit) * 2); }' },
    ]);
    expect(html).toContain('background: var(--color-accent)');
    expect(html).toContain('padding: calc(var(--space-unit) * 2)');
  });

  it('produces a valid standalone HTML document with one <style> and one <body>', () => {
    const html = composePageHtml([{ html: '<p>hi</p>', css: '.a { color: red; }' }]);
    expect(html).toContain('<!DOCTYPE html>');
    expect((html.match(/<style>/g) ?? []).length).toBe(1);
    expect((html.match(/<body>/g) ?? []).length).toBe(1);
  });

  it('returns a minimal empty document for zero components', () => {
    const html = composePageHtml([]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<body>');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pageDocument.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/pageDocument'`

- [ ] **Step 3: Write pageDocument.ts**

Create `lib/services/pageDocument.ts`:

```ts
// lib/services/pageDocument.ts
//
// Pure compose logic for a Page: takes already-parsed component
// {html, css} tokens in order plus an optional theme CSS string, and
// produces one standalone HTML document. Kept separate from PageService.ts
// (which owns the DB row and file reads) the same way componentDocument.ts
// is kept separate from ComponentGenerator.ts - one file, one
// responsibility, independently testable with no DB/fs setup needed.

import postcss from 'postcss';

export interface PageComponentTokens {
  html: string;
  css: string;
}

function scopeComponentCss(css: string, scopeClass: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selector = rule.selectors.map(s => `.${scopeClass} ${s}`).join(', ');
  });
  return root.toString();
}

export function composePageHtml(items: PageComponentTokens[], themeCss?: string): string {
  const styleBlocks: string[] = [];
  const bodyBlocks: string[] = [];

  items.forEach((item, i) => {
    const scopeClass = `page-item-${i}`;
    styleBlocks.push(scopeComponentCss(item.css, scopeClass));
    bodyBlocks.push(`<div class="${scopeClass}">\n${item.html}\n</div>`);
  });

  const themeBlock = themeCss ? `<style>\n${themeCss}\n</style>\n` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${themeBlock}<style>
${styleBlocks.join('\n')}
</style>
</head>
<body>
${bodyBlocks.join('\n')}
</body>
</html>
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pageDocument.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/pageDocument.ts test/pageDocument.test.ts
git commit -m "feat: add composePageHtml with per-component CSS scoping"
```

---

### Task 5: Page CRUD API routes

**Files:**
- Modify: `app/api/styles/[id]/pages/route.ts` (new file — this path doesn't currently exist as a route, only `app/api/styles/[id]/assets/route.ts` does)
- Create: `app/api/pages/[id]/route.ts`
- Test: `test/pagesRoute.test.ts`

**Interfaces:**
- Consumes: `pageService` (Task 2), `getCurrentUser` (`lib/utils/session.ts`, existing).
- Produces: `GET/POST /api/styles/[id]/pages`, `GET/PUT/DELETE /api/pages/[id]` — Task 9 (the frontend) calls these.

- [ ] **Step 1: Write the failing tests**

Create `test/pagesRoute.test.ts`:

```ts
// test/pagesRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { seedSession } from './helpers/testSession';
import { GET as listPages, POST as createPage } from '@/app/api/styles/[id]/pages/route';
import { GET as getPage, PUT as updatePage, DELETE as deletePage } from '@/app/api/pages/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pagesroute-'));
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
  return new NextRequest('http://localhost/api/pages/x', {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('page CRUD routes', () => {
  it('POST /api/styles/[id]/pages requires login', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const res = await createPage(req('POST', { name: 'Landing' }), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('POST then GET list then GET one then PUT then DELETE, full round trip', async () => {
    const { cookieHeader } = await seedSession();
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });

    const createRes = await createPage(req('POST', { name: 'Landing Page' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()).data;
    expect(created.name).toBe('Landing Page');
    expect(JSON.parse(created.component_asset_ids)).toEqual([]);

    const listRes = await listPages(req('GET'), { params: Promise.resolve({ id: style.id }) });
    const list = (await listRes.json()).data;
    expect(list.map((p: any) => p.id)).toEqual([created.id]);

    const getRes = await getPage(req('GET'), { params: Promise.resolve({ id: created.id }) });
    expect((await getRes.json()).data.id).toBe(created.id);

    const putRes = await updatePage(req('PUT', { name: 'Renamed', componentAssetIds: ['c1', 'c2'] }, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    const updated = (await putRes.json()).data;
    expect(updated.name).toBe('Renamed');
    expect(JSON.parse(updated.component_asset_ids)).toEqual(['c1', 'c2']);

    const deleteRes = await deletePage(req('DELETE', undefined, cookieHeader), { params: Promise.resolve({ id: created.id }) });
    expect(deleteRes.status).toBe(200);

    const listAfterDelete = (await (await listPages(req('GET'), { params: Promise.resolve({ id: style.id }) })).json()).data;
    expect(listAfterDelete).toEqual([]);
  });

  it('list only returns pages for the given style', async () => {
    const { cookieHeader } = await seedSession();
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });
    await createPage(req('POST', { name: 'In A' }, cookieHeader), { params: Promise.resolve({ id: styleA.id }) });
    await createPage(req('POST', { name: 'In B' }, cookieHeader), { params: Promise.resolve({ id: styleB.id }) });

    const listRes = await listPages(req('GET'), { params: Promise.resolve({ id: styleA.id }) });
    const list = (await listRes.json()).data;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('In A');
  });

  it('PUT requires login', async () => {
    const { cookieHeader } = await seedSession();
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const createRes = await createPage(req('POST', { name: 'x' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    const created = (await createRes.json()).data;

    const res = await updatePage(req('PUT', { name: 'y' }), { params: Promise.resolve({ id: created.id }) });
    expect(res.status).toBe(401);
  });

  it('GET /api/pages/[id] returns 404 for a nonexistent id', async () => {
    const res = await getPage(req('GET'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pagesRoute.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the routes**

Create `app/api/styles/[id]/pages/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { pageService } from '@/lib/services/PageService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pages = await pageService.getActivePagesForStyle(id);
    return NextResponse.json({ success: true, data: pages });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const CreatePageSchema = z.object({
  name: z.string().min(1),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = CreatePageSchema.parse(await req.json());
    const page = await pageService.create({ styleId: id, name: input.name, createdBy: user.id });
    return NextResponse.json({ success: true, data: page });
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

Create `app/api/pages/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { pageService } from '@/lib/services/PageService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const page = await pageService.getById(id);
    if (!page) return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: page });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const UpdatePageSchema = z.object({
  name: z.string().min(1).optional(),
  componentAssetIds: z.array(z.string()).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = UpdatePageSchema.parse(await req.json());
    const updated = await pageService.update(id, {
      name: input.name,
      componentAssetIds: input.componentAssetIds !== undefined ? JSON.stringify(input.componentAssetIds) : undefined,
    });
    if (!updated) return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
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
    const existing = await pageService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });

    await pageService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pagesRoute.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add "app/api/styles/[id]/pages/route.ts" "app/api/pages/[id]/route.ts" test/pagesRoute.test.ts
git commit -m "feat: add page CRUD API routes"
```

---

### Task 6: Page render/download route

**Files:**
- Create: `app/api/pages/[id]/render/route.ts`
- Test: `test/pageRenderRoute.test.ts`

**Interfaces:**
- Consumes: `pageService.getById` (Task 2), `assetService.loadThemeCssForStyle` (Task 3), `composePageHtml` (Task 4), `parseComponentHtml` (existing, `lib/services/componentDocument.ts`), `assetService.getById` (existing, `lib/services/AssetService.ts`).
- Produces: `GET /api/pages/[id]/render` (and `?download=1` variant) — Task 9 (the frontend) uses this for both the iframe preview `src` and the download link `href`.

- [ ] **Step 1: Write the failing tests**

Create `test/pageRenderRoute.test.ts`:

```ts
// test/pageRenderRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { pageService } from '@/lib/services/PageService';
import { GET } from '@/app/api/pages/[id]/render/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pagerender-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });
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

async function makeComponentAsset(styleId: string, filename: string, document: string, assetType = 'button') {
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), document);
  return assetService.create({
    styleId, createdBy: 'user-1', assetType, prompt: 'x', imagePath: filename, outputKind: 'component',
  });
}

describe('GET /api/pages/[id]/render', () => {
  it('returns 404 for a nonexistent page', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('composes an empty page (no components) into a valid document', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Empty', createdBy: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
  });

  it('composes multiple components in order with scoped, non-colliding CSS, plus the theme', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'theme.css'), ':root { --color-accent: #ff6600; }');
    await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'theme.css', outputKind: 'theme',
    });
    const navAsset = await makeComponentAsset(style.id, 'nav.html',
      '<!DOCTYPE html><html><head><style>.title { color: red; }</style></head><body><nav class="title">Nav</nav></body></html>', 'nav bar');
    const heroAsset = await makeComponentAsset(style.id, 'hero.html',
      '<!DOCTYPE html><html><head><style>.title { color: blue; }</style></head><body><h1 class="title">Hero</h1></body></html>', 'hero');

    const page = await pageService.create({ styleId: style.id, name: 'Landing', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([navAsset.id, heroAsset.id]) });

    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('--color-accent: #ff6600');
    expect(body.indexOf('Nav')).toBeLessThan(body.indexOf('Hero'));
    const scopedTitleMatches = [...body.matchAll(/(\.page-item-\d+)\s+\.title/g)].map(m => m[1]);
    expect(new Set(scopedTitleMatches).size).toBe(2);
  });

  it('skips a stale component reference and still renders the remaining valid ones', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
      const validAsset = await makeComponentAsset(style.id, 'valid.html',
        '<!DOCTYPE html><html><head><style>.a {}</style></head><body><p>Still Here</p></body></html>');
      const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
      await pageService.update(page.id, {
        componentAssetIds: JSON.stringify(['00000000-0000-0000-0000-000000000000', validAsset.id]),
      });

      const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Still Here');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('with ?download=1, sets Content-Disposition to attachment with a slugified filename', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'My Landing Page!', createdBy: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/x?download=1'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="my-landing-page.html"');
  });

  it('without ?download=1, does not set Content-Disposition', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pageRenderRoute.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route**

Create `app/api/pages/[id]/render/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { composePageHtml, type PageComponentTokens } from '@/lib/services/pageDocument';

export const dynamic = 'force-dynamic';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const page = await pageService.getById(id);
  if (!page) {
    return NextResponse.json({ success: false, error: 'Page not found' }, { status: 404 });
  }

  const componentAssetIds = JSON.parse(page.component_asset_ids) as string[];
  const items: PageComponentTokens[] = [];
  for (const assetId of componentAssetIds) {
    try {
      const asset = await assetService.getById(assetId);
      if (!asset || asset.is_deleted || asset.output_kind !== 'component' || !asset.image_path) {
        console.error(`Page ${id} references a stale/invalid component asset ${assetId}, skipping`);
        continue;
      }
      const filename = asset.image_path;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        console.error(`Page ${id} references a component asset ${assetId} with an unsafe filename, skipping`);
        continue;
      }
      const document = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', filename), 'utf-8');
      items.push(parseComponentHtml(document));
    } catch (e) {
      console.error(`Failed to load component asset ${assetId} for page ${id}, skipping:`, e);
    }
  }

  const themeCss = await assetService.loadThemeCssForStyle(page.style_id);
  const html = composePageHtml(items, themeCss ?? undefined);

  const headers: Record<string, string> = {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
  };
  if (req.nextUrl.searchParams.get('download')) {
    const baseName = slugify(page.name) || 'page';
    headers['Content-Disposition'] = `attachment; filename="${baseName}.html"`;
  }

  return new NextResponse(html, { headers });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pageRenderRoute.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add "app/api/pages/[id]/render/route.ts" test/pageRenderRoute.test.ts
git commit -m "feat: add page render/download route"
```

---

### Task 7: PageEditor component

**Files:**
- Create: `app/components/PageEditor.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (takes its data as props).
- Produces: `PageEditor` component, exported `PageEditorProps` — Task 8 (the Hub page section) imports and uses this.

- [ ] **Step 1: Read the pattern to mirror**

Read `app/components/PresetForm.tsx` in full (already read this session — confirm current state) — same standalone-exported-component shape to follow: local `useState`, an `onSubmit` prop returning a `Promise<void>`, a disabled-while-saving submit button.

- [ ] **Step 2: Write PageEditor.tsx**

Create `app/components/PageEditor.tsx`:

```tsx
// app/components/PageEditor.tsx
'use client';

import { useState } from 'react';
import type { Asset } from '@/lib/database/schema';

export interface PageEditorProps {
  availableComponents: Asset[]; // active 'component' assets for this Style Bible, already fetched by the caller
  initialName?: string;
  initialComponentAssetIds?: string[];
  onSubmit: (value: { name: string; componentAssetIds: string[] }) => Promise<void>;
  submitLabel: string;
  downloadHref?: string; // only passed once the page has a real id (editing, not creating)
}

export function PageEditor({
  availableComponents,
  initialName,
  initialComponentAssetIds,
  onSubmit,
  submitLabel,
  downloadHref,
}: PageEditorProps) {
  const [name, setName] = useState(initialName ?? '');
  const [componentAssetIds, setComponentAssetIds] = useState<string[]>(initialComponentAssetIds ?? []);
  const [saving, setSaving] = useState(false);

  function toggleComponent(assetId: string) {
    setComponentAssetIds(ids =>
      ids.includes(assetId) ? ids.filter(id => id !== assetId) : [...ids, assetId]
    );
  }

  function moveUp(index: number) {
    if (index === 0) return;
    setComponentAssetIds(ids => {
      const next = [...ids];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  function moveDown(index: number) {
    setComponentAssetIds(ids => {
      if (index === ids.length - 1) return ids;
      const next = [...ids];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), componentAssetIds });
    } finally {
      setSaving(false);
    }
  }

  const componentsById = new Map(availableComponents.map(a => [a.id, a]));

  return (
    <form className="card" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
      <div className="field">
        <label htmlFor="page-name">Name</label>
        <input id="page-name" value={name} onChange={e => setName(e.target.value)} />
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Page order</div>
        {componentAssetIds.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>No components added yet.</p>
        ) : (
          componentAssetIds.map((assetId, i) => {
            const asset = componentsById.get(assetId);
            return (
              <div key={assetId} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span className="badge">{asset?.asset_type ?? 'unknown'}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{asset?.prompt ?? assetId}</span>
                <button type="button" className="btn" onClick={() => moveUp(i)} disabled={i === 0}>↑</button>
                <button type="button" className="btn" onClick={() => moveDown(i)} disabled={i === componentAssetIds.length - 1}>↓</button>
                <button type="button" className="btn" onClick={() => toggleComponent(assetId)}>Remove</button>
              </div>
            );
          })
        )}
      </div>

      <div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Available components</div>
        {availableComponents.filter(a => !componentAssetIds.includes(a.id)).length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>All components already added, or none exist yet.</p>
        ) : (
          availableComponents.filter(a => !componentAssetIds.includes(a.id)).map(asset => (
            <div key={asset.id} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <span className="badge">{asset.asset_type}</span>
              <span style={{ flex: 1, fontSize: 13 }}>{asset.prompt}</span>
              <button type="button" className="btn" onClick={() => toggleComponent(asset.id)}>Add</button>
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        {downloadHref && (
          <a className="btn" href={downloadHref} download>
            Download HTML
          </a>
        )}
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Manually verify**

No dedicated test file — matches this codebase's established convention of zero `.test.tsx` files. Confirm via `npx tsc --noEmit` that the file compiles, and exercise it fully in Task 10's manual browser walkthrough.

- [ ] **Step 4: Commit**

```bash
git add app/components/PageEditor.tsx
git commit -m "feat: add PageEditor component"
```

---

### Task 8: Pages section on the Style Bible Hub page

**Files:**
- Modify: `app/dashboard/styles/[id]/page.tsx`

**Interfaces:**
- Consumes: `PageEditor` (Task 7), `GET/POST /api/styles/[id]/pages`, `GET/PUT/DELETE /api/pages/[id]` (Task 5), `GET /api/pages/[id]/render` (Task 6).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Read the current file in full**

Read `app/dashboard/styles/[id]/page.tsx`'s CURRENT state directly before editing — it has been modified multiple times this session (Style Bible Hub shipped in PR #14, a confirm-dialog fix, a Copilot fetch-error-handling fix, and the Save-as-preset addition from the Presets feature). Confirm exact current line numbers and state before making changes; do not assume the line numbers in this brief are exact.

- [ ] **Step 2: Add state for pages**

Add near the existing `assets`/`loading` state:

```ts
  const [pages, setPages] = useState<Page[]>([]);
  const [creatingPage, setCreatingPage] = useState(false);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
```

Add the import: `import type { Asset, Style, OutputKind, Page } from '@/lib/database/schema';` (extend the existing type import line — check its current exact content first) and `import { PageEditor } from '@/app/components/PageEditor';`.

- [ ] **Step 3: Fetch pages alongside the existing style/assets fetch**

In the existing mount `useEffect`, extend the `Promise.all` to also fetch pages, and handle the third response alongside the existing two:

```ts
        const [styleRes, assetsRes, pagesRes] = await Promise.all([
          fetch(`/api/styles/${id}`),
          fetch(`/api/styles/${id}/assets`),
          fetch(`/api/styles/${id}/pages`),
        ]);
        const styleBody = await styleRes.json();
        const assetsBody = await assetsRes.json();
        const pagesBody = await pagesRes.json();
        if (ignore) return;
        if (styleBody.success) {
          setStyle(styleBody.data);
          setNameDraft(styleBody.data.name);
        }
        if (assetsBody.success) setAssets(assetsBody.data);
        if (pagesBody.success) setPages(pagesBody.data);
```

(Adapt to the exact current shape of this effect — the three-fetch pattern replaces the existing two-fetch `Promise.all`, keeping the same try/catch/finally wrapper already in place.)

- [ ] **Step 4: Add handlers**

```ts
  async function refreshPages() {
    const res = await fetch(`/api/styles/${id}/pages`);
    const body = await res.json();
    if (body.success) setPages(body.data);
  }

  async function handleCreatePage(value: { name: string; componentAssetIds: string[] }) {
    setPageError(null);
    try {
      const res = await fetch(`/api/styles/${id}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name }),
      });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not create page.');
        return;
      }
      // Component order is set in a second call, since POST only accepts a name.
      if (value.componentAssetIds.length > 0) {
        await fetch(`/api/pages/${body.data.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ componentAssetIds: value.componentAssetIds }),
        });
      }
      setCreatingPage(false);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }

  async function handleUpdatePage(pageId: string, value: { name: string; componentAssetIds: string[] }) {
    setPageError(null);
    try {
      const res = await fetch(`/api/pages/${pageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name, componentAssetIds: value.componentAssetIds }),
      });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not save page.');
        return;
      }
      setEditingPageId(null);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }

  async function handleDeletePage(pageId: string) {
    setPageError(null);
    try {
      const res = await fetch(`/api/pages/${pageId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not delete page.');
        return;
      }
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }
```

- [ ] **Step 5: Add the "Pages" section to the JSX**

Place this after the existing `{SECTIONS.map(...)}` block (the Themes/Components/Images sections) and before the "Save as preset" card:

```tsx
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Pages</h2>
        {pageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{pageError}</p>}

        {!creatingPage ? (
          <button className="btn" style={{ marginBottom: 16 }} onClick={() => setCreatingPage(true)}>
            New Page
          </button>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <PageEditor
              availableComponents={assets.filter(a => a.output_kind === 'component')}
              onSubmit={handleCreatePage}
              submitLabel="Create Page"
            />
            <button className="btn" style={{ marginTop: 8 }} onClick={() => setCreatingPage(false)}>Cancel</button>
          </div>
        )}

        {pages.length === 0 ? (
          <div className="empty-state">None yet.</div>
        ) : (
          <div className="grid">
            {pages.map(p => {
              if (editingPageId === p.id) {
                return (
                  <div key={p.id} style={{ gridColumn: '1 / -1' }}>
                    <PageEditor
                      availableComponents={assets.filter(a => a.output_kind === 'component')}
                      initialName={p.name}
                      initialComponentAssetIds={JSON.parse(p.component_asset_ids)}
                      onSubmit={value => handleUpdatePage(p.id, value)}
                      submitLabel="Save Changes"
                      downloadHref={`/api/pages/${p.id}/render?download=1`}
                    />
                    <button className="btn" style={{ marginTop: 8 }} onClick={() => setEditingPageId(null)}>Cancel</button>
                  </div>
                );
              }
              return (
                <div key={p.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <iframe
                    src={`/api/pages/${p.id}/render`}
                    title={`Page preview: ${p.name}`}
                    sandbox=""
                    style={{ width: '100%', height: 240, border: 'none', display: 'block' }}
                  />
                  <div style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.name}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={() => setEditingPageId(p.id)}>Edit</button>
                      <button className="btn" onClick={() => handleDeletePage(p.id)}>Delete</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
```

- [ ] **Step 6: Manually verify**

No dedicated test — matches this codebase's convention. Run `npx tsc --noEmit` to confirm the file compiles. Full exercise happens in Task 10's manual browser walkthrough.

- [ ] **Step 7: Commit**

```bash
git add "app/dashboard/styles/[id]/page.tsx"
git commit -m "feat: add Pages section to the Style Bible Hub page"
```

---

### Task 9: Final verification

**Files:** None created or modified — this task only runs checks.

**Interfaces:** None.

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: every test file passes, including all new files from Tasks 1-6, and the 9 pre-existing `test/componentFileRoute.test.ts` tests still pass unmodified (Task 3's regression proof).

- [ ] **Step 3: Grep sweep for anything half-wired**

Run:
```bash
grep -rn "PageEditor" app/ --include='*.tsx'
grep -rn "pageService" lib/ app/ --include='*.ts'
grep -rn "composePageHtml" lib/ app/ --include='*.ts'
grep -n "loadThemeCssForStyle" "app/api/components/[filename]/route.ts"
```
Expected: `PageEditor` used in `app/dashboard/styles/[id]/page.tsx`; `pageService` used in all 3 route files plus its own service file; `composePageHtml` used in the render route and its own file; the last grep returns NOTHING (confirms the local function was fully deleted, not just shadowed).

- [ ] **Step 4: Manual browser verification**

Start the dev server (`npm run dev`), create a test account if needed, create a Style Bible, and generate/insert 2+ promoted component assets for it if none exist (a direct DB insert for verification purposes is fine here, matching this session's established pattern — clean it up afterward). Then: build a page from those 2 components → confirm the live iframe preview shows both, with visually distinct styling if both happen to define the same class name → reorder them with the Up/Down buttons and confirm the preview updates on save → download the HTML file and open it directly in a browser tab to confirm it renders correctly standalone (not just inside GameForge's own iframe) → edit the page's name → delete the page and confirm it disappears from the Hub. Clean up any test accounts/data/files created purely for this verification afterward (matches the established discipline from every prior feature's final task this session) — do not leave throwaway rows in `data.db`.

- [ ] **Step 5: Commit (if Step 4 surfaced any fixes)**

Only if manual verification found something to fix. Otherwise this task ends at Step 4.
