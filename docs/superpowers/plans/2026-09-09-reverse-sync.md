# Reverse-Sync Between Dashboard and Exported/Edited Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let structural changes made to a hand-edited exported project (new pages, reordered/added/removed component references) sync back into GameForge's database automatically, and give code-level edits to an existing component a real path back in via a manual, explicitly-trusted paste-back — closing the "one-way export" dead end.

**Architecture:** A new `gameforge-manifest.json`, written by `SiteExporter` on every export, records page/component identity (real UUIDs, embedded directly in generated `page.tsx` files) and content hashes. A new `ExportSync` service reads that manifest, re-scans the current export directory, and produces a diff; new `preview`/`apply` routes let the dashboard review that diff before writing anything. `SiteExporter` itself gains re-export support (write into an existing directory without clobbering unsynced hand-edits) protected by a crash-safe, heartbeat-based file lock. A new small `PATCH /api/assets/[id]/component` route (mirroring the existing job-level edit route) gives promoted component assets an edit/paste-back path that doesn't exist today.

**Tech Stack:** Next.js 16 App Router, TypeScript, better-sqlite3 (no ORM), Zod, Node's built-in `crypto`/`fs`/`fs/promises`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-reverse-sync-design.md`

## Global Constraints

- No new npm dependencies (hashing uses Node's built-in `crypto`; structural detection uses a
  plain regex, not a JSX parser — deliberately, per the spec's scope decision).
- `apply` NEVER trusts a client-supplied diff — it always recomputes fresh, server-side, from
  current on-disk + DB state.
- Sync only ever reconciles pages/components GameForge already knows about (via the manifest). A
  brand-new, unrecognized component is left alone on disk, never imported as a new asset.
- Code-level edits to an existing component are NEVER auto-reversed from exported JSX/CSS back to
  HTML — always a manual, explicitly-trusted paste-back through the new asset-component-edit route.
- `try/catch` around all filesystem operations, with `console.error` logging on failure, matching
  every existing service in this codebase (see `AGENTS.md`).
- `fs.mkdir(dir, { recursive: true })` before every new file write, except where an existing
  atomic-mkdir-as-check pattern deliberately uses non-recursive `mkdir` for its EEXIST semantics
  (the export lock, and the existing `targetDir`/`ALREADY_EXISTS` check).
- All physical paths built via `path.join(getProjectRoot(), ...)`.

---

### Task 1: `edited_externally` column on `assets`

**Files:**
- Create: `lib/database/migrations/014_add_edited_externally_to_assets.sql`
- Modify: `lib/database/schema.ts` (add `edited_externally` to `AssetSchema`)
- Modify: `lib/services/AssetService.ts` (`update()` gains an optional `editedExternally` patch field)
- Test: `test/migration-014.test.ts`
- Test: `test/assetEdit.test.ts` (extend with a new case)

**Interfaces:**
- Produces: `Asset.edited_externally: 0 | 1` (via `AssetSchema`), consumed by Task 8's route and
  Task 10's UI.
- Produces: `assetService.update(id, { editedExternally?: boolean, ... })`, consumed by Task 8.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE assets ADD COLUMN edited_externally INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Write the failing migration test**

```typescript
// test/migration-014.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration014-'));
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

describe('migration 014', () => {
  it('adds an edited_externally column to assets, defaulting to 0', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
      VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'user-1', 'button', 'a button', 'x.html', 1000, 0, 'component')
    `).run();
    const row = db.prepare('SELECT edited_externally FROM assets WHERE id = ?').get('11111111-1111-1111-1111-111111111111') as any;
    expect(row.edited_externally).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/migration-014.test.ts`
Expected: FAIL with "no such column: edited_externally" (the migration file doesn't exist yet at
this point in the steps if you're following them in strict order — write the migration file from
Step 1 first, then this test should already pass; if you write the test before the migration file
lands on disk, this is the expected failure to observe).

- [ ] **Step 4: Update `AssetSchema`**

In `lib/database/schema.ts`, add to `AssetSchema`:

```typescript
  edited_externally: z.union([z.literal(0), z.literal(1)]),
```

(placed alongside the existing `is_deleted` field, same shape).

- [ ] **Step 5: Extend `AssetService.update()`**

In `lib/services/AssetService.ts`, change the `update` method to:

```typescript
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

    const nineSliceMargins = patch.nineSliceMargins !== undefined
      ? (patch.nineSliceMargins === null ? null : JSON.stringify(NineSliceMarginsSchema.parse(patch.nineSliceMargins)))
      : existing.nine_slice_margins;
    const states = patch.states !== undefined ? JSON.stringify(patch.states) : existing.states;
    const editedExternally = patch.editedExternally !== undefined ? (patch.editedExternally ? 1 : 0) : existing.edited_externally;

    db.prepare('UPDATE assets SET prompt = ?, asset_type = ?, nine_slice_margins = ?, states = ?, edited_externally = ? WHERE id = ?').run(
      patch.prompt ?? existing.prompt,
      patch.assetType ?? existing.asset_type,
      nineSliceMargins,
      states,
      editedExternally,
      id
    );
    return this.getById(id);
  }
```

- [ ] **Step 6: Run the migration test and the full suite to verify nothing else broke**

Run: `npx vitest run test/migration-014.test.ts`
Expected: PASS

Run: `npx vitest run`
Expected: all pass (adding a `NOT NULL DEFAULT 0` column is backward-compatible with every
existing `INSERT` in the test suite, since SQLite fills the default for omitted columns)

- [ ] **Step 7: Commit**

```bash
git add lib/database/migrations/014_add_edited_externally_to_assets.sql lib/database/schema.ts lib/services/AssetService.ts test/migration-014.test.ts
git commit -m "feat: add edited_externally column to assets"
```

---

### Task 2: `ExportManifest` — manifest types, hashing, read/write

**Files:**
- Create: `lib/services/ExportManifest.ts`
- Test: `test/exportManifest.test.ts`

**Interfaces:**
- Produces: `hashContent(content: string): string`, `ExportManifest`, `ExportManifestPage`,
  `ExportManifestComponent`, `readManifest(exportDir: string): Promise<ExportManifest | null>`,
  `writeManifest(exportDir: string, manifest: ExportManifest): Promise<void>` — consumed by
  Task 3 (write), Task 4 (write/compare), Task 6 (read).

- [ ] **Step 1: Write the failing test**

```typescript
// test/exportManifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { hashContent, readManifest, writeManifest, type ExportManifest } from '@/lib/services/ExportManifest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-manifest-'));
});

afterEach(async () => {
  if (tempDir) await fsPromises.rm(tempDir, { recursive: true, force: true });
});

describe('hashContent', () => {
  it('produces the same hash for the same content and a different hash for different content', () => {
    const a = hashContent('hello');
    const b = hashContent('hello');
    const c = hashContent('world');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('writeManifest / readManifest', () => {
  const MANIFEST: ExportManifest = {
    styleId: '11111111-1111-1111-1111-111111111111',
    exportedAt: 1700000000000,
    pages: [
      { id: '22222222-2222-2222-2222-222222222222', name: 'Home', slug: '', componentAssetIds: ['33333333-3333-3333-3333-333333333333'], pageFileHash: hashContent('page content') },
    ],
    components: [
      { assetId: '33333333-3333-3333-3333-333333333333', componentName: 'HeroA3f9c1', contentHash: hashContent('component content') },
    ],
  };

  it('round-trips a manifest through disk', async () => {
    await writeManifest(tempDir, MANIFEST);
    const readBack = await readManifest(tempDir);
    expect(readBack).toEqual(MANIFEST);
  });

  it('returns null when no manifest file exists', async () => {
    const result = await readManifest(tempDir);
    expect(result).toBeNull();
  });

  it('returns null (not a throw) when the manifest file is present but not valid JSON matching the schema', async () => {
    await fsPromises.writeFile(path.join(tempDir, 'gameforge-manifest.json'), 'not valid json {');
    const result = await readManifest(tempDir);
    expect(result).toBeNull();
  });

  it('returns null when the manifest file is valid JSON but the wrong shape', async () => {
    await fsPromises.writeFile(path.join(tempDir, 'gameforge-manifest.json'), JSON.stringify({ hello: 'world' }));
    const result = await readManifest(tempDir);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/exportManifest.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/ExportManifest'"

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/ExportManifest.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z } from 'zod';

const MANIFEST_FILENAME = 'gameforge-manifest.json';

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

const ExportManifestPageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  componentAssetIds: z.array(z.string().uuid()),
  pageFileHash: z.string(),
});
export type ExportManifestPage = z.infer<typeof ExportManifestPageSchema>;

const ExportManifestComponentSchema = z.object({
  assetId: z.string().uuid(),
  componentName: z.string(),
  contentHash: z.string(),
});
export type ExportManifestComponent = z.infer<typeof ExportManifestComponentSchema>;

const ExportManifestSchema = z.object({
  styleId: z.string().uuid(),
  exportedAt: z.number(),
  pages: z.array(ExportManifestPageSchema),
  components: z.array(ExportManifestComponentSchema),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;

/** Reads the manifest from an export directory. Returns null (never throws) for a missing file, unreadable file, invalid JSON, or a shape that doesn't match — every case means "treat as if there's no manifest," never a crash. */
export async function readManifest(exportDir: string): Promise<ExportManifest | null> {
  try {
    const raw = await fsPromises.readFile(path.join(exportDir, MANIFEST_FILENAME), 'utf-8');
    const parsed = ExportManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.error(`Failed to read export manifest in ${exportDir}:`, e);
    }
    return null;
  }
}

export async function writeManifest(exportDir: string, manifest: ExportManifest): Promise<void> {
  try {
    await fsPromises.mkdir(exportDir, { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error(`Failed to write export manifest to ${exportDir}:`, e);
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/exportManifest.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/ExportManifest.ts test/exportManifest.test.ts
git commit -m "feat: add ExportManifest read/write for site exports"
```

---

### Task 3: Embed page-id comments and write the manifest on export

**Files:**
- Modify: `lib/services/SiteExporter.ts` (`buildPageFile`, `exportSite`)
- Test: `test/siteExporter.test.ts` (extend)

**Interfaces:**
- Consumes: `hashContent`, `writeManifest`, `type ExportManifest` from
  `@/lib/services/ExportManifest` (Task 2).
- Produces: every exported `page.tsx` now starts with `// gameforge-page-id: <uuid>`; every export
  now writes `gameforge-manifest.json` — consumed by Task 4 (re-export comparison) and Task 6
  (`ExportSync` reading it).

- [ ] **Step 1: Write the failing test**

Add to `test/siteExporter.test.ts` (same file, same `describe` block, using the file's existing
`makeComponentAsset`/`makeThemeAsset` helpers and `tempRoot` setup already in that file):

```typescript
  it('embeds a page-id comment in every exported page.tsx and writes a manifest', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const result = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in result) throw new Error(`Unexpected export error: ${result.error}`);

    const pageFile = await fsPromises.readFile(path.join(result.targetDir, 'app', 'page.tsx'), 'utf-8');
    expect(pageFile).toContain(`// gameforge-page-id: ${page.id}`);

    const manifestRaw = await fsPromises.readFile(path.join(result.targetDir, 'gameforge-manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.styleId).toBe(style.id);
    expect(manifest.pages).toHaveLength(1);
    expect(manifest.pages[0].id).toBe(page.id);
    expect(manifest.pages[0].componentAssetIds).toEqual([asset.id]);
    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0].assetId).toBe(asset.id);
    expect(typeof manifest.components[0].contentHash).toBe('string');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/siteExporter.test.ts`
Expected: FAIL — no `// gameforge-page-id:` comment in the page file, no manifest file written.

- [ ] **Step 3: Implement — embed the page-id comment**

In `lib/services/SiteExporter.ts`, modify `buildPageFile` to prepend the comment:

```typescript
  private buildPageFile(page: Page, componentNames: string[], allComponents: ConvertedComponent[]): string {
    const usedComponents = allComponents.filter(c => componentNames.includes(c.componentName));
    const imports = usedComponents.map(c => `import { ${c.componentName} } from '@/components/${c.componentName}';`).join('\n');
    const elements = componentNames.map(name => `      <${name} />`).join('\n');
    return `// gameforge-page-id: ${page.id}
${imports}

export default function Page() {
  return (
    <>
${elements}
    </>
  );
}
`;
  }
```

- [ ] **Step 4: Implement — write the manifest**

Add the import at the top of `lib/services/SiteExporter.ts`:

```typescript
import { hashContent, writeManifest, type ExportManifest } from '@/lib/services/ExportManifest';
```

In `exportSite`, after the existing write loop finishes successfully (right before the final
`return { pagesExported: ... }` statement), build and write the manifest. Since `buildPageFile`'s
output is already computed and written per-page inside the existing loop, compute each page's
file content and hash it there too. Restructure the page-writing loop (the one starting
`await fsPromises.writeFile(path.join(targetDir, 'app', 'page.tsx'), this.buildPageFile(pages[0], ...))`
and the `for (let i = 1; ...)` loop after it) to capture each page's built content in a local array
alongside writing it, so the manifest can be built from those already-computed strings without
re-deriving them:

```typescript
      const manifestPages: ExportManifest['pages'] = [];

      const slugs = this.buildPageSlugs(pages);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'layout.tsx'), this.buildLayoutFile(pages, slugs));

      const homePageFile = this.buildPageFile(pages[0], pageComponentNames[0], components);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'page.tsx'), homePageFile);
      manifestPages.push({
        id: pages[0].id,
        name: pages[0].name,
        slug: slugs[0],
        componentAssetIds: JSON.parse(pages[0].component_asset_ids),
        pageFileHash: hashContent(homePageFile),
      });

      for (let i = 1; i < pages.length; i++) {
        const pageDir = path.join(targetDir, 'app', slugs[i]);
        await fsPromises.mkdir(pageDir, { recursive: true });
        const pageFile = this.buildPageFile(pages[i], pageComponentNames[i], components);
        await fsPromises.writeFile(path.join(pageDir, 'page.tsx'), pageFile);
        manifestPages.push({
          id: pages[i].id,
          name: pages[i].name,
          slug: slugs[i],
          componentAssetIds: JSON.parse(pages[i].component_asset_ids),
          pageFileHash: hashContent(pageFile),
        });
      }

      await fsPromises.writeFile(path.join(targetDir, 'package.json'), this.buildPackageJson());
      await fsPromises.writeFile(path.join(targetDir, 'tsconfig.json'), this.buildTsConfig());
      await fsPromises.writeFile(path.join(targetDir, 'postcss.config.mjs'), this.buildPostcssConfig());

      const manifest: ExportManifest = {
        styleId,
        exportedAt: Date.now(),
        pages: manifestPages,
        components: components.map(c => ({
          assetId: c.asset.id,
          componentName: c.componentName,
          contentHash: hashContent(this.buildComponentFile(c) + '\n' + c.css),
        })),
      };
      await writeManifest(targetDir, manifest);
```

This replaces the existing (pre-Task-3) lines that wrote `app/layout.tsx`, `app/page.tsx`, and the
per-page loop — remove the old versions of those lines when making this change, they're superseded
by the block above (which does the same writes plus manifest bookkeeping).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/siteExporter.test.ts`
Expected: PASS (all existing SiteExporter tests plus the new one)

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all pass (this task only adds a comment line and a new file; no existing generated file
content changed).

- [ ] **Step 7: Commit**

```bash
git add lib/services/SiteExporter.ts test/siteExporter.test.ts
git commit -m "feat: embed page-id comments and write export manifest on export"
```

---

### Task 4: Re-export into an existing directory without clobbering unsynced hand-edits

**Files:**
- Modify: `lib/services/SiteExporter.ts` (`exportSite`)
- Test: `test/siteExporter.test.ts` (extend)

**Interfaces:**
- Consumes: `readManifest` from `@/lib/services/ExportManifest` (Task 2).
- Produces: `SiteExportResult` gains `skippedComponents: string[]` (component names skipped
  because their on-disk file diverged from the manifest since last export/sync) and
  `skippedPages: string[]` (page IDs skipped for the same reason — a hand-edited `page.tsx` is
  never silently overwritten either, mirroring the component protection exactly) — neither is
  consumed by any later task in this plan directly, but both are the export result's new
  observable contract; test them directly.
- Produces: `exportSite()` no longer refuses `ALREADY_EXISTS` when the existing directory's
  manifest matches the requested `styleId` — it re-exports into it instead.

- [ ] **Step 1: Write the failing tests**

Add to `test/siteExporter.test.ts`:

```typescript
  it('re-exports into an existing directory when its manifest matches the same style', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const first = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    const second = await siteExporter.exportSite(style.id, 'my-site');
    expect('error' in second).toBe(false);
  });

  it('still refuses ALREADY_EXISTS when the existing directory has no GameForge manifest', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });

    const exportsDir = path.join(tempRoot, 'storage', 'exports', 'not-gameforges');
    await fsPromises.mkdir(exportsDir, { recursive: true });
    await fsPromises.writeFile(path.join(exportsDir, 'readme.txt'), 'someone else\'s directory');

    const result = await siteExporter.exportSite(style.id, 'not-gameforges');
    expect(result).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('still refuses ALREADY_EXISTS when the existing directory\'s manifest belongs to a different style', async () => {
    const styleA = await styleService.create({ name: 'a', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'b', createdBy: 'user-1', parameters: '{}' });
    await makeComponentAsset(styleA.id, 'a.html', COMPONENT_DOC);
    await makeComponentAsset(styleB.id, 'b.html', COMPONENT_DOC);
    await pageService.create({ styleId: styleA.id, name: 'Home', createdBy: 'user-1' });
    await pageService.create({ styleId: styleB.id, name: 'Home', createdBy: 'user-1' });

    const first = await siteExporter.exportSite(styleA.id, 'shared-name');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    const second = await siteExporter.exportSite(styleB.id, 'shared-name');
    expect(second).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('skips overwriting a component file that was hand-edited since the last export, and reports it', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const first = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    // Simulate a hand-edit: find the component's .tsx file and change it.
    const componentsDir = path.join(first.targetDir, 'components');
    const [componentFile] = (await fsPromises.readdir(componentsDir)).filter(f => f.endsWith('.tsx'));
    const componentPath = path.join(componentsDir, componentFile);
    const original = await fsPromises.readFile(componentPath, 'utf-8');
    await fsPromises.writeFile(componentPath, original + '\n// hand-edited\n');

    const second = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in second) throw new Error(`Unexpected export error: ${second.error}`);
    expect(second.skippedComponents).toHaveLength(1);

    const afterReExport = await fsPromises.readFile(componentPath, 'utf-8');
    expect(afterReExport).toContain('// hand-edited');
  });

  it('skips overwriting a page.tsx that was hand-edited since the last export, and reports it', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'comp.html', COMPONENT_DOC);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([asset.id]) });

    const first = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in first) throw new Error(`Unexpected export error: ${first.error}`);

    // Simulate a hand-edit to the page file itself (e.g. a manually reordered
    // component tag or added JSX), not just to a component.
    const pageFilePath = path.join(first.targetDir, 'app', 'page.tsx');
    const original = await fsPromises.readFile(pageFilePath, 'utf-8');
    await fsPromises.writeFile(pageFilePath, original + '\n{/* hand-edited */}\n');

    const second = await siteExporter.exportSite(style.id, 'my-site');
    if ('error' in second) throw new Error(`Unexpected export error: ${second.error}`);
    expect(second.skippedPages).toEqual([page.id]);

    const afterReExport = await fsPromises.readFile(pageFilePath, 'utf-8');
    expect(afterReExport).toContain('hand-edited');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/siteExporter.test.ts`
Expected: FAIL — the first two new tests fail because re-export currently always returns
`ALREADY_EXISTS`; the two skip tests fail because `skippedComponents`/`skippedPages` don't exist
yet.

- [ ] **Step 3: Implement**

In `lib/services/SiteExporter.ts`, add the import:

```typescript
import { hashContent, readManifest, writeManifest, type ExportManifest } from '@/lib/services/ExportManifest';
```

Update `SiteExportResult`:

```typescript
export interface SiteExportResult {
  pagesExported: number;
  componentsExported: number;
  targetDir: string;
  skippedComponents: string[];
  skippedPages: string[];
}
```

Replace the existing directory-existence check block:

```typescript
    const targetDir = path.join(getProjectRoot(), 'storage', 'exports', subdir);
    try {
      await fsPromises.mkdir(targetDir);
    } catch (e: any) {
      if (e?.code === 'EEXIST') return { error: 'ALREADY_EXISTS' };
      console.error(`Failed to create export target directory ${targetDir}:`, e);
      throw e;
    }
```

with:

```typescript
    let existingManifest: ExportManifest | null = null;
    try {
      await fsPromises.mkdir(targetDir);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        console.error(`Failed to create export target directory ${targetDir}:`, e);
        throw e;
      }
      // The directory already exists - this is only a legitimate re-export if
      // it's one GameForge made for this exact style. Anything else (an
      // unrelated directory, or another style's export reusing this subdir
      // name) must not be silently written into.
      existingManifest = await readManifest(targetDir);
      if (!existingManifest || existingManifest.styleId !== styleId) {
        return { error: 'ALREADY_EXISTS' };
      }
    }
```

Now use `existingManifest` to decide, per component, whether to write or skip. In the component
write loop (`for (const component of components) { ... }`), replace:

```typescript
      for (const component of components) {
        await fsPromises.writeFile(
          path.join(targetDir, 'components', `${component.componentName}.tsx`),
          this.buildComponentFile(component)
        );
        await fsPromises.writeFile(
          path.join(targetDir, 'components', `${component.componentName}.module.css`),
          component.css
        );
      }
```

with:

```typescript
      const skippedComponents: string[] = [];
      for (const component of components) {
        const expectedHash = hashContent(this.buildComponentFile(component) + '\n' + component.css);
        const priorEntry = existingManifest?.components.find(c => c.assetId === component.asset.id);
        // A hand-edit is detected by comparing the CURRENT ON-DISK file against
        // what the manifest last recorded as GameForge's own expected content
        // for this component - not against what we're about to write now. If
        // they differ, someone changed the file since the last export/sync and
        // it must not be silently overwritten.
        if (priorEntry) {
          const tsxPath = path.join(targetDir, 'components', `${component.componentName}.tsx`);
          const cssPath = path.join(targetDir, 'components', `${component.componentName}.module.css`);
          let onDiskHash: string | null = null;
          try {
            const [tsx, css] = await Promise.all([
              fsPromises.readFile(tsxPath, 'utf-8'),
              fsPromises.readFile(cssPath, 'utf-8'),
            ]);
            onDiskHash = hashContent(tsx + '\n' + css);
          } catch {
            // Files don't exist on disk (e.g. deleted by hand) - nothing to
            // preserve, safe to write fresh below.
          }
          if (onDiskHash !== null && onDiskHash !== priorEntry.contentHash) {
            skippedComponents.push(component.componentName);
            continue;
          }
        }
        await fsPromises.writeFile(
          path.join(targetDir, 'components', `${component.componentName}.tsx`),
          this.buildComponentFile(component)
        );
        await fsPromises.writeFile(
          path.join(targetDir, 'components', `${component.componentName}.module.css`),
          component.css
        );
      }
```

Now do the exact same thing for page files. Task 3's page-writing code (the `homePageFile` write
followed by the `for (let i = 1; ...)` loop) currently overwrites `page.tsx` unconditionally on
every export — that's fine for a first export, but on a re-export it would silently destroy a
hand-edit to a page file (e.g. a manually reordered component tag) exactly the way an unprotected
component write would. Replace that block:

```typescript
      const manifestPages: ExportManifest['pages'] = [];

      const slugs = this.buildPageSlugs(pages);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'layout.tsx'), this.buildLayoutFile(pages, slugs));

      const homePageFile = this.buildPageFile(pages[0], pageComponentNames[0], components);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'page.tsx'), homePageFile);
      manifestPages.push({
        id: pages[0].id,
        name: pages[0].name,
        slug: slugs[0],
        componentAssetIds: JSON.parse(pages[0].component_asset_ids),
        pageFileHash: hashContent(homePageFile),
      });

      for (let i = 1; i < pages.length; i++) {
        const pageDir = path.join(targetDir, 'app', slugs[i]);
        await fsPromises.mkdir(pageDir, { recursive: true });
        const pageFile = this.buildPageFile(pages[i], pageComponentNames[i], components);
        await fsPromises.writeFile(path.join(pageDir, 'page.tsx'), pageFile);
        manifestPages.push({
          id: pages[i].id,
          name: pages[i].name,
          slug: slugs[i],
          componentAssetIds: JSON.parse(pages[i].component_asset_ids),
          pageFileHash: hashContent(pageFile),
        });
      }
```

with:

```typescript
      const skippedPages: string[] = [];
      const manifestPages: ExportManifest['pages'] = [];

      const slugs = this.buildPageSlugs(pages);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'layout.tsx'), this.buildLayoutFile(pages, slugs));

      // Same hash-check-and-skip pattern as the component loop above, applied
      // to page files: only overwrite a page.tsx if its on-disk content still
      // matches what GameForge itself last wrote there (per the PRIOR
      // manifest) - anything else means a human touched it since, and it
      // must not be silently clobbered.
      const writePageIfUnedited = async (pageId: string, pageFile: string, pageFilePath: string): Promise<void> => {
        const priorEntry = existingManifest?.pages.find(p => p.id === pageId);
        if (priorEntry) {
          let onDiskHash: string | null = null;
          try {
            onDiskHash = hashContent(await fsPromises.readFile(pageFilePath, 'utf-8'));
          } catch {
            // No file on disk (e.g. deleted by hand) - nothing to preserve.
          }
          if (onDiskHash !== null && onDiskHash !== priorEntry.pageFileHash) {
            skippedPages.push(pageId);
            return;
          }
        }
        await fsPromises.writeFile(pageFilePath, pageFile);
      };

      const homePageFile = this.buildPageFile(pages[0], pageComponentNames[0], components);
      await writePageIfUnedited(pages[0].id, homePageFile, path.join(targetDir, 'app', 'page.tsx'));
      manifestPages.push({
        id: pages[0].id,
        name: pages[0].name,
        slug: slugs[0],
        componentAssetIds: JSON.parse(pages[0].component_asset_ids),
        pageFileHash: hashContent(homePageFile),
      });

      for (let i = 1; i < pages.length; i++) {
        const pageDir = path.join(targetDir, 'app', slugs[i]);
        await fsPromises.mkdir(pageDir, { recursive: true });
        const pageFile = this.buildPageFile(pages[i], pageComponentNames[i], components);
        await writePageIfUnedited(pages[i].id, pageFile, path.join(pageDir, 'page.tsx'));
        manifestPages.push({
          id: pages[i].id,
          name: pages[i].name,
          slug: slugs[i],
          componentAssetIds: JSON.parse(pages[i].component_asset_ids),
          pageFileHash: hashContent(pageFile),
        });
      }
```

Note `manifestPages` always records the freshly-computed hash (what GameForge currently intends to
write), never the on-disk hash — identical reasoning to the component manifest entries below: a
skipped page's divergence keeps being correctly detected on every future export/sync until it's
actually reconciled, exactly like a skipped component's.

Finally, update the manifest's `components` entries to always reflect GameForge's own expected
content (not the on-disk hand-edited content, so a divergence keeps being detected on every future
export/sync until it's actually reconciled), and return `skippedComponents`/`skippedPages` in the
result:

```typescript
      const manifest: ExportManifest = {
        styleId,
        exportedAt: Date.now(),
        pages: manifestPages,
        components: components.map(c => ({
          assetId: c.asset.id,
          componentName: c.componentName,
          contentHash: hashContent(this.buildComponentFile(c) + '\n' + c.css),
        })),
      };
      await writeManifest(targetDir, manifest);

      return { pagesExported: pages.length, componentsExported: components.length, targetDir, skippedComponents, skippedPages };
```

(replacing the old `return { pagesExported: ..., componentsExported: ..., targetDir };` line).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/siteExporter.test.ts`
Expected: PASS (all tests, including the 4 new ones)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass. Check `test/siteExportRoute.test.ts` in particular, since it exercises the
export API route end-to-end and its assertions on the result shape may need `skippedComponents:
[]` and `skippedPages: []` added if it does exact-shape equality checks — read that file and
adjust if needed.

- [ ] **Step 6: Commit**

```bash
git add lib/services/SiteExporter.ts test/siteExporter.test.ts
git commit -m "feat: support re-exporting into an existing directory without clobbering hand-edits"
```

---

### Task 5: Crash-safe, heartbeat-based export lock

**Files:**
- Modify: `lib/services/SiteExporter.ts` (`exportSite`)
- Test: `test/siteExporterLock.test.ts`

**Interfaces:**
- Produces: `exportSite()` now serializes concurrent calls for the same `(styleId, subdir)` —
  tested directly, not consumed by name by any other task.
- Produces: `isExportInProgress(subdir: string): Promise<boolean>` — a read-only lock check,
  consumed by Task 7's preview/apply routes so a sync never races a concurrent re-export.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/siteExporterLock.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { siteExporter, isExportInProgress } from '@/lib/services/SiteExporter';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-siteexportlock-'));
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
  vi.useRealTimers();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

const COMPONENT_DOC = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><button class="btn">Go</button></body></html>';

async function setUpStyleWithOnePage(subdir: string) {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'comp.html'), COMPONENT_DOC);
  await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button', imagePath: 'comp.html', outputKind: 'component' });
  await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
  return style;
}

describe('siteExporter.exportSite concurrency', () => {
  it('refuses a second concurrent export of the same (styleId, subdir) while the first is in flight', async () => {
    const style = await setUpStyleWithOnePage('my-site');

    // Hold the lock directory open manually to simulate an in-flight export,
    // rather than racing two real exportSite() calls (too fast to reliably
    // interleave in a single-threaded test).
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));

    const result = await siteExporter.exportSite(style.id, 'my-site');
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected an error result');
    expect(result.error).toBe('EXPORT_IN_PROGRESS');
  });

  it('recovers a stale lock (heartbeat older than the staleness window) and proceeds', async () => {
    const style = await setUpStyleWithOnePage('my-site');

    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago - well past the 2-minute staleness window
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(staleTimestamp));

    const result = await siteExporter.exportSite(style.id, 'my-site');
    expect('error' in result).toBe(false);
  });

  it('does not treat an in-progress export as stale just because it is slow', async () => {
    const style = await setUpStyleWithOnePage('my-site');

    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    const recentTimestamp = Date.now() - 30 * 1000; // 30 seconds ago - well within the 2-minute window
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(recentTimestamp));

    const result = await siteExporter.exportSite(style.id, 'my-site');
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected an error result');
    expect(result.error).toBe('EXPORT_IN_PROGRESS');
  });
});

describe('isExportInProgress', () => {
  it('returns false when no lock directory exists', async () => {
    await setUpStyleWithOnePage('my-site');
    expect(await isExportInProgress('my-site')).toBe(false);
  });

  it('returns true while a live lock is held', async () => {
    await setUpStyleWithOnePage('my-site');
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));
    expect(await isExportInProgress('my-site')).toBe(true);
  });

  it('returns false once the lock has gone stale', async () => {
    await setUpStyleWithOnePage('my-site');
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    const staleTimestamp = Date.now() - 10 * 60 * 1000;
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(staleTimestamp));
    expect(await isExportInProgress('my-site')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/siteExporterLock.test.ts`
Expected: FAIL — `exportSite` doesn't check for a lock at all yet, so all three tests see it
proceed rather than returning `EXPORT_IN_PROGRESS` (the first two would currently pass by
accident/fail differently; run it and read the actual output before proceeding, per
`verification-before-completion` doctrine — don't assume the failure mode without checking).

- [ ] **Step 3: Implement**

In `lib/services/SiteExporter.ts`, add near the top of the file (after existing constants):

```typescript
const LOCK_STALE_MS = 2 * 60 * 1000; // no heartbeat for this long => treat as crashed
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

interface ExportLock {
  release(): Promise<void>;
}

async function writeHeartbeat(lockDir: string): Promise<void> {
  await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));
}

async function isLockStale(lockDir: string): Promise<boolean> {
  try {
    const raw = await fsPromises.readFile(path.join(lockDir, 'heartbeat'), 'utf-8');
    const last = Number(raw);
    return !Number.isFinite(last) || Date.now() - last > LOCK_STALE_MS;
  } catch {
    // Lock directory exists but no heartbeat file yet (a narrow window right
    // after another process's mkdir, before its first writeHeartbeat call) -
    // not stale, just brand new. Treating this as stale would defeat the
    // lock during that window.
    return false;
  }
}

/**
 * Atomically claims a stale lock by renaming it away first - remove-then-mkdir
 * is NOT atomic as a unit and lets two contenders both "win" a stale lock at
 * once. Only the contender whose rename succeeds may proceed to create a
 * fresh lock; a second contender's rename fails with ENOENT (the path is
 * already gone) and it must back off normally.
 */
async function tryRecoverStaleLock(lockDir: string): Promise<boolean> {
  const garbageDir = `${lockDir}.stale.${process.pid}`;
  try {
    await fsPromises.rename(lockDir, garbageDir);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
  fsPromises.rm(garbageDir, { recursive: true, force: true }).catch(e => {
    console.error(`Failed to clean up stale export lock remnant ${garbageDir}:`, e);
  });
  return true;
}

async function acquireExportLock(exportsRootDir: string, subdir: string): Promise<ExportLock> {
  const locksDir = path.join(exportsRootDir, '.locks');
  await fsPromises.mkdir(locksDir, { recursive: true });
  const lockDir = path.join(locksDir, `${subdir}.lock`);

  async function tryClaim(): Promise<boolean> {
    try {
      await fsPromises.mkdir(lockDir);
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      return false;
    }
  }

  let claimed = await tryClaim();
  if (!claimed && await isLockStale(lockDir)) {
    if (await tryRecoverStaleLock(lockDir)) {
      claimed = await tryClaim();
    }
  }
  if (!claimed) {
    throw new Error('EXPORT_IN_PROGRESS');
  }

  await writeHeartbeat(lockDir);
  const heartbeatTimer = setInterval(() => {
    writeHeartbeat(lockDir).catch(e => console.error(`Failed to refresh export lock heartbeat for ${subdir}:`, e));
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  return {
    async release() {
      clearInterval(heartbeatTimer);
      try {
        await fsPromises.rm(lockDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Failed to remove export lock directory ${lockDir}:`, e);
      }
    },
  };
}

/**
 * Read-only check for callers that don't want to hold the lock themselves
 * (Task 7's sync preview/apply routes) - they just need to avoid racing a
 * re-export that's actively in flight. Mirrors acquireExportLock's own
 * staleness logic exactly, so it never reports a truly-dead lock as "in
 * progress" and blocks a sync on a crashed export forever.
 */
export async function isExportInProgress(subdir: string): Promise<boolean> {
  const lockDir = path.join(getProjectRoot(), 'storage', 'exports', '.locks', `${subdir}.lock`);
  try {
    await fsPromises.access(lockDir);
  } catch {
    return false;
  }
  return !(await isLockStale(lockDir));
}
```

Update `SiteExportResult`'s error union and `exportSite`'s signature to include the new error kind:

```typescript
  async exportSite(styleId: string, subdir: string): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' | 'EXPORT_IN_PROGRESS' }> {
```

Wrap the body of `exportSite` (everything from the `pagesNewestFirst` lookup through the final
`return`) so the lock is acquired right after the `exportsRootDir` is ensured to exist, and always
released. Restructure:

```typescript
    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');
    try {
      await fsPromises.mkdir(exportsRootDir, { recursive: true });
    } catch (e) {
      console.error(`Failed to create the exports root directory ${exportsRootDir}:`, e);
      throw e;
    }

    let lock: ExportLock;
    try {
      lock = await acquireExportLock(exportsRootDir, subdir);
    } catch (e: any) {
      if (e?.message === 'EXPORT_IN_PROGRESS') return { error: 'EXPORT_IN_PROGRESS' };
      throw e;
    }

    try {
      const pagesNewestFirst = await pageService.getActivePagesForStyle(styleId);
      if (pagesNewestFirst.length === 0) {
        return { error: 'NOTHING_TO_EXPORT' };
      }
      const pages: Page[] = [...pagesNewestFirst].reverse();

      // ... (existing targetDir / manifest-check / write logic from Tasks 3-4 goes here, unchanged) ...

      return { pagesExported: pages.length, componentsExported: components.length, targetDir, skippedComponents };
    } finally {
      await lock.release();
    }
```

The `exportsRootDir` mkdir at the very top of the original method is now done BEFORE lock
acquisition (needed to create `.locks` inside it); remove the old duplicate mkdir of
`exportsRootDir` that used to appear later in the original flow, if any — there should be exactly
one, now before the lock.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/siteExporterLock.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass, including `test/siteExporter.test.ts` (Tasks 3-4's tests) and
`test/siteExportRoute.test.ts` — check that route's handling of the error union includes/ignores
`EXPORT_IN_PROGRESS` sensibly (it likely falls through to a generic error message today, which is
fine; just confirm the route test doesn't assert an exhaustive error-kind list that would now be
stale).

- [ ] **Step 6: Commit**

```bash
git add lib/services/SiteExporter.ts test/siteExporterLock.test.ts
git commit -m "feat: crash-safe heartbeat-based lock for concurrent site exports"
```

---

### Task 6: `ExportSync` — diff computation

**Files:**
- Create: `lib/services/ExportSync.ts`
- Test: `test/exportSync.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `type ExportManifest` from `@/lib/services/ExportManifest` (Task 2);
  `pageService.getActivePagesForStyle`, `assetService.getById` (existing).
- Produces: `computeSyncDiff(styleId: string, exportDir: string): Promise<SyncDiffResult>`,
  `SyncDiffResult` (a discriminated success/error result), `SyncDiff` (the diff shape: `newPages`,
  `deletedPageIds`, `pageOrderChanges`, `handEditedComponentAssetIds`) — consumed by Task 7's
  routes.

- [ ] **Step 1: Write the failing test**

```typescript
// test/exportSync.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { writeManifest, hashContent, type ExportManifest } from '@/lib/services/ExportManifest';
import { computeSyncDiff } from '@/lib/services/ExportSync';

let tempRoot: string;
let exportDir: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-exportsync-'));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  exportDir = path.join(tempRoot, 'export');
  await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function pageFileContent(pageId: string, componentTags: string): string {
  return `// gameforge-page-id: ${pageId}\nexport default function Page() {\n  return (\n    <>\n${componentTags}\n    </>\n  );\n}\n`;
}

describe('computeSyncDiff', () => {
  it('returns an error when no manifest exists in the export directory', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(false);
  });

  it('detects a new page (a route folder whose page.tsx has no embedded page-id)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.newPages).toHaveLength(1);
    expect(result.diff.newPages[0].slug).toBe('about');
    expect(result.diff.newPages[0].name).toBe('About');
  });

  it('detects a page deleted externally (a manifest page-id with no matching route folder)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Contact', createdBy: 'user-1' });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Contact', slug: 'contact', componentAssetIds: [], pageFileHash: 'irrelevant' }],
      components: [],
    });
    // No app/contact directory written on disk at all.

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.deletedPageIds).toEqual([page.id]);
  });

  it('resolves a page by its embedded id even if the route folder was renamed', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'About', createdBy: 'user-1' });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'About', slug: 'about-us', componentAssetIds: [], pageFileHash: 'irrelevant' }],
      components: [],
    });
    // Folder renamed by hand from "about-us" to "about" - the embedded id must still resolve it.
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), pageFileContent(page.id, ''));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.newPages).toHaveLength(0);
    expect(result.diff.deletedPageIds).toHaveLength(0);
  });

  it('detects a reordered/added/removed set of component references on a known page', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compA.id, compB.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
      ],
    });
    // Hand-edited order: hero now comes first (with an added attribute, to
    // also prove the regex tolerates that), navbar second.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <HeroBBB222 className="foo" />\n      <NavbarAAA111 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.pageOrderChanges).toHaveLength(1);
    expect(result.diff.pageOrderChanges[0].pageId).toBe(page.id);
    expect(result.diff.pageOrderChanges[0].newComponentAssetIds).toEqual([compB.id, compA.id]);
  });

  it('ignores a JSX tag that is not a known component name', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: 'x' }],
    });
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <HeroAAA111 />\n      <SomeHandWrittenThing />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // No change detected - the known component is still there in the same
    // position, and the unrecognized tag is simply not part of the tracked order.
    expect(result.diff.pageOrderChanges).toHaveLength(0);
  });

  it('detects a hand-edited component via a content hash mismatch', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([comp.id]) });

    await fsPromises.mkdir(path.join(exportDir, 'components'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.tsx'), 'export function HeroAAA111() { return <div />; }');
    await fsPromises.writeFile(path.join(exportDir, 'components', 'HeroAAA111.module.css'), '.root {}');

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [comp.id], pageFileHash: 'irrelevant' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: hashContent('this-does-not-match-the-files-above') }],
    });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'page.tsx'), pageFileContent(page.id, '      <HeroAAA111 />'));

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.handEditedComponentAssetIds).toEqual([comp.id]);
  });

  it('drops a component reference whose asset was soft-deleted after export, and reports it', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const compA = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'navbar', prompt: 'nav', imagePath: 'a.html', outputKind: 'component' });
    const compB = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'hero', imagePath: 'b.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([compA.id, compB.id]) });
    await assetService.softDelete(compB.id);

    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [compA.id, compB.id], pageFileHash: 'irrelevant' }],
      components: [
        { assetId: compA.id, componentName: 'NavbarAAA111', contentHash: 'x' },
        { assetId: compB.id, componentName: 'HeroBBB222', contentHash: 'y' },
      ],
    });
    // The exported file still references both, unedited since export.
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      pageFileContent(page.id, '      <NavbarAAA111 />\n      <HeroBBB222 />')
    );

    const result = await computeSyncDiff(style.id, exportDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diff.droppedDeletedAssetIds).toEqual([compB.id]);
    // The page's own order didn't otherwise change (both refs were already
    // present at export time) except for dropping the now-deleted one.
    expect(result.diff.pageOrderChanges).toEqual([{ pageId: page.id, newComponentAssetIds: [compA.id] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/exportSync.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/ExportSync'"

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/ExportSync.ts
import fsPromises from 'fs/promises';
import path from 'path';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { readManifest, hashContent, type ExportManifest } from '@/lib/services/ExportManifest';

export interface SyncNewPage {
  slug: string;
  name: string;
  componentAssetIds: string[];
}

export interface SyncPageOrderChange {
  pageId: string;
  newComponentAssetIds: string[];
}

export interface SyncDiff {
  newPages: SyncNewPage[];
  deletedPageIds: string[];
  pageOrderChanges: SyncPageOrderChange[];
  handEditedComponentAssetIds: string[];
  droppedDeletedAssetIds: string[];
}

export type SyncDiffResult =
  | { success: true; diff: SyncDiff }
  | { success: false; error: string };

const PAGE_ID_COMMENT_RE = /\/\/ gameforge-page-id: ([0-9a-f-]+)/;

function slugToName(slug: string): string {
  if (!slug) return 'Home';
  return slug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function extractComponentTagOrder(pageFileContent: string, knownComponentNames: Set<string>): string[] {
  const found: string[] = [];
  const re = /<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pageFileContent)) !== null) {
    if (knownComponentNames.has(match[1])) found.push(match[1]);
  }
  return found;
}

async function findRouteFolders(exportDir: string): Promise<Array<{ slug: string; pageFilePath: string }>> {
  const appDir = path.join(exportDir, 'app');
  const routes: Array<{ slug: string; pageFilePath: string }> = [];

  const homePageFile = path.join(appDir, 'page.tsx');
  try {
    await fsPromises.access(homePageFile);
    routes.push({ slug: '', pageFilePath: homePageFile });
  } catch {
    // No home page.tsx - unusual, but just means it's not present to scan.
  }

  let entries: Awaited<ReturnType<typeof fsPromises.readdir>>;
  try {
    entries = await fsPromises.readdir(appDir, { withFileTypes: true });
  } catch (e) {
    console.error(`Failed to read export app directory ${appDir}:`, e);
    return routes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pageFilePath = path.join(appDir, entry.name, 'page.tsx');
    try {
      await fsPromises.access(pageFilePath);
      routes.push({ slug: entry.name, pageFilePath });
    } catch {
      // Not a route folder (no page.tsx inside) - skip.
    }
  }
  return routes;
}

export async function computeSyncDiff(styleId: string, exportDir: string): Promise<SyncDiffResult> {
  const manifest = await readManifest(exportDir);
  if (!manifest || manifest.styleId !== styleId) {
    return { success: false, error: 'No GameForge export manifest found for this style in this directory. Export it from GameForge first.' };
  }

  const knownComponentNames = new Set(manifest.components.map(c => c.componentName));
  const componentNameToAssetId = new Map(manifest.components.map(c => [c.componentName, c.assetId]));

  // A component name resolves to a real asset ID only if that asset is still
  // active - a page.tsx can keep referencing a component whose asset was
  // soft-deleted from the dashboard after export, and that reference must be
  // dropped from the reconciled order (not silently kept), with the drop
  // reported in the diff rather than happening invisibly.
  const activeAssetIds = new Set<string>();
  for (const component of manifest.components) {
    const asset = await assetService.getById(component.assetId);
    if (asset && !asset.is_deleted) activeAssetIds.add(component.assetId);
  }
  const droppedDeletedAssetIds = new Set<string>();
  function resolveActiveAssetIds(tagNames: string[]): string[] {
    const resolved: string[] = [];
    for (const name of tagNames) {
      const assetId = componentNameToAssetId.get(name);
      if (!assetId) continue;
      if (!activeAssetIds.has(assetId)) {
        droppedDeletedAssetIds.add(assetId);
        continue;
      }
      resolved.push(assetId);
    }
    return resolved;
  }

  const routes = await findRouteFolders(exportDir);
  const routesById = new Map<string, { slug: string; pageFilePath: string; content: string }>();
  const newPages: SyncNewPage[] = [];

  for (const route of routes) {
    let content: string;
    try {
      content = await fsPromises.readFile(route.pageFilePath, 'utf-8');
    } catch (e) {
      console.error(`Failed to read page file ${route.pageFilePath}:`, e);
      continue;
    }
    const idMatch = content.match(PAGE_ID_COMMENT_RE);
    if (idMatch) {
      routesById.set(idMatch[1], { ...route, content });
    } else {
      const tagNames = extractComponentTagOrder(content, knownComponentNames);
      newPages.push({
        slug: route.slug,
        name: slugToName(route.slug),
        componentAssetIds: resolveActiveAssetIds(tagNames),
      });
    }
  }

  const deletedPageIds: string[] = [];
  const pageOrderChanges: SyncPageOrderChange[] = [];
  const currentPages = await pageService.getActivePagesForStyle(styleId);
  const currentPagesById = new Map(currentPages.map(p => [p.id, p]));

  for (const manifestPage of manifest.pages) {
    const route = routesById.get(manifestPage.id);
    const currentPage = currentPagesById.get(manifestPage.id);
    if (!route) {
      if (currentPage) deletedPageIds.push(manifestPage.id);
      continue;
    }
    if (!currentPage) continue; // page was already soft-deleted in the DB independently of export - nothing to reconcile
    const tagNames = extractComponentTagOrder(route.content, knownComponentNames);
    const newOrder = resolveActiveAssetIds(tagNames);
    const currentOrder: string[] = JSON.parse(currentPage.component_asset_ids);
    if (JSON.stringify(newOrder) !== JSON.stringify(currentOrder)) {
      pageOrderChanges.push({ pageId: manifestPage.id, newComponentAssetIds: newOrder });
    }
  }

  const handEditedComponentAssetIds: string[] = [];
  for (const component of manifest.components) {
    const tsxPath = path.join(exportDir, 'components', `${component.componentName}.tsx`);
    const cssPath = path.join(exportDir, 'components', `${component.componentName}.module.css`);
    try {
      const [tsx, css] = await Promise.all([
        fsPromises.readFile(tsxPath, 'utf-8'),
        fsPromises.readFile(cssPath, 'utf-8'),
      ]);
      const onDiskHash = hashContent(tsx + '\n' + css);
      if (onDiskHash !== component.contentHash) {
        handEditedComponentAssetIds.push(component.assetId);
      }
    } catch {
      // Component files missing entirely - not treated as a hand-edit here;
      // it will simply no longer appear in any page's tag scan above.
    }
  }

  return {
    success: true,
    diff: { newPages, deletedPageIds, pageOrderChanges, handEditedComponentAssetIds, droppedDeletedAssetIds: [...droppedDeletedAssetIds] },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/exportSync.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/ExportSync.ts test/exportSync.test.ts
git commit -m "feat: add ExportSync diff computation for reverse-sync"
```

---

### Task 7: `preview`/`apply` routes

**Files:**
- Create: `app/api/styles/[id]/export-sync/preview/route.ts`
- Create: `app/api/styles/[id]/export-sync/apply/route.ts`
- Test: `test/exportSyncRoutes.test.ts`

**Interfaces:**
- Consumes: `computeSyncDiff` from `@/lib/services/ExportSync` (Task 6); `pageService.create`,
  `pageService.update`, `pageService.softDelete` (existing); `isExportInProgress` from
  `@/lib/services/SiteExporter` (Task 5) — both routes check it before touching the export
  directory or the DB, so a sync never races a concurrent re-export.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/exportSyncRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { writeManifest } from '@/lib/services/ExportManifest';
import { POST as previewPost } from '@/app/api/styles/[id]/export-sync/preview/route';
import { POST as applyPost } from '@/app/api/styles/[id]/export-sync/apply/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-exportsyncroute-'));
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
  return new NextRequest('http://localhost/api/styles/style-1/export-sync/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/styles/[id]/export-sync/preview', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await previewPost(req({ subdir: 'my-site' }), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('returns a 400 with a clear error when no export exists for this subdir', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await previewPost(req({ subdir: 'nonexistent' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
  });

  it('returns the computed diff for a real export directory', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const res = await previewPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.newPages).toHaveLength(1);
  });

  it('returns 409 when a re-export is in progress for this subdir', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));

    const res = await previewPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/styles/[id]/export-sync/apply', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const res = await applyPost(req({ subdir: 'my-site' }), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('creates a new page for a route folder with no matching manifest entry', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    await fsPromises.mkdir(path.join(exportDir, 'app', 'about'), { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <><p>hi</p></>; }');

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages.map(p => p.name)).toContain('About');
  });

  it('soft-deletes a page whose route folder no longer exists', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const page = await pageService.create({ styleId: style.id, name: 'Contact', createdBy: userId });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Contact', slug: 'contact', componentAssetIds: [], pageFileHash: 'x' }],
      components: [],
    });

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages.find(p => p.id === page.id)).toBeUndefined();
  });

  it('updates an existing page\'s component order', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const comp = await assetService.create({ styleId: style.id, createdBy: userId, assetType: 'hero', prompt: 'hero', imagePath: 'a.html', outputKind: 'component' });
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: userId });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([]) });

    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, {
      styleId: style.id, exportedAt: Date.now(),
      pages: [{ id: page.id, name: 'Home', slug: '', componentAssetIds: [], pageFileHash: 'x' }],
      components: [{ assetId: comp.id, componentName: 'HeroAAA111', contentHash: 'y' }],
    });
    await fsPromises.writeFile(
      path.join(exportDir, 'app', 'page.tsx'),
      `// gameforge-page-id: ${page.id}\nexport default function Page() { return (<><HeroAAA111 /></>); }`
    );

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);

    const updated = await pageService.getById(page.id);
    expect(JSON.parse(updated!.component_asset_ids)).toEqual([comp.id]);
  });

  it('ignores diff-shaped data in the request body and recomputes server-side', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const exportDir = path.join(tempRoot, 'storage', 'exports', 'my-site');
    await fsPromises.mkdir(path.join(exportDir, 'app'), { recursive: true });
    await writeManifest(exportDir, { styleId: style.id, exportedAt: Date.now(), pages: [], components: [] });
    // No actual new page directory on disk - only a fabricated client-side diff claiming one.

    const res = await applyPost(
      req({ subdir: 'my-site', diff: { newPages: [{ slug: 'fake', name: 'Fake', componentAssetIds: [] }] } }, cookieHeader),
      { params: Promise.resolve({ id: style.id }) }
    );
    expect(res.status).toBe(200);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages.map(p => p.name)).not.toContain('Fake');
  });

  it('returns 409 and writes nothing when a re-export is in progress for this subdir', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const lockDir = path.join(tempRoot, 'storage', 'exports', '.locks', 'my-site.lock');
    await fsPromises.mkdir(lockDir, { recursive: true });
    await fsPromises.writeFile(path.join(lockDir, 'heartbeat'), String(Date.now()));

    const res = await applyPost(req({ subdir: 'my-site' }, cookieHeader), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(409);

    const pages = await pageService.getActivePagesForStyle(style.id);
    expect(pages).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/exportSyncRoutes.test.ts`
Expected: FAIL — both route modules don't exist yet.

- [ ] **Step 3: Write the `preview` route**

```typescript
// app/api/styles/[id]/export-sync/preview/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { computeSyncDiff } from '@/lib/services/ExportSync';
import { isExportInProgress } from '@/lib/services/SiteExporter';

export const dynamic = 'force-dynamic';

const PreviewSchema = z.object({ subdir: z.string().min(1) });

// Mirrors SiteExporter's own subdir validation - re-checked here for the
// same reason SiteExporter re-checks it: this route builds a real
// filesystem path from it and must not be reachable with a path-traversal
// payload regardless of caller.
const SUBDIR_PATTERN = /^[a-z0-9-]+$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = PreviewSchema.parse(await req.json());
    if (!SUBDIR_PATTERN.test(input.subdir)) {
      return NextResponse.json({ success: false, error: 'Invalid subdir' }, { status: 400 });
    }
    // Don't read a manifest or export directory a concurrent re-export might
    // be mid-write on - same lock SiteExporter itself holds during export,
    // checked here read-only rather than acquired.
    if (await isExportInProgress(input.subdir)) {
      return NextResponse.json({ success: false, error: 'An export is currently in progress for this folder. Try again in a moment.' }, { status: 409 });
    }

    const exportDir = path.join(getProjectRoot(), 'storage', 'exports', input.subdir);
    const result = await computeSyncDiff(id, exportDir);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, data: result.diff });
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

- [ ] **Step 4: Write the `apply` route**

```typescript
// app/api/styles/[id]/export-sync/apply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { computeSyncDiff } from '@/lib/services/ExportSync';
import { pageService } from '@/lib/services/PageService';
import { isExportInProgress } from '@/lib/services/SiteExporter';

export const dynamic = 'force-dynamic';

// Deliberately only `subdir` - apply NEVER accepts a client-supplied diff.
// It always recomputes fresh from current on-disk + DB state, exactly like
// preview does, so a stale or tampered client-side diff can never be
// applied; any extra fields (e.g. a "diff" the client might send) are
// simply ignored by this schema.
const ApplySchema = z.object({ subdir: z.string().min(1) });

const SUBDIR_PATTERN = /^[a-z0-9-]+$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = ApplySchema.parse(await req.json());
    if (!SUBDIR_PATTERN.test(input.subdir)) {
      return NextResponse.json({ success: false, error: 'Invalid subdir' }, { status: 400 });
    }
    // apply writes to the DB from whatever it reads on disk - must not race
    // a re-export that could be mid-write on the same manifest/files.
    if (await isExportInProgress(input.subdir)) {
      return NextResponse.json({ success: false, error: 'An export is currently in progress for this folder. Try again in a moment.' }, { status: 409 });
    }

    const exportDir = path.join(getProjectRoot(), 'storage', 'exports', input.subdir);
    const result = await computeSyncDiff(id, exportDir);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    const { diff } = result;

    for (const newPage of diff.newPages) {
      const created = await pageService.create({ styleId: id, name: newPage.name, createdBy: user.id });
      await pageService.update(created.id, { componentAssetIds: JSON.stringify(newPage.componentAssetIds) });
    }
    for (const change of diff.pageOrderChanges) {
      await pageService.update(change.pageId, { componentAssetIds: JSON.stringify(change.newComponentAssetIds) });
    }
    for (const deletedId of diff.deletedPageIds) {
      await pageService.softDelete(deletedId);
    }

    return NextResponse.json({ success: true, data: diff });
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

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/exportSyncRoutes.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/styles/[id]/export-sync test/exportSyncRoutes.test.ts
git commit -m "feat: add export-sync preview/apply routes"
```

---

### Task 8: `PATCH /api/assets/[id]/component` — promoted-component edit + trusted paste-back

**Files:**
- Create: `app/api/assets/[id]/component/route.ts`
- Test: `test/assetComponentEditRoute.test.ts`

**Interfaces:**
- Consumes: `assetService.getById`, `assetService.update` (Task 1's `editedExternally` field);
  `sanitizeComponentHtml`, `sanitizeComponentCss` from `@/lib/services/componentSanitize`;
  `combineComponentHtml` from `@/lib/services/componentDocument`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/assetComponentEditRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { PATCH } from '@/app/api/assets/[id]/component/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetcomponentedit-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
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
  return new NextRequest('http://localhost/api/assets/asset-1/component', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

async function makeComponentAsset(styleId: string, createdBy: string) {
  const filename = 'comp.html';
  await fsPromises.writeFile(
    path.join(tempRoot, 'storage', 'components', filename),
    '<!DOCTYPE html><html><head><style>.btn{color:red;}</style></head><body><button class="btn">Go</button></body></html>'
  );
  return assetService.create({ styleId, createdBy, assetType: 'button', prompt: 'a button', imagePath: filename, outputKind: 'component' });
}

describe('PATCH /api/assets/[id]/component', () => {
  it('requires login', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    const res = await PATCH(req({ html: '<button>Go</button>', css: '.btn{}' }), { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-component asset', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const themeAsset = await assetService.create({ styleId: style.id, createdBy: userId, assetType: 'theme', prompt: 'x', imagePath: 'x.css', outputKind: 'theme' });
    const res = await PATCH(req({ html: '<a></a>', css: '' }, cookieHeader), { params: Promise.resolve({ id: themeAsset.id }) });
    expect(res.status).toBe(404);
  });

  it('sanitizes and rejects unsafe HTML when trustAsEdited is false or omitted', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    const res = await PATCH(req({ html: '<script>alert(1)</script><button>Go</button>', css: '.btn{}' }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.html).not.toContain('<script>');

    const updated = await assetService.getById(asset.id);
    expect(updated!.edited_externally).toBe(0);
  });

  it('skips sanitization and sets edited_externally when trustAsEdited is true', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    // Something the narrow allowlist would normally strip (an <img> tag) -
    // proves sanitization was genuinely skipped, not just permissive by luck.
    const res = await PATCH(
      req({ html: '<img src="x.png" /><button>Go</button>', css: '.btn{color:blue;}', trustAsEdited: true }, cookieHeader),
      { params: Promise.resolve({ id: asset.id }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.html).toContain('<img');

    const updated = await assetService.getById(asset.id);
    expect(updated!.edited_externally).toBe(1);
  });

  it('clears edited_externally on a subsequent ordinary (non-trusted) save', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    await PATCH(req({ html: '<button>Go</button>', css: '.btn{}', trustAsEdited: true }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });
    expect((await assetService.getById(asset.id))!.edited_externally).toBe(1);

    await PATCH(req({ html: '<button>Go again</button>', css: '.btn{}' }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });
    expect((await assetService.getById(asset.id))!.edited_externally).toBe(0);
  });

  it('writes the file via combineComponentHtml either way', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'S', createdBy: userId, parameters: '{}' });
    const asset = await makeComponentAsset(style.id, userId);
    await PATCH(req({ html: '<button>Updated</button>', css: '.btn{color:green;}' }, cookieHeader), { params: Promise.resolve({ id: asset.id }) });

    const fileContent = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', 'comp.html'), 'utf-8');
    expect(fileContent).toContain('Updated');
    expect(fileContent).toContain('color:green');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assetComponentEditRoute.test.ts`
Expected: FAIL — the route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/assets/[id]/component/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { assetService } from '@/lib/services/AssetService';
import { combineComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  html: z.string(),
  css: z.string(),
  trustAsEdited: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset || asset.is_deleted || asset.output_kind !== 'component') {
      return NextResponse.json({ success: false, error: 'Component asset not found' }, { status: 404 });
    }
    if (!asset.image_path || asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 500 });
    }

    const input = PatchSchema.parse(await req.json());
    const trustAsEdited = input.trustAsEdited === true;

    let tokens: ComponentTokens;
    if (trustAsEdited) {
      // Explicitly trusted, unsanitized paste-back of externally-edited code
      // - the whole point of this path (see the reverse-sync design spec).
      tokens = { html: input.html, css: input.css };
    } else {
      try {
        tokens = {
          html: sanitizeComponentHtml(input.html),
          css: sanitizeComponentCss(input.css),
        };
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
    }

    const filePath = path.join(getProjectRoot(), 'storage', 'components', asset.image_path);
    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write component file on asset edit (${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the component file' }, { status: 500 });
    }

    await assetService.update(id, { editedExternally: trustAsEdited });

    return NextResponse.json({ success: true, data: tokens });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Unexpected error in asset component edit route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assetComponentEditRoute.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/api/assets/[id]/component test/assetComponentEditRoute.test.ts
git commit -m "feat: add promoted-component edit route with trusted paste-back"
```

---

### Task 9: "Sync from export" UI on the Style Hub page

**Files:**
- Modify: `app/dashboard/styles/[id]/page.tsx`

**Interfaces:**
- Consumes: `POST /api/styles/[id]/export-sync/preview`, `POST /api/styles/[id]/export-sync/apply`
  (Task 7).

This task is UI-only wiring against already-tested routes; verify it manually in a running dev
server rather than with a new automated test file (matching this codebase's own established
practice — UI-only tasks in prior plans in this repo were verified the same way).

- [ ] **Step 1: Add state and handlers**

In `app/dashboard/styles/[id]/page.tsx`, near the existing export-related state
(`exportSubdir`, `exporting`, `exportResult`, `exportError`), add:

```typescript
  const [syncSubdir, setSyncSubdir] = useState('my-site');
  const [syncing, setSyncing] = useState(false);
  const [syncDiff, setSyncDiff] = useState<{
    newPages: { slug: string; name: string; componentAssetIds: string[] }[];
    deletedPageIds: string[];
    pageOrderChanges: { pageId: string; newComponentAssetIds: string[] }[];
    handEditedComponentAssetIds: string[];
    droppedDeletedAssetIds: string[];
  } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [applyingSync, setApplyingSync] = useState(false);
```

Add handlers alongside the existing `handleExport`-style functions:

```typescript
  async function handlePreviewSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncDiff(null);
    try {
      const res = await fetch(`/api/styles/${id}/export-sync/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: syncSubdir }),
      });
      const body = await res.json();
      if (!body.success) {
        setSyncError(body.error ?? 'Could not compute changes.');
        return;
      }
      setSyncDiff(body.data);
    } catch {
      setSyncError('Could not reach the server.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleApplySync() {
    if (applyingSync) return;
    setApplyingSync(true);
    setSyncError(null);
    try {
      const res = await fetch(`/api/styles/${id}/export-sync/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: syncSubdir }),
      });
      const body = await res.json();
      if (!body.success) {
        setSyncError(body.error ?? 'Could not apply changes.');
        return;
      }
      setSyncDiff(null);
      await refresh();
    } catch {
      setSyncError('Could not reach the server.');
    } finally {
      setApplyingSync(false);
    }
  }
```

(`refresh` here is this file's existing helper that re-fetches style/assets/pages after a
mutation — reuse the same one `handleCreatePage`/`handleUpdatePage` already call; do not write a
new one.)

- [ ] **Step 2: Add the UI section**

Add this JSX block right after the existing "Export site" `<div className="card" ...>` block:

```tsx
      <div className="card" style={{ maxWidth: 560, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Sync from export</h2>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Check an exported project for hand-made changes (new pages, reordered or edited components)
          and bring the structural ones back into this Style Bible.
        </p>
        <div className="field">
          <label htmlFor="sync-subdir">Export folder name</label>
          <input id="sync-subdir" value={syncSubdir} onChange={e => setSyncSubdir(e.target.value)} />
        </div>
        <button className="btn" onClick={handlePreviewSync} disabled={syncing}>
          {syncing ? 'Checking…' : 'Check for changes'}
        </button>
        {syncError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{syncError}</p>}

        {syncDiff && (
          <div style={{ marginTop: 16 }}>
            {syncDiff.newPages.length === 0 && syncDiff.deletedPageIds.length === 0 &&
             syncDiff.pageOrderChanges.length === 0 && syncDiff.handEditedComponentAssetIds.length === 0 &&
             syncDiff.droppedDeletedAssetIds.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>No changes found.</p>
            ) : (
              <>
                {syncDiff.newPages.map(p => (
                  <p key={p.slug} style={{ fontSize: 13 }}>New page: <strong>{p.name}</strong> ({p.componentAssetIds.length} component{p.componentAssetIds.length === 1 ? '' : 's'})</p>
                ))}
                {syncDiff.deletedPageIds.map(pid => (
                  <p key={pid} style={{ fontSize: 13 }}>Page removed on disk, will be deleted here too.</p>
                ))}
                {syncDiff.pageOrderChanges.map(c => (
                  <p key={c.pageId} style={{ fontSize: 13 }}>Component order changed on a page.</p>
                ))}
                {syncDiff.handEditedComponentAssetIds.map(aid => (
                  <p key={aid} style={{ fontSize: 13 }}>
                    A component looks hand-edited — <a href={`/dashboard/assets/${aid}`}>open it</a> to paste the new markup in.
                  </p>
                ))}
                {syncDiff.droppedDeletedAssetIds.length > 0 && (
                  <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
                    {syncDiff.droppedDeletedAssetIds.length} reference{syncDiff.droppedDeletedAssetIds.length === 1 ? '' : 's'} to an already-deleted component will be dropped.
                  </p>
                )}
                <button className="btn btn-primary" onClick={handleApplySync} disabled={applyingSync} style={{ marginTop: 8 }}>
                  {applyingSync ? 'Applying…' : 'Apply structural changes'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
```

- [ ] **Step 3: Manually verify in a running dev server**

Start the dev server, create a Style Bible with a page and a component, export it, hand-edit the
exported `page.tsx` to add a new route folder, click "Check for changes," confirm the new page is
listed, click "Apply structural changes," confirm the new page now appears in the dashboard's
Pages list.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/styles/[id]/page.tsx
git commit -m "feat: add Sync from export UI to the Style Hub page"
```

---

### Task 10: Promoted-component edit UI on the asset detail page

**Files:**
- Modify: `app/dashboard/assets/[id]/page.tsx`

**Interfaces:**
- Consumes: `PATCH /api/assets/[id]/component` (Task 8).

- [ ] **Step 1: Add state and a handler**

In `app/dashboard/assets/[id]/page.tsx`, add state for the component editor (only rendered when
`asset.output_kind === 'component'`):

```typescript
  const [componentTokens, setComponentTokens] = useState<{ html: string; css: string } | null>(null);
  const [trustAsEdited, setTrustAsEdited] = useState(false);
  const [savingComponent, setSavingComponent] = useState(false);
  const [componentSaveError, setComponentSaveError] = useState<string | null>(null);
```

Load the current HTML/CSS when the asset is a component (alongside the existing load effect —
reuse the `parseComponentHtml` import this file already has):

```typescript
  useEffect(() => {
    if (asset?.output_kind !== 'component' || !asset.image_path) return;
    let ignore = false;
    (async () => {
      try {
        const document = await (await fetch(`/api/components/${asset.image_path}`)).text();
        if (!ignore) setComponentTokens(parseComponentHtml(document));
      } catch {
        if (!ignore) setComponentSaveError('Could not load this component\'s current markup.');
      }
    })();
    return () => { ignore = true; };
  }, [asset?.output_kind, asset?.image_path]);

  async function handleSaveComponent() {
    if (!componentTokens || savingComponent) return;
    setSavingComponent(true);
    setComponentSaveError(null);
    try {
      const res = await fetch(`/api/assets/${id}/component`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...componentTokens, trustAsEdited }),
      });
      const body = await res.json();
      if (!body.success) {
        setComponentSaveError(body.error ?? 'Could not save.');
        return;
      }
      setComponentTokens(body.data);
      const refreshed = await (await fetch(`/api/assets/${id}`)).json();
      if (refreshed.success) setAsset(refreshed.data);
    } catch {
      setComponentSaveError('Could not reach the server.');
    } finally {
      setSavingComponent(false);
    }
  }
```

- [ ] **Step 2: Add the UI section**

Add this block near the existing component preview (`{asset.output_kind === 'component' && ...}`
block already in this file):

```tsx
      {asset.output_kind === 'component' && componentTokens && (
        <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Edit markup</h2>
          {asset.edited_externally === 1 && (
            <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginBottom: 8 }}>
              This component currently holds hand-edited code, imported outside GameForge&apos;s usual validation.
            </p>
          )}
          <div className="field">
            <label htmlFor="component-html">HTML</label>
            <textarea id="component-html" value={componentTokens.html} onChange={e => setComponentTokens({ ...componentTokens, html: e.target.value })} rows={8} />
          </div>
          <div className="field">
            <label htmlFor="component-css">CSS</label>
            <textarea id="component-css" value={componentTokens.css} onChange={e => setComponentTokens({ ...componentTokens, css: e.target.value })} rows={8} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={trustAsEdited} onChange={e => setTrustAsEdited(e.target.checked)} />
            Trust this as my own edited code (skips validation — use this when pasting in markup you hand-edited outside GameForge)
          </label>
          {componentSaveError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{componentSaveError}</p>}
          <button className="btn btn-primary" onClick={handleSaveComponent} disabled={savingComponent}>
            {savingComponent ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
```

- [ ] **Step 3: Manually verify in a running dev server**

Open a promoted component asset's detail page, confirm the HTML/CSS textareas show its current
markup, edit the CSS and save with the checkbox unchecked (confirm it saves and the preview
updates), then paste in markup containing an `<img>` tag with the checkbox checked (confirm it
saves without being stripped, and the "hand-edited code" notice appears after reloading).

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/assets/[id]/page.tsx
git commit -m "feat: add promoted-component edit UI with trusted paste-back"
```

---

## Final Verification

- [ ] Run `npx tsc --noEmit` — expect clean.
- [ ] Run `npx vitest run` — expect all tests passing.
- [ ] Manually walk the full loop in a dev server: export a style with 2+ pages and components,
  hand-edit the exported project (add a page, reorder components on an existing page, hand-edit
  one component's `.tsx`/`.module.css`), run "Check for changes," confirm the diff shows all three
  kinds of change correctly, click "Apply structural changes," confirm the new page and reordered
  components landed in the dashboard, open the flagged component's asset page, paste in updated
  markup with "trust this" checked, confirm it saves and shows the hand-edited badge, re-export
  into the same directory and confirm the hand-edited component's files are skipped (not
  overwritten) while everything else refreshes normally.
- [ ] Also hand-edit a `page.tsx` directly (not just a component) and re-export without syncing
  first — confirm that file is skipped too (not silently overwritten), matching the protection
  components already get.
