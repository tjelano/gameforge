# GAMEFORGE: MASTER IMPLEMENTATION BLUEPRINT (v5.5)

**Version:** 5.5
**Date:** September 2, 2026

## Executive Summary

GameForge is a local-first, Git-native game asset pipeline with a Next.js dashboard. Users define visual "Style Bibles," generate consistent 2D assets via AI (Pixellab), fork styles to create independent variations, and export to Godot (2D only for V1). The system uses SQLite for primary storage, Git for sync/backup (with UUID-based per-asset JSON files), and includes a dynamic context system for AI assistants.

**Estimated Development Time:** 5–7 days

---

## What's Changed in v5.5

| # | Issue | Fix |
|---|---|---|
| 1 | `resolveConflicts()` committed before checking for leftover conflict markers | Added `assertNoConflictMarkers()` — runs *before* staging/committing, not after |
| 2 | `cleanupOrphanedImages()` was called in `push()` but not in `pull()` | Added the same call to `pull()`, in the same position relative to staging |
| 3 | `cleanupOrphanedImages()` had never actually been shown | Implemented — protects images referenced by any asset (active *or* soft-deleted) and by any job that hasn't reached a terminal discarded state |
| 4 | AGENTS.md's fs-import rule was too literal (would force unused imports) | Reworded to state the actual requirement: sync and async fs calls need distinct import names, not both imports in every file |
| 5 | `DatabaseConnection` still resolved paths via `process.cwd()` directly | Switched to `getProjectRoot()`, for both the migrations directory *and* the `data.db` file path |
| 6 | `app/api/git/resolve/route.ts` was referenced in the directory tree across several rounds but never shown | Added |

Fix #5 wasn't on the original list of three — it turned up while editing `DatabaseConnection`. `new Database('data.db')` resolves that relative path against `process.cwd()`, which is exactly the cross-process assumption `getProjectRoot()` was built to remove. If `worker.ts` and the Next.js server are ever launched from different working directories, they'd silently open two different physical database files. Fixed it while in the file.

**On `cleanupOrphanedImages()`:** this function's behavior was previously only described ("protects soft-deleted assets," "filename normalization"), never shown. The implementation below is a new, reasoned design based on those descriptions plus the job lifecycle established elsewhere in this blueprint — it is **not** excavated from a previously-hidden source, because there wasn't one. In particular, it makes one design call worth confirming: it protects images belonging to `pending`/`processing`/`complete`-but-unpromoted jobs, not just assets. Without that, cleanup would delete a freshly generated image the moment it syncs, before the user has had a chance to look at it in the Jobs page and decide whether to promote or discard it. If that's not the intended behavior, this is the function to adjust.

---

## The Hard Rules (Non-Negotiable)

| # | Rule | Enforcement |
|---|---|---|
| 1 | SQLite is the source of truth. JSON is only for Git sync. | No reading from JSON except during `importFromJson()` |
| 2 | Only the creator can edit a style. Others must Fork. | `StyleService.update()` checks `created_by` (UUID) — always server-side |
| 3 | All data must be validated with Zod schemas. | Every read/write calls `Schema.parse()` |
| 4 | Services are singletons. No fs calls outside DataStore. | All fs operations in `DataStore` class |
| 5 | Files should stay under 200 lines (guideline, not rigid). | CI warns, doesn't fail |
| 6 | Every async operation must have error handling. | Every async method has try/catch |
| 7 | No business logic in UI components. | Components call services or stores |
| 8 | No unnecessary abstraction. | Build what's needed, nothing more |
| 9 | All public methods must have JSDoc comments. | Enforced by code review |
| 10 | API routes return `{ success, data, error }` format. | Consistent response contract |
| 11 | All API routes validate incoming payloads with Zod. | `schema.parse(req.body)` before passing to services |
| 12 | Background jobs run in a separate worker process. | `worker.ts` with `tsx`, recursive `setTimeout` in `finally` block |
| 13 | Forking creates a new UUID. The original is never modified. | Fork copies parameters but uses new id and `created_by` |
| 14 | Soft delete for styles AND assets. Hard delete is never allowed. | `is_deleted` flag; queries filter `is_deleted = 0` |
| 15 | Pull saves local changes before merging (if any). | `pull()` checks git status before committing |
| 16 | Both styles AND assets synced via Git. | `exportToJson()` and `importFromJson()` handle both tables |
| 17 | Worker processes jobs in chunks (batch size from env). | `WORKER_BATCH_SIZE` env var |
| 18 | Standard git push (no force flags) with `--atomic`. | Prevents silent overwrite + partial pushes |
| 19 | Database stores ONLY filenames (no URLs). | Frontend constructs `/api/images/`, exporter constructs physical path |
| 20 | AGENTS.md: NO wrapper classes, NO DTOs, NO factory patterns. | Explicit AI directives |

---

## Directory Structure

```
gameforge/
├── .env.local                          # API keys + WORKER_BATCH_SIZE + IO_WRITE_BATCH_SIZE
├── .gitignore                          # Exclude: data.db, storage/exports/, node_modules/
├── .gitattributes                      # Git LFS for *.png, *.jpg, *.glb, *.gltf
├── .gitkeep                            # Preserve empty directories
├── next.config.ts                      # serverExternalPackages: ['better-sqlite3']
├── tsconfig.json                       # baseUrl: ".", paths: { "@/*": ["./*"] }
├── package.json                        # "dev:worker": "tsx worker.ts"
├── worker.ts                           # Background worker (tsx, ESM, cross-platform lock)
├── setup.sh / setup.bat                # One-click installer (checks git remote)
├── README.md                           # Vercel warning + usage
│
├── data/                               # Git-synced JSON (UUID-based)
│   ├── styles/
│   │   ├── .gitkeep
│   │   └── style-{uuid}.json
│   └── assets/
│       ├── .gitkeep
│       └── asset-{uuid}.json
│
├── storage/
│   ├── images/                         # PNGs (Git LFS) - filename only
│   │   ├── .gitkeep
│   │   └── mock-*.png
│   └── exports/                        # Excluded from Git
│
├── app/
│   ├── api/
│   │   ├── images/[filename]/route.ts  # Streams /storage/images/{filename} (force-dynamic)
│   │   ├── jobs/
│   │   │   ├── [id]/route.ts           # GET, DELETE (shared safety helper)
│   │   │   ├── active/route.ts         # GET bulk (force-dynamic, 5-min window)
│   │   │   └── retry/route.ts          # POST (shared safety helper, result_path = null)
│   │   ├── assets/
│   │   │   ├── route.ts                # GET (force-dynamic, pagination), POST
│   │   │   ├── from-job/route.ts       # POST (Zod validation, idempotency, null check, ZodError handling)
│   │   │   └── [id]/route.ts           # GET, PUT, DELETE (soft delete)
│   │   ├── styles/                     # CRUD + fork (force-dynamic on GET)
│   │   ├── generate/route.ts           # POST create job
│   │   ├── git/
│   │   │   ├── pull/route.ts           # git pull --no-rebase, cleanup before staging
│   │   │   ├── push/route.ts           # --atomic + upstream detection + unborn HEAD, cleanup before staging
│   │   │   ├── abort/route.ts          # git merge --abort
│   │   │   └── resolve/route.ts        # Conflict resolution (validate → stage → commit → import)
│   │   ├── export/route.ts             # POST to Godot (mkdir before copy)
│   │   └── context/route.ts            # GET modular context
│   ├── dashboard/                      # Full UI
│   │   ├── generate/page.tsx           # Single usePolling -> /api/jobs/active
│   │   ├── jobs/page.tsx               # "Promote to Asset" + "Discard" + "Retry"
│   │   ├── settings/storage.tsx        # "Clean Up Orphaned Images" button
│   │   └── ...
│   └── components/
│       └── AssetCard.tsx               # img src={`/api/images/${asset.image_path}`}
│
├── lib/
│   ├── database/
│   │   ├── index.ts                    # globalThis binding + auto-migrations, paths via getProjectRoot()
│   │   ├── schema.ts                   # Zod schemas
│   │   └── migrations/
│   │       ├── 001_init.sql
│   │       ├── 002_add_is_deleted_to_assets.sql
│   │       ├── 003_add_options_to_jobs.sql
│   │       └── 004_add_unique_constraint_on_assets.sql
│   ├── services/
│   │   ├── GitService.ts               # staging, pull/push, conflict validate-then-resolve
│   │   ├── AssetService.ts             # cleanupOrphanedImages(), getActiveAssets()
│   │   ├── StyleService.ts             # fork (blank canvas)
│   │   ├── shared/
│   │   │   └── assetSafety.ts          # isImageReferencedByAsset(), deleteFileIfSafe(), deleteFileIfSafeSync()
│   │   └── ...
│   ├── store/useJobStore.ts            # refreshActive()
│   ├── hooks/usePolling.ts
│   └── utils/
│       └── projectRoot.ts              # getProjectRoot() with globalThis binding
│
├── AGENTS.md                           # Universal AI config + strict directives
├── CLAUDE.md                           # Symlink
└── .cursorrules                        # Symlink
```

---

## Key Code Patterns

### 1. Database Connection (Auto-Migrations + Transactional + getProjectRoot)

```typescript
// lib/database/index.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

const globalForDb = globalThis as unknown as { db: Database.Database | undefined };

export class DatabaseConnection {
  static getInstance(): Database.Database {
    if (!globalForDb.db) {
      // ✅ v5.5: absolute path via getProjectRoot(), not a bare relative
      // path resolved against process.cwd() — guarantees the Next.js
      // server and worker.ts process open the exact same physical file.
      const dbPath = path.join(getProjectRoot(), 'data.db');
      const db = new Database(dbPath);

      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');

      this.runMigrations(db);

      globalForDb.db = db;
    }
    return globalForDb.db;
  }

  private static runMigrations(db: Database.Database): void {
    // ✅ v5.5: getProjectRoot() here too, for the same reason.
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
```

### 2. Migration 004 (Safe Dedup + Unique Index)

```sql
-- lib/database/migrations/004_add_unique_constraint_on_assets.sql

-- Step 1: Remove duplicates, keeping one row per image_path.
-- ✅ NULL image_path rows are NEVER eligible for deletion (outer guard).
-- ✅ Active rows (is_deleted = 0) win ties over soft-deleted rows.
-- ✅ Among rows with the same is_deleted value, the earliest created_at wins.
DELETE FROM assets
WHERE image_path IS NOT NULL
AND id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY image_path
      ORDER BY is_deleted ASC, created_at ASC
    ) AS rn
    FROM assets
    WHERE image_path IS NOT NULL
  ) WHERE rn = 1
);

-- Step 2: Now safe to enforce uniqueness going forward.
CREATE UNIQUE INDEX idx_assets_image_path ON assets(image_path);
```

### 3. Git Pull (`--no-rebase`, cleanup, scoped staging)

```typescript
// lib/services/GitService.ts - pull()
async pull(): Promise<SyncResult> {
  await this.ensureDirectoriesExist();
  await this.exportToJson();

  // ✅ v5.5: same cleanup step push() already had, now mirrored here.
  // Keeps local disk hygiene consistent regardless of which sync
  // direction the user happens to trigger first.
  const removed = await assetService.cleanupOrphanedImages();
  if (removed > 0) console.log(`🧹 Removed ${removed} orphaned images.`);

  const status = await this.git.status();
  if (status.files && status.files.length > 0) {
    await this.stageFilesForCommit();
    try {
      await this.git.commit('Local changes (pre-pull save)');
    } catch (e: any) {
      if (!e.message.includes('nothing to commit')) throw e;
    }
  }

  // ✅ Explicit --no-rebase prevents a global `pull.rebase = true`
  // config from silently changing this app's merge strategy.
  await this.git.pull({ '--no-rebase': true });

  await this.importFromJson();
  return { success: true };
}
```

### 4. Git Push (`--atomic`, unborn HEAD, upstream detection, cleanup)

```typescript
// lib/services/GitService.ts - push()
async push(): Promise<SyncResult> {
  try {
    const styles = await styleService.getAll();
    const assets = await assetService.getAll();
    if (styles.length === 0 && assets.length === 0) {
      return {
        success: false,
        error: 'SAFETY_STOP',
        message: '⚠️ Safety stop: You have no styles or assets.'
      };
    }

    await this.exportToJson();

    const removed = await assetService.cleanupOrphanedImages();
    if (removed > 0) console.log(`🧹 Removed ${removed} orphaned images.`);

    await this.stageFilesForCommit();

    const status = await this.git.status();
    if (status.files && status.files.length > 0) {
      try {
        await this.git.commit('Sync from GameForge');
      } catch (e: any) {
        if (!e.message.includes('nothing to commit')) throw e;
      }
    }

    // Distinguish "genuine git error" from "just no commits yet."
    let isUnborn = false;
    try {
      await this.git.raw(['rev-parse', '--is-inside-work-tree']);
      const headExists = await this.git.raw(['rev-parse', 'HEAD'])
        .then(() => true).catch(() => false);
      isUnborn = !headExists;
    } catch (error: any) {
      return { success: false, error: 'GIT_ERROR', message: error.message };
    }

    const branches = await this.git.branch();
    const currentBranch = branches.current;

    if (isUnborn) {
      await this.git.push(['--set-upstream', 'origin', currentBranch, '--atomic']);
    } else {
      const upstream = await this.git.raw(['rev-parse', '--abbrev-ref', `${currentBranch}@{upstream}`])
        .catch(() => null);

      if (!upstream) {
        await this.git.push(['--set-upstream', 'origin', currentBranch, '--atomic']);
      } else {
        await this.git.push(['--atomic']);
      }
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: 'PUSH_FAILED', message: error.message };
  }
}
```

### 5. Git Staging Helper (chunked, existence-checked, scoped to `data/` + active-asset images)

```typescript
// lib/services/GitService.ts - stageFilesForCommit()
private async stageFilesForCommit(): Promise<void> {
  await this.git.add('data/');

  const activeAssets = await assetService.getActiveAssets();
  const validImages: string[] = [];

  const chunks: typeof activeAssets[] = [];
  for (let i = 0; i < activeAssets.length; i += IO_WRITE_BATCH_SIZE) {
    chunks.push(activeAssets.slice(i, i + IO_WRITE_BATCH_SIZE));
  }

  for (const chunk of chunks) {
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
    await this.git.add(chunk);
  }

  await this.git.add('.gitattributes');
}
```

### 6. Conflict Marker Detection (shared regex, used by both import and resolve)

```typescript
// lib/services/GitService.ts - shared constant
const CONFLICT_MARKER_REGEX = /^<<<<<<<|^=======$|^>>>>>>>/m;
```

```typescript
// lib/services/GitService.ts - importFromJson()
async importFromJson(): Promise<void> {
  for (const dir of ['data/styles', 'data/assets']) {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name);

    for (const file of files) {
      const content = await fsPromises.readFile(`${dir}/${file}`, 'utf-8');
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${dir}/${file}. Please resolve manually.`);
      }
      const data = JSON.parse(content);
      // ... UPSERT logic
    }
  }
}
```

### 7. Conflict Resolution — validate *before* committing (v5.5 fix)

```typescript
// lib/services/GitService.ts - resolveConflicts()
async resolveConflicts(): Promise<void> {
  // ✅ v5.5: check for leftover conflict markers BEFORE staging or
  // committing anything. Previously this only ran inside
  // importFromJson(), which meant a bad resolution got committed to
  // git history first and only discovered afterward — relying on
  // `git reset --merge ORIG_HEAD` to undo a commit that should never
  // have been made. Now nothing gets committed unless it's clean.
  await this.assertNoConflictMarkers();

  await this.stageFilesForCommit();

  try {
    await this.git.commit('Resolved merge conflicts');
  } catch (e: any) {
    if (!e.message.includes('nothing to commit')) throw e;
  }

  // Defense-in-depth only at this point: assertNoConflictMarkers()
  // already validated file contents above, so importFromJson()
  // failing here means a genuine DB-level problem (e.g. a JSON
  // structural error that isn't a merge-conflict marker), not a
  // marker slipping through. Still safe to roll back if it happens.
  try {
    await this.importFromJson();
  } catch (importError) {
    await this.git.reset(['--merge', 'ORIG_HEAD']);
    throw new Error('Merge completed but database sync failed. Rolled back.');
  }
}

private async assertNoConflictMarkers(): Promise<void> {
  for (const dir of ['data/styles', 'data/assets']) {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));

    for (const entry of files) {
      const filePath = `${dir}/${entry.name}`;
      const content = await fsPromises.readFile(filePath, 'utf-8');
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(
          `Unresolved conflict markers found in ${filePath}. Please resolve manually before committing.`
        );
      }
    }
  }
}
```

```typescript
// app/api/git/resolve/route.ts  (v5.5: added — referenced since v5.4, never shown)
import { NextResponse } from 'next/server';
import { gitService } from '@/lib/services/GitService';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await gitService.resolveConflicts();
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

### 8. `cleanupOrphanedImages()` — implemented (v5.5, previously never shown)

```typescript
// lib/services/AssetService.ts
import { DatabaseConnection } from '@/lib/database';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import fsPromises from 'fs/promises';
import path from 'path';

/**
 * Removes physical files in storage/images/ that are no longer needed.
 *
 * An image is PROTECTED (never deleted) if it is referenced by:
 *  - any asset row, active OR soft-deleted — soft-deleted assets must
 *    stay recoverable, image included, until permanently pruned by
 *    some future explicit "empty trash" action (not this function).
 *  - any job with status IN ('pending', 'processing', 'complete') —
 *    i.e. anything the user hasn't yet promoted or discarded. A
 *    'complete' job the user simply hasn't looked at yet is not
 *    orphaned; it's awaiting a decision.
 *
 * Everything else in storage/images/ is deleted. Returns the count
 * of files removed.
 */
export async function cleanupOrphanedImages(): Promise<number> {
  const db = DatabaseConnection.getInstance();
  const imagesDir = path.join(getProjectRoot(), 'storage', 'images');

  let filenames: string[];
  try {
    filenames = (await fsPromises.readdir(imagesDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
      .map(entry => entry.name);
  } catch (e) {
    console.error('Failed to read storage/images for cleanup:', e);
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

  let removed = 0;
  for (const filename of filenames) {
    if (assetPaths.has(filename) || activeJobPaths.has(filename)) continue;

    const filePath = path.join(imagesDir, filename);
    try {
      await fsPromises.unlink(filePath);
      removed++;
    } catch (e) {
      console.error(`Failed to remove orphaned image ${filename}:`, e);
    }
  }

  return removed;
}
```

### 9. Shared Asset Safety Helpers

```typescript
// lib/services/shared/assetSafety.ts
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

```typescript
// app/api/jobs/[id]/route.ts - DELETE, using the shared helper
import { isImageReferencedByAsset } from '@/lib/services/shared/assetSafety';

if (job.result_path && !isImageReferencedByAsset(job.result_path)) {
  const physicalPath = path.join(getProjectRoot(), 'storage', 'images', job.result_path);
  try {
    await fs.unlink(physicalPath);
  } catch (e) {
    console.error(`Failed to delete ${job.result_path}:`, e);
  }
}
```

### 10. Worker Atomic Claim (`RETURNING`, no re-fetch)

```typescript
// worker.ts
async function processJobs(): Promise<void> {
  const claimed = db.prepare(`
    UPDATE jobs
    SET status = 'processing', updated_at = ?
    WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' LIMIT ?)
    RETURNING *
  `).all(Date.now(), BATCH_SIZE);

  if (claimed.length === 0) return;

  const results = await Promise.allSettled(
    claimed.map((job: any) => processJob(job.id))
  );
  // ... handle results
}
```

### 11. MockGenerator (correct `AbortError` classification)

```typescript
// lib/services/ImageGenerator.ts - MockGenerator
export class MockGenerator implements ImageGenerator {
  async generate(prompt: string, styleId: string, options?: GenerateOptions): Promise<GeneratedImage> {
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Timeout', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        resolve({
          path: `mock-${Date.now()}.png`,
          prompt,
          metadata: { width: 64, height: 64, format: 'png' }
        });
      }, 2000);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Timeout', 'AbortError'));
        });
      }
    });
  }
}
```

### 12. Project Root Helper

```typescript
// lib/utils/projectRoot.ts
import path from 'path';
import fs from 'fs';

const globalForRoot = globalThis as unknown as {
  projectRoot: string | undefined;
  projectRootVerified: boolean | undefined;
};

export function getProjectRoot(): string {
  if (!globalForRoot.projectRoot) {
    let dir = __dirname;
    while (dir !== path.parse(dir).root) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        globalForRoot.projectRoot = dir;
        break;
      }
      dir = path.dirname(dir);
    }
    if (!globalForRoot.projectRoot) {
      globalForRoot.projectRoot = process.cwd();
    }
    if (!fs.existsSync(path.join(globalForRoot.projectRoot, 'package.json'))) {
      console.warn(`⚠️ Project root not found, falling back to cwd`);
      globalForRoot.projectRoot = process.cwd();
    }
  }
  if (!globalForRoot.projectRootVerified) {
    console.log(`📁 Project root: ${globalForRoot.projectRoot}`);
    globalForRoot.projectRootVerified = true;
  }
  return globalForRoot.projectRoot;
}
```

### 13. Promotion Endpoint (Zod + null check + `ZodError` handling)

```typescript
// app/api/assets/from-job/route.ts
import { z, ZodError } from 'zod';
import { DatabaseConnection } from '@/lib/database';

const PromoteSchema = z.object({ jobId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId } = PromoteSchema.parse(body);

    const db = DatabaseConnection.getInstance();
    const result = db.transaction(() => {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
      if (!job || job.status !== 'complete' || !job.result_path) {
        return { success: false, error: 'Job not complete or missing result path' };
      }

      const existing = db.prepare('SELECT * FROM assets WHERE image_path = ?').get(job.result_path);
      if (existing) {
        return { success: true, asset: existing, alreadyExists: true };
      }

      const assetId = crypto.randomUUID();
      db.prepare(`INSERT INTO assets (...) VALUES (...)`)
        .run(assetId, job.style_id, job.created_by, job.asset_type, job.prompt, job.result_path, Date.now());

      db.prepare('UPDATE jobs SET status = "promoted", updated_at = ? WHERE id = ?')
        .run(Date.now(), jobId);

      return { success: true, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) };
    })();

    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

### 14. Pagination on `/api/assets` (bounded + validated)

```typescript
// app/api/assets/route.ts
import { z } from 'zod';
import { DatabaseConnection } from '@/lib/database';

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const params = PaginationSchema.parse({
    limit: searchParams.get('limit') || '50',
    offset: searchParams.get('offset') || '0'
  });

  const db = DatabaseConnection.getInstance();
  const assets = db.prepare(`
    SELECT * FROM assets WHERE is_deleted = 0
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(params.limit, params.offset);

  return NextResponse.json({ success: true, data: assets });
}
```

---

## AGENTS.md (Strict AI Directives)

```markdown
# AGENTS.md - GameForge AI Directives

## STRICT RULES FOR AI CODE GENERATION

### FORBIDDEN
- ❌ Wrapper classes around existing services
- ❌ DTOs (use Zod schemas directly)
- ❌ Factory patterns
- ❌ Repository patterns (use DataStore directly)
- ❌ Custom error classes (use standard Error)
- ❌ Utility libraries (lodash, ramda, etc.)
- ❌ Storing URLs in the database (store filenames only)
- ❌ Aliasing a single fs import to serve both sync and async calls —
  when a file needs both, import them under distinct names:
  `import fs from 'fs'` and `import fsPromises from 'fs/promises'`

### REQUIRED
- ✅ Flat, procedural logic over deep nesting
- ✅ Direct SQL queries over ORM
- ✅ Direct Zod validation over DTOs
- ✅ `try/catch` for ALL file system operations, with logging on error
- ✅ `fs.mkdir(dir, { recursive: true })` before every file write
- ✅ `path.join(getProjectRoot(), ...)` for all physical paths
- ✅ Check `signal?.aborted` immediately in async generators
- ✅ Disable UI buttons on submission to prevent double-click
- ✅ Extract shared helpers for safety-critical logic on sight —
  not once it's been copy-pasted a certain number of times

### POSITIVE BEHAVIORAL MODEL
- ✅ **Flat over nested:** A 50-line route handler is BETTER than splitting across files.
- ✅ **Direct over abstracted:** Use direct SQL and direct Zod validation.
- ✅ **Simple over generic:** Write specific code that does exactly one thing well.
- ✅ **200-line guideline:** Not a rigid limit. Prefer readability over artificial fragmentation.
```

---

## The Final Development Checklist (v5.5)

### Phase 0: Foundation
- [ ] `next.config.ts` with `serverExternalPackages: ['better-sqlite3']`
- [ ] `tsconfig.json` with `baseUrl: "."` and `paths: { "@/*": ["./*"] }`
- [ ] `DatabaseConnection` with globalThis binding, auto-migrations, paths via `getProjectRoot()`
- [ ] Migration 001, 002, 003, 004 (safe NULL handling + active-row-priority dedup)
- [ ] `.gitkeep` files in `data/styles/`, `data/assets/`, `storage/images/`
- [ ] All Zod schemas defined
- [ ] `lib/utils/projectRoot.ts` with globalThis binding

### Phase 1: Core Services
- [ ] `worker.ts` with atomic `UPDATE ... RETURNING *`
- [ ] `worker.ts` MockGenerator uses `DOMException` for `AbortError`
- [ ] `worker.ts` cross-platform + project-specific lock file
- [ ] `worker.ts` extensionless imports, `tsx` execution
- [ ] `worker.ts` chunking from env, hard fails malformed JSON
- [ ] `GitService.stageFilesForCommit()` — chunked, existence-checked, scoped to `data/` + active-asset images
- [ ] `GitService.pull()` — cleanup, then scoped staging (not `git add '.'`)
- [ ] `GitService.push()` — cleanup, scoped staging, unborn HEAD + upstream detection, `--atomic`
- [ ] `GitService.push()`/`pull()` use `--no-rebase`
- [ ] `GitService.resolveConflicts()` — validates via `assertNoConflictMarkers()` BEFORE staging/committing
- [ ] `GitService.importFromJson()` — `withFileTypes` + `.isFile()`, line-anchored conflict-marker regex
- [ ] `GitService.abortMerge()` — no staging/commit side effects
- [ ] `app/api/git/resolve/route.ts` implemented
- [ ] `AssetService.cleanupOrphanedImages()` implemented — protects active + soft-deleted assets, and pending/processing/complete jobs
- [ ] Shared helpers (`isImageReferencedByAsset`, `deleteFileIfSafe`, `deleteFileIfSafeSync`) — correct `fs` vs `fsPromises` imports
- [ ] DELETE/Retry endpoints use shared helpers
- [ ] Promotion endpoint — Zod + null check + `ZodError` handling
- [ ] Unique constraint migration (004) — dedup with active-row priority
- [ ] Asset list pagination — bounded + Zod-validated
- [ ] `force-dynamic` on all GET routes
- [ ] `GodotExporter` — `path.join(getProjectRoot(), ...)` + `mkdir`

### Phase 2: UI & Dashboard
- [ ] Zustand stores work with bulk refresh
- [ ] Single polling hook → `GET /api/jobs/active`
- [ ] Promote button disables on click
- [ ] Discard/Retry use shared helpers
- [ ] New assets/styles appear immediately (`force-dynamic`)
- [ ] Settings → Storage → "Clean Up Orphaned Images" button (calls `cleanupOrphanedImages()` directly, on demand)

### Phase 3: Polish & Testing
- [ ] Vitest: migration 004 (null survival + dedup + active-row priority)
- [ ] Vitest: `resolveConflicts()` refuses to commit when markers are present
- [ ] Vitest: `cleanupOrphanedImages()` protects soft-deleted assets and in-flight jobs, removes true orphans
- [ ] Vitest: first-push / unborn HEAD / upstream detection
- [ ] Vitest: promotion idempotency + null-path rejection
- [ ] CI pipeline runs tests + linting
- [ ] Setup script verifies git remote
- [ ] README.md complete (Vercel warning included)
- [ ] AGENTS.md complete

---

## Status

Ready to build against, with one thing worth doing before treating this as final: run the actual Vitest suite (not just read it) against the two new/changed behaviors — `resolveConflicts()`'s validate-before-commit ordering, and `cleanupOrphanedImages()`'s protection rules — since both are new code that hasn't been exercised against a real SQLite file or a real git merge conflict yet. Everything in this document is a design-level review; it isn't a substitute for running it.
