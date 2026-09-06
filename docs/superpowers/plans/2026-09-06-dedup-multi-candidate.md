# Dedup-Steering + Multi-Candidate Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user request 1, 3, or 5 theme candidates in one generation, each steered away from the Style Bible's existing colors up front, and badged at review time if it's still too close to something that already exists (a promoted asset or a sibling candidate from the same batch).

**Architecture:** A new nullable `batch_id` column groups jobs from one multi-candidate request. Two new pure functions (`hexToOklab`, `getThemeDistance`) implement real, independently-verified perceptual color-distance math. Generation gains an optional candidate count and steering context built from the Style Bible's existing promoted theme colors. A new sibling route computes an on-demand similarity badge at review time, checking both promoted assets and same-batch siblings — mirroring the existing Export Formats/Contrast Checking pattern of computing, never persisting, derived values.

**Tech Stack:** Next.js API routes (existing pattern), Vitest (existing pattern: temp SQLite via `setProjectRootForTests`, real temp files, `fetch` mocked only at the true external boundary).

**Spec:** `docs/superpowers/specs/2026-09-06-dedup-multi-candidate-design.md`

## Global Constraints

- Similarity is colors only (`colorBackground`/`colorForeground`/`colorAccent`/`colorBorder`) — never fonts, spacing, or radius.
- Comparison scope is the same Style Bible only — never cross-Style-Bible.
- Nothing is ever silently filtered or blocked — every candidate is shown; a badge is informational only and never prevents promotion.
- Upfront steering (in the generation prompt) only ever knows about already-promoted assets — it cannot and does not need to know about sibling candidates in the same batch, since those don't exist yet when generation starts.
- The review-time similarity check covers BOTH promoted assets of the same style AND sibling jobs sharing the same `batch_id` — these are two different, complementary checks, not one.
- One new database column (`jobs.batch_id`, nullable) — no other schema changes.
- The exact "too similar" distance threshold must be set by empirical calibration against real theme data (method specified in Task 3), never invented from scratch.

---

## Context for the implementer

This codebase forbids wrapper classes, factory patterns, DTOs, and utility libraries (see `AGENTS.md` at the repo root) — write flat, direct, procedural code.

**The verified reverse OKLab math** (confirmed directly against Björn Ottosson's own page — bottosson.github.io/posts/oklab/ — during planning; this is a genuinely separate, independently-published function from the forward direction already shipped in the Seed Theme Library feature, not a hand-derived matrix inverse):

```
Step 1 — linear sRGB (0-1) to LMS:
  l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b
  m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b
  s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b

Step 2 — LMS to LMS' (cube root):
  l' = cbrt(l), m' = cbrt(m), s' = cbrt(s)

Step 3 — LMS' to Oklab:
  L = 0.2104542553*l' + 0.7936177850*m' - 0.0040720468*s'
  a = 1.9779984951*l' - 2.4285922050*m' + 0.4505937099*s'
  b = 0.0259040371*l' + 0.7827717662*m' - 0.8086757660*s'
```

This needs the SAME gamma-decoding step (gamma-encoded sRGB → linear sRGB) already verified and shipped in the Contrast Checking feature's `lib/services/contrastChecker.ts`:
```typescript
function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}
```

Two properties of this pipeline are algebraically provable (used as anchor tests in Task 2):
- For any achromatic gray (r=g=b=k in linear sRGB), the three Step-1 rows each sum to exactly 1.0 (e.g. `0.4122214708+0.5363325363+0.0514459929 = 1.0000000000`), so `l=m=s=k` and `l'=m'=s'=cbrt(k)`. The `a` row's coefficients then sum to exactly 0 (`1.9779984951-2.4285922050+0.4505937099 = 0.0000000000`), and the `b` row sums to ≈0 (`0.0259040371+0.7827717662-0.8086757660 = 0.0000000373`, a tiny floating-point residual). So **any gray color must produce `a≈0, b≈0`** — this is the real, hand-derivable sanity check.
- Converting a color to OKLab and back through the already-shipped forward pipeline (`lib/services/seedThemes/oklch.ts`'s `oklchToHex`, which itself is fed by an Oklab-to-linear-sRGB step) should recover the original color within a small tolerance — a genuine round-trip test, not a tautology, since the forward and reverse directions are independently-sourced code.

**Real, already-confirmed token sets for calibration and testing** (do not re-fetch or re-derive these — they are already verified real data from this codebase and its history):
```typescript
// lib/services/ThemeGenerator.ts's own FIXED_MOCK_TOKENS
const MOCK = { colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a' };
// Bootswatch Flatly, confirmed via direct fetch of its real compiled CSS
const FLATLY = { colorBackground: '#fff', colorForeground: '#212529', colorAccent: '#2c3e50', colorBorder: '#dee2e6' };
// DaisyUI light theme, confirmed via direct fetch + independent culori cross-check
const DAISYUI_LIGHT = { colorBackground: '#ffffff', colorForeground: '#1f2937', colorAccent: '#00d7c0', colorBorder: '#a3a3a3' };
```
Note: `DAISYUI_LIGHT.colorBorder` above (`#a3a3a3`) is a placeholder mid-gray, NOT independently verified like the other three fields in this object — do not treat it as confirmed real data. Use `MOCK` and `FLATLY` (both fully real and fully confirmed in every field) as the two "clearly different, real, designer-made themes" anchor for calibration in Task 3; only use `DAISYUI_LIGHT` for fields explicitly marked confirmed above if useful, never its border value.

**The existing `assets`/`jobs` schema and services** (read directly, current as of this planning session):
- `lib/database/schema.ts`: `JobSchema` has `id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind` — no `batch_id` yet (Task 1 adds it).
- `lib/services/JobService.ts`: `create(input: { styleId, createdBy, assetType, prompt, options?, outputKind? }): Promise<Job>`, `getById(id): Promise<Job | null>`, `getActive(): Promise<Job[]>`.
- `lib/services/AssetService.ts`: `getById(id): Promise<Asset | null>`, `getActiveAssets(): Promise<Asset[]>` — no per-style-filtered query yet (Task 4 adds one).
- `app/api/generate/route.ts`: `POST` body is `{ styleId, createdBy, assetType, prompt, options?, outputKind? }`, calls `jobService.create(input)` directly and returns `{ success: true, data: job }` (a single job).
- `lib/services/ClaudeApiThemeGenerator.ts`: `generate(prompt: string, styleId: string): Promise<GeneratedTheme>` — internally calls `styleService.getById(styleId)` then `buildThemePrompt(style?.parameters ?? '{}', prompt)` from `lib/services/ThemeGenerator.ts`.
- `lib/services/ThemeGenerator.ts`: `parseThemeCss(css: string): ThemeTokens` (already shipped, reverses `tokensToCss`) and `buildThemePrompt(styleParameters: string, jobPrompt: string): string`.
- `app/components/JobCard.tsx`: a plain function component (no `'use client'`, no hooks) rendering one `Job`.

---

### Task 1: `batch_id` migration

**Files:**
- Create: `lib/database/migrations/009_add_batch_id_to_jobs.sql`
- Modify: `lib/database/schema.ts` (add `batch_id` to `JobSchema`)
- Test: `test/migration-009.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `jobs.batch_id` column (nullable TEXT), `JobSchema`'s `batch_id: z.string().uuid().nullable()` field — Task 5 (job creation) and Task 6 (similarity route) both read/write this.

- [ ] **Step 1: Write the failing test**

```typescript
// test/migration-009.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration009-'));
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

describe('migration 009: batch_id on jobs', () => {
  it('adds a nullable batch_id column, defaulting to NULL for existing rows', () => {
    const db = DatabaseConnection.getInstance();
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as { name: string; notnull: number }[];
    const batchIdCol = columns.find(c => c.name === 'batch_id');
    expect(batchIdCol).toBeDefined();
    expect(batchIdCol!.notnull).toBe(0);
  });

  it('lets a job be inserted with a real batch_id and with NULL', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'x', 'user-1', '{}', 0, 1000, 1000)
    `).run();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'user-1', 'theme', 'x', 'pending', NULL, 1000, 1000, '{}', 'theme', '33333333-3333-3333-3333-333333333333')
    `).run();
    db.prepare(`
      INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id)
      VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'user-1', 'theme', 'x', 'pending', NULL, 1000, 1000, '{}', 'theme', NULL)
    `).run();
    const rows = db.prepare('SELECT id, batch_id FROM jobs ORDER BY id').all() as { id: string; batch_id: string | null }[];
    expect(rows).toEqual([
      { id: '22222222-2222-2222-2222-222222222222', batch_id: '33333333-3333-3333-3333-333333333333' },
      { id: '44444444-4444-4444-4444-444444444444', batch_id: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migration-009.test.ts`
Expected: FAIL — `no such column: batch_id` (migration 009 doesn't exist yet)

- [ ] **Step 3: Write the migration**

```sql
-- lib/database/migrations/009_add_batch_id_to_jobs.sql

ALTER TABLE jobs ADD COLUMN batch_id TEXT;
```

- [ ] **Step 4: Update `JobSchema`**

In `lib/database/schema.ts`, find the `JobSchema` definition and add `batch_id` after `output_kind`:

```typescript
export const JobSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  created_by: z.string().min(1),
  asset_type: z.string().min(1),
  prompt: z.string().min(1),
  status: JobStatusSchema,
  result_path: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  options: z.string(),
  output_kind: OutputKindSchema.default('image'),
  batch_id: z.string().uuid().nullable().default(null),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- migration-009.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/database/migrations/009_add_batch_id_to_jobs.sql lib/database/schema.ts test/migration-009.test.ts
git commit -m "feat: add batch_id column to jobs for multi-candidate grouping"
```

---

### Task 2: `hexToOklab` — the verified reverse OKLab conversion

**Files:**
- Create: `lib/services/oklabDistance.ts`
- Test: `test/oklabDistance.test.ts`

**Interfaces:**
- Consumes: nothing (pure math, standalone).
- Produces: `hexToOklab(hex: string): { L: number; a: number; b: number }` — Task 3 imports and calls this.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/oklabDistance.test.ts
import { describe, it, expect } from 'vitest';
import { hexToOklab } from '@/lib/services/oklabDistance';

describe('hexToOklab', () => {
  it('produces a≈0 and b≈0 for any gray color, regardless of lightness', () => {
    const darkGray = hexToOklab('#333333');
    const midGray = hexToOklab('#808080');
    const lightGray = hexToOklab('#cccccc');
    for (const { a, b } of [darkGray, midGray, lightGray]) {
      expect(a).toBeCloseTo(0, 3);
      expect(b).toBeCloseTo(0, 3);
    }
    // Lightness must still increase with the gray value.
    expect(darkGray.L).toBeLessThan(midGray.L);
    expect(midGray.L).toBeLessThan(lightGray.L);
  });

  it('produces L=0 for black and L=1 for white', () => {
    expect(hexToOklab('#000000').L).toBeCloseTo(0, 5);
    expect(hexToOklab('#ffffff').L).toBeCloseTo(1, 5);
  });

  it('round-trips through the existing forward OKLCh pipeline within a small tolerance', () => {
    // oklchToHex(76.76, 0.184, 183.61) is already verified (Seed Theme
    // Library feature) to produce '#00d7c0'. Converting that hex back to
    // Oklab and checking its lightness matches the original L (0.7676)
    // is a genuine round-trip check against independently-sourced code,
    // not a tautology — hexToOklab never calls oklchToHex or vice versa.
    const { oklchToHex } = require('@/lib/services/seedThemes/oklch');
    const hex = oklchToHex(76.76, 0.184, 183.61);
    const lab = hexToOklab(hex);
    expect(lab.L).toBeCloseTo(0.7676, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- oklabDistance.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/oklabDistance'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/oklabDistance.ts

// Verified against Björn Ottosson's own page (bottosson.github.io/posts/oklab/)
// during planning — linear_srgb_to_oklab is a genuinely separate, independently
// published function from the forward (oklab_to_linear_srgb) direction already
// shipped in lib/services/seedThemes/oklch.ts, not a hand-derived matrix inverse.

function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function hexToOklab(hex: string): { L: number; a: number; b: number } {
  const clean = hex.replace('#', '');
  const r = linearizeChannel(parseInt(clean.slice(0, 2), 16) / 255);
  const g = linearizeChannel(parseInt(clean.slice(2, 4), 16) / 255);
  const b = linearizeChannel(parseInt(clean.slice(4, 6), 16) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- oklabDistance.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/oklabDistance.ts test/oklabDistance.test.ts
git commit -m "feat: add verified sRGB-to-Oklab conversion for theme similarity"
```

---

### Task 3: `getThemeDistance` and empirical threshold calibration

**Files:**
- Modify: `lib/services/oklabDistance.ts` (add to the same file — it's small and single-purpose, both functions are "Oklab-based distance math")
- Modify: `test/oklabDistance.test.ts`

**Interfaces:**
- Consumes: `hexToOklab` (Task 2, same file).
- Produces: `getThemeDistance(tokensA: ThemeTokens, tokensB: ThemeTokens): number` and `const SIMILARITY_THRESHOLD: number` — Task 6 imports and uses both.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to test/oklabDistance.test.ts
import { getThemeDistance, SIMILARITY_THRESHOLD } from '@/lib/services/oklabDistance';
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

const MOCK: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'> = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
};
const FLATLY: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'> = {
  colorBackground: '#fff', colorForeground: '#212529', colorAccent: '#2c3e50', colorBorder: '#dee2e6',
};

describe('getThemeDistance', () => {
  it('returns exactly 0 for a theme compared against itself', () => {
    expect(getThemeDistance(MOCK as ThemeTokens, MOCK as ThemeTokens)).toBeCloseTo(0, 8);
  });

  it('returns a large distance for two genuinely different, real, designer-made themes', () => {
    // MOCK (dark, warm, editorial) vs FLATLY (light, cool, corporate) —
    // two real, fully-confirmed, deliberately distinct palettes.
    const distance = getThemeDistance(MOCK as ThemeTokens, FLATLY as ThemeTokens);
    expect(distance).toBeGreaterThan(SIMILARITY_THRESHOLD);
  });

  it('flags a near-identical theme (one channel shifted by a tiny amount) as too similar', () => {
    const almostMock = { ...MOCK, colorAccent: '#e8a340' }; // #e8a33d shifted by 3 in the blue channel
    const distance = getThemeDistance(MOCK as ThemeTokens, almostMock as ThemeTokens);
    expect(distance).toBeLessThan(SIMILARITY_THRESHOLD);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- oklabDistance.test.ts`
Expected: FAIL — `getThemeDistance is not a function` / `SIMILARITY_THRESHOLD is not exported`

- [ ] **Step 3: Empirically calibrate the threshold — REQUIRED, do not skip**

Before writing the final implementation, write a throwaway script (in your scratch space, not committed) that:
1. Computes `getThemeDistance` (using the per-field-average logic from Step 4 below) between `MOCK` and `FLATLY` (two real, confirmed, deliberately different themes) and prints the result.
2. Computes it between `MOCK` and several synthetic near-copies of `MOCK` with one field shifted by a small amount (try shifting one hex channel by 1, 3, 5, and 10 out of 255) and prints each result.
3. Look at the gap between the "clearly different real themes" distance and the "near-copy" distances. Set `SIMILARITY_THRESHOLD` at a value that sits clearly below the real-themes distance and clearly above the near-copy distances — erring toward a LOWER threshold (fewer false positives, since an under-flagged near-duplicate is far less annoying than a false alarm on two themes that are actually meant to be different).

Record the actual numbers you observed in your task report — this is empirical calibration against real computed values, not a number invented in this plan document.

- [ ] **Step 4: Write the implementation**

```typescript
// Add to lib/services/oklabDistance.ts
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

function oklabEuclideanDistance(hexA: string, hexB: string): number {
  const a = hexToOklab(hexA);
  const b = hexToOklab(hexB);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

export function getThemeDistance(
  tokensA: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'>,
  tokensB: Pick<ThemeTokens, 'colorBackground' | 'colorForeground' | 'colorAccent' | 'colorBorder'>
): number {
  const fields = ['colorBackground', 'colorForeground', 'colorAccent', 'colorBorder'] as const;
  const total = fields.reduce((sum, field) => sum + oklabEuclideanDistance(tokensA[field], tokensB[field]), 0);
  return total / fields.length;
}

// Calibrated empirically during planning (see this task's Step 3) against
// real theme data (GameForge's own mock tokens vs. Bootswatch Flatly) and
// synthetic near-copies with a single color channel shifted slightly.
// REPLACE THIS VALUE with what your own Step 3 calibration actually found —
// do not ship the literal number below without having run that calibration
// yourself, since it depends on real computed output this plan cannot
// pre-compute reliably by hand.
export const SIMILARITY_THRESHOLD = 0.02;
```

- [ ] **Step 5: Run tests to verify they pass, adjusting `SIMILARITY_THRESHOLD` from your Step 3 findings if needed**

Run: `npm test -- oklabDistance.test.ts`
Expected: PASS (6 tests). If the near-identical test fails, your calibrated threshold is too low — raise it based on your Step 3 data, not by guessing.

- [ ] **Step 6: Commit**

```bash
git add lib/services/oklabDistance.ts test/oklabDistance.test.ts
git commit -m "feat: add theme distance scoring with empirically calibrated threshold"
```

---

### Task 4: Per-style promoted-theme query and same-batch job query

**Files:**
- Modify: `lib/services/AssetService.ts` (add one method)
- Modify: `lib/services/JobService.ts` (add one method)
- Test: `test/dedupQueries.test.ts`

**Interfaces:**
- Consumes: existing `DatabaseConnection`, `AssetSchema`, `JobSchema`.
- Produces: `assetService.getActiveThemeAssetsForStyle(styleId: string): Promise<Asset[]>` and `jobService.getByBatchId(batchId: string): Promise<Job[]>` — Task 5 and Task 6 both call these.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/dedupQueries.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-dedupqueries-'));
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

describe('assetService.getActiveThemeAssetsForStyle', () => {
  it('returns only active theme assets for the given style, excluding other styles and non-theme assets', async () => {
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });

    const themeA = await assetService.create({ styleId: styleA.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'a.css', outputKind: 'theme' });
    await assetService.create({ styleId: styleA.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'a.png', outputKind: 'image' });
    await assetService.create({ styleId: styleB.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'b.css', outputKind: 'theme' });

    const result = await assetService.getActiveThemeAssetsForStyle(styleA.id);
    expect(result.map(a => a.id)).toEqual([themeA.id]);
  });

  it('excludes soft-deleted theme assets', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const theme = await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'x.css', outputKind: 'theme' });
    await assetService.softDelete(theme.id);
    const result = await assetService.getActiveThemeAssetsForStyle(style.id);
    expect(result).toEqual([]);
  });
});

describe('jobService.getByBatchId', () => {
  it('returns only jobs sharing the given batch_id', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    const batchId = '33333333-3333-3333-3333-333333333333';

    const jobInBatch = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    db.prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchId, jobInBatch.id);

    const jobOutsideBatch = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });

    const result = await jobService.getByBatchId(batchId);
    expect(result.map(j => j.id)).toEqual([jobInBatch.id]);
    expect(result.map(j => j.id)).not.toContain(jobOutsideBatch.id);
  });

  it('returns an empty array for a batch_id with no matching jobs', async () => {
    const result = await jobService.getByBatchId('00000000-0000-0000-0000-000000000000');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dedupQueries.test.ts`
Expected: FAIL — `assetService.getActiveThemeAssetsForStyle is not a function`

- [ ] **Step 3: Write the implementations**

In `lib/services/AssetService.ts`, add after `getActiveAssets()`:

```typescript
  /** Active theme assets for one style — used for dedup comparison, scoped to that style's own aesthetic. */
  async getActiveThemeAssetsForStyle(styleId: string): Promise<Asset[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      `SELECT * FROM assets WHERE style_id = ? AND output_kind = 'theme' AND is_deleted = 0 ORDER BY created_at DESC`
    ).all(styleId);
    return rows.map(row => AssetSchema.parse(row));
  }
```

In `lib/services/JobService.ts`, add after `getActive()`:

```typescript
  /** Jobs sharing one multi-candidate batch — used for dedup comparison between sibling candidates. */
  async getByBatchId(batchId: string): Promise<Job[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM jobs WHERE batch_id = ? ORDER BY created_at ASC').all(batchId);
    return rows.map(row => JobSchema.parse(row));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dedupQueries.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/AssetService.ts lib/services/JobService.ts test/dedupQueries.test.ts
git commit -m "feat: add per-style theme asset query and per-batch job query"
```

---

### Task 5: Multi-candidate generation with upfront steering

**Files:**
- Modify: `lib/services/ThemeGenerator.ts` (extend `buildThemePrompt`)
- Modify: `lib/services/ClaudeApiThemeGenerator.ts` (build and pass steering context)
- Modify: `app/api/generate/route.ts` (accept a candidate count, create N jobs sharing a `batch_id`)
- Test: `test/multiCandidateGeneration.test.ts`

**Interfaces:**
- Consumes: `assetService.getActiveThemeAssetsForStyle` (Task 4), `parseThemeCss` (existing), `jobService.create` (existing, called N times).
- Produces: `buildThemePrompt(styleParameters: string, jobPrompt: string, avoidColors?: string[]): string` (new optional third parameter) — nothing else consumes this outside this task. The route's new behavior (N jobs, shared `batch_id`) is consumed by Task 6's tests only as observable job data, not as a function call.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/multiCandidateGeneration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { buildThemePrompt } from '@/lib/services/ThemeGenerator';
import { POST } from '@/app/api/generate/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-multicandidate-'));
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

describe('buildThemePrompt with steering context', () => {
  it('includes avoid-colors context when provided', () => {
    const prompt = buildThemePrompt('{}', 'warm and cozy', ['#1c1a17', '#ede7dc']);
    expect(prompt).toContain('#1c1a17');
    expect(prompt).toContain('#ede7dc');
  });

  it('produces the same prompt as before when no avoid-colors are given (backward compatible)', () => {
    const withEmpty = buildThemePrompt('{}', 'warm and cozy', []);
    const withUndefined = buildThemePrompt('{}', 'warm and cozy');
    expect(withEmpty).toBe(withUndefined);
  });
});

describe('POST /api/generate with candidateCount', () => {
  it('creates 3 jobs sharing one batch_id when candidateCount is 3', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme', candidateCount: 3,
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    const batchIds = new Set(body.data.map((j: any) => j.batch_id));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).not.toBeNull();
  });

  it('creates exactly 1 job with batch_id null when candidateCount is omitted (backward compatible)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBeDefined();
    expect(body.data.batch_id).toBeNull();
  });

  it('rejects an invalid candidateCount', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme', candidateCount: 4 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- multiCandidateGeneration.test.ts`
Expected: FAIL — `buildThemePrompt` doesn't accept a third argument; the route ignores `candidateCount`

- [ ] **Step 3: Write the implementation**

In `lib/services/ThemeGenerator.ts`, find `buildThemePrompt` and replace it:

```typescript
export function buildThemePrompt(styleParameters: string, jobPrompt: string, avoidColors: string[] = []): string {
  const steering = avoidColors.length > 0
    ? `\n\nAvoid producing a palette close to these existing colors already used by this Style Bible: ${avoidColors.join(', ')}. Aim for a genuinely different combination.`
    : '';
  return `You are generating a website design token set (CSS custom properties only — colors, fonts, a base spacing unit, a base border radius). Match this aesthetic:

Style Bible parameters (JSON): ${styleParameters}

Additional direction for this generation: ${jobPrompt}${steering}

Respond by calling the emit_theme tool with concrete token values.`;
}
```

In `lib/services/ClaudeApiThemeGenerator.ts`, modify the `generate` method's prompt-building section:

```typescript
  async generate(prompt: string, styleId: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    const existingThemes = await assetService.getActiveThemeAssetsForStyle(styleId);
    const avoidColors: string[] = [];
    for (const asset of existingThemes.slice(0, 10)) {
      if (!asset.image_path) continue;
      try {
        const css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', asset.image_path), 'utf-8');
        const tokens = parseThemeCss(css);
        avoidColors.push(tokens.colorBackground, tokens.colorAccent);
      } catch {
        // A single unreadable/unparseable existing theme shouldn't block generation — steering is best-effort.
      }
    }
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt, avoidColors);
```

Add the new import at the top of the file: `import { assetService } from '@/lib/services/AssetService';`. Leave the rest of the method (the `fetch` call, response parsing, file writing) exactly as it already is — only the prompt-building lines change.

In `app/api/generate/route.ts`, modify the schema and handler:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';

export const dynamic = 'force-dynamic';

const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme']).optional(),
  candidateCount: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const input = GenerateSchema.parse(await req.json());

    if (input.outputKind === 'theme') {
      const pieces = (input.options as { pieces?: unknown } | undefined)?.pieces;
      if (Array.isArray(pieces) && pieces.length > 0) {
        return NextResponse.json({ success: false, error: 'Theme jobs cannot include UI-sheet options.' }, { status: 400 });
      }
    }

    const count = input.candidateCount ?? 1;
    if (count === 1) {
      const job = await jobService.create(input);
      return NextResponse.json({ success: true, data: job });
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const job = await jobService.create(input);
      DatabaseConnection.getInstance().prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchId, job.id);
      jobs.push({ ...job, batch_id: batchId });
    }
    return NextResponse.json({ success: true, data: jobs });
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

Note: `jobService.create()` doesn't take a `batchId` parameter (Task 4 didn't add one to keep that task's scope to queries only) — this route sets `batch_id` with a direct `UPDATE` immediately after each `create()` call instead of adding a new service method for this one call site. This is a deliberate, minimal-surface-area choice, consistent with AGENTS.md's "direct SQL over ORM/repository patterns" rule.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- multiCandidateGeneration.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions to existing theme generation**

Run: `npm test`
Expected: PASS (all prior tests, no regressions — `getThemeGeneratorSelection.test.ts` and other `ClaudeApiThemeGenerator` tests must still pass with the new `assetService` dependency; if any fail because they don't expect the new `getActiveThemeAssetsForStyle` call, that call must tolerate an empty result set gracefully, which it already does since `existingThemes` would just be `[]` and the loop simply doesn't execute)

- [ ] **Step 6: Commit**

```bash
git add lib/services/ThemeGenerator.ts lib/services/ClaudeApiThemeGenerator.ts app/api/generate/route.ts test/multiCandidateGeneration.test.ts
git commit -m "feat: support multi-candidate theme generation with upfront dedup steering"
```

---

### Task 6: Similarity API route

**Files:**
- Create: `app/api/jobs/[id]/similarity/route.ts`
- Test: `test/jobSimilarityRoute.test.ts`

**Interfaces:**
- Consumes: `getThemeDistance`, `SIMILARITY_THRESHOLD` (Task 3), `assetService.getActiveThemeAssetsForStyle` (Task 4), `jobService.getByBatchId` (Task 4), existing `jobService.getById`, existing `parseThemeCss`.
- Produces: nothing consumed by later tasks by import — Task 7 only references this route's URL.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/jobSimilarityRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';
import { tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { GET } from '@/app/api/jobs/[id]/similarity/route';

let tempRoot: string;

const MOCK: ThemeTokens = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
  fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
};
const ALMOST_MOCK: ThemeTokens = { ...MOCK, colorAccent: '#e8a340' };
const FLATLY: ThemeTokens = {
  colorBackground: '#fff', colorForeground: '#212529', colorAccent: '#2c3e50', colorBorder: '#dee2e6',
  fontHeading: "'Lato', sans-serif", fontBody: "'Lato', sans-serif", spaceUnit: '0.5rem', radiusBase: '0.375rem',
};

async function makeThemeJob(styleId: string, tokens: ThemeTokens, batchId: string | null): Promise<string> {
  const filename = `job-${crypto.randomUUID()}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(tokens));
  const job = await jobService.create({ styleId, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
  const db = DatabaseConnection.getInstance();
  db.prepare("UPDATE jobs SET status = 'complete', result_path = ?, batch_id = ? WHERE id = ?").run(filename, batchId, job.id);
  return job.id;
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobsimilarity-'));
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
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/jobs/[id]/similarity', () => {
  it('flags a candidate too similar to an already-promoted asset of the same style', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const promotedFilename = 'promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', promotedFilename), tokensToCss(MOCK));
    await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: promotedFilename, outputKind: 'theme' });

    const jobId = await makeThemeJob(style.id, ALMOST_MOCK, null);
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(true);
  });

  it('flags a candidate too similar to a sibling job in the same batch', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const batchId = '55555555-5555-5555-5555-555555555555';
    await makeThemeJob(style.id, MOCK, batchId);
    const siblingId = await makeThemeJob(style.id, ALMOST_MOCK, batchId);

    const req = new NextRequest(`http://localhost/api/jobs/${siblingId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: siblingId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(true);
  });

  it('does not flag a candidate that is genuinely different from everything else', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const promotedFilename = 'promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', promotedFilename), tokensToCss(MOCK));
    await assetService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: promotedFilename, outputKind: 'theme' });

    const jobId = await makeThemeJob(style.id, FLATLY, null);
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(false);
  });

  it('never flags a candidate against a DIFFERENT style\'s promoted assets', async () => {
    const styleA = await styleService.create({ name: 'A', createdBy: 'user-1', parameters: '{}' });
    const styleB = await styleService.create({ name: 'B', createdBy: 'user-1', parameters: '{}' });
    const promotedFilename = 'promoted.css';
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', promotedFilename), tokensToCss(MOCK));
    await assetService.create({ styleId: styleB.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: promotedFilename, outputKind: 'theme' });

    const jobId = await makeThemeJob(styleA.id, ALMOST_MOCK, null);
    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(false);
  });

  it('returns 404 for a nonexistent job', async () => {
    const req = new NextRequest('http://localhost/api/jobs/00000000-0000-0000-0000-000000000000/similarity');
    const res = await GET(req, { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns flagged:false (not an error) for a non-theme job', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', outputKind: 'image' });
    const req = new NextRequest(`http://localhost/api/jobs/${job.id}/similarity`);
    const res = await GET(req, { params: Promise.resolve({ id: job.id }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.flagged).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- jobSimilarityRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/jobs/[id]/similarity/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/jobs/[id]/similarity/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import { parseThemeCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { getThemeDistance, SIMILARITY_THRESHOLD } from '@/lib/services/oklabDistance';

export const dynamic = 'force-dynamic';

async function readThemeTokens(resultPath: string): Promise<ThemeTokens | null> {
  try {
    const css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', resultPath), 'utf-8');
    return parseThemeCss(css);
  } catch (e) {
    console.error(`Failed to read/parse theme file for similarity check: ${resultPath}`, e);
    return null;
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const job = await jobService.getById(id);
  if (!job) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
  }
  if (job.output_kind !== 'theme' || !job.result_path) {
    return NextResponse.json({ success: true, data: { flagged: false } });
  }

  const candidateTokens = await readThemeTokens(job.result_path);
  if (!candidateTokens) {
    return NextResponse.json({ success: true, data: { flagged: false } });
  }

  const promotedAssets = await assetService.getActiveThemeAssetsForStyle(job.style_id);
  for (const asset of promotedAssets) {
    if (!asset.image_path) continue;
    const tokens = await readThemeTokens(asset.image_path);
    if (!tokens) continue;
    if (getThemeDistance(candidateTokens, tokens) < SIMILARITY_THRESHOLD) {
      return NextResponse.json({ success: true, data: { flagged: true, similarTo: `existing asset "${asset.prompt}"` } });
    }
  }

  if (job.batch_id) {
    const siblings = await jobService.getByBatchId(job.batch_id);
    for (const sibling of siblings) {
      if (sibling.id === job.id || !sibling.result_path) continue;
      const tokens = await readThemeTokens(sibling.result_path);
      if (!tokens) continue;
      if (getThemeDistance(candidateTokens, tokens) < SIMILARITY_THRESHOLD) {
        return NextResponse.json({ success: true, data: { flagged: true, similarTo: 'another candidate in this batch' } });
      }
    }
  }

  return NextResponse.json({ success: true, data: { flagged: false } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- jobSimilarityRoute.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/jobs/\[id\]/similarity/route.ts test/jobSimilarityRoute.test.ts
git commit -m "feat: add job similarity API route for dedup badging"
```

---

### Task 7: Candidate-count selector and similarity badge in the UI

**Files:**
- Modify: `app/dashboard/themes/page.tsx` (add a candidate-count selector, send `candidateCount`)
- Modify: `app/components/JobCard.tsx` (becomes a client component, fetches and displays a similarity badge for theme jobs)

**Interfaces:**
- Consumes: the route from Task 6, referenced only by URL (`/api/jobs/${job.id}/similarity`) — no code import.
- Produces: nothing consumed by later tasks — this is the final task.

This task has no automated test — this codebase has no component-testing setup (confirmed during the Contrast Checking feature's planning: no `@testing-library/react`, zero `.test.tsx` files), matching the established convention. Verify manually per Step 3 below.

- [ ] **Step 1: Add the candidate-count selector to the Themes generation form**

In `app/dashboard/themes/page.tsx`, add a new state variable near the existing `prompt`/`submitting` state:

```typescript
  const [candidateCount, setCandidateCount] = useState<1 | 3 | 5>(3);
```

In `handleSubmit`, add `candidateCount` to the request body:

```typescript
        body: JSON.stringify({
          styleId: activeStyleId,
          createdBy: getClientId(),
          assetType: 'theme',
          prompt: prompt.trim(),
          outputKind: 'theme',
          candidateCount,
        }),
```

Add a selector in the form JSX, right after the prompt `<textarea>`'s closing `</div>`:

```tsx
          <div className="field">
            <label htmlFor="candidateCount">Candidates</label>
            <select
              id="candidateCount"
              value={candidateCount}
              onChange={e => setCandidateCount(Number(e.target.value) as 1 | 3 | 5)}
            >
              <option value={1}>1</option>
              <option value={3}>3 (recommended)</option>
              <option value={5}>5</option>
            </select>
          </div>
```

- [ ] **Step 2: Add the similarity badge to `JobCard`**

Replace the entire file `app/components/JobCard.tsx`:

```typescript
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Job } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

interface JobCardProps {
  job: Job;
  onPromote?: (jobId: string) => void;
  onDiscard?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
  busy?: boolean;
}

export function JobCard({ job, onPromote, onDiscard, onRetry, busy }: JobCardProps) {
  const canAct = job.status === 'complete' || job.status === 'failed';

  const hasPieces = (() => {
    try {
      const pieces = JSON.parse(job.options).pieces;
      return Array.isArray(pieces) && pieces.length > 0;
    } catch {
      return false;
    }
  })();

  const [similarity, setSimilarity] = useState<{ flagged: boolean; similarTo?: string } | null>(null);

  useEffect(() => {
    if (job.output_kind !== 'theme' || job.status !== 'complete') return;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}/similarity`);
        const body = await res.json();
        if (!ignore && body.success) setSimilarity(body.data);
      } catch {
        // Purely informational — a failed fetch just means no badge shows.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [job.id, job.output_kind, job.status]);

  return (
    <div className="card" style={{ display: 'flex', gap: 14 }}>
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

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="badge" data-status={job.status}>
            {job.status}
          </span>
          <span className="frame-label">{job.asset_type}</span>
          {similarity?.flagged && (
            <span className="badge" title={similarity.similarTo} style={{ color: 'var(--reject)' }}>
              Similar to {similarity.similarTo}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.prompt}
        </div>

        {(onPromote || onDiscard || onRetry) && (
          <div style={{ display: 'flex', gap: 8 }}>
            {hasPieces && job.result_path && (
              <Link href={`/dashboard/jobs/${job.id}/split`} className="btn">
                Split into elements
              </Link>
            )}
            {onPromote && (
              <button
                className="btn btn-keeper"
                disabled={!canAct || job.status !== 'complete' || busy}
                onClick={() => onPromote(job.id)}
              >
                Promote to Asset
              </button>
            )}
            {onRetry && (
              <button className="btn" disabled={!canAct || busy} onClick={() => onRetry(job.id)}>
                Retry
              </button>
            )}
            {onDiscard && (
              <button className="btn btn-reject" disabled={busy} onClick={() => onDiscard(job.id)}>
                Discard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Manually verify the golden path**

1. Run `npm run dev` (or confirm the dev server is already running).
2. Navigate to `/dashboard/themes`, pick a Style Bible that already has at least one promoted theme asset (or promote one first), and confirm a "Candidates" selector appears with 1/3/5 options, defaulting to 3.
3. Submit a generation with 3 candidates. Confirm 3 job cards appear in the live queue (this requires either a real Claude API key configured, or the mock generator — either way, 3 real job rows should be created and process through the queue).
4. Once complete, confirm each theme job card shows either no badge (genuinely different) or a "Similar to ..." badge naming either an existing asset or another candidate in the batch.
5. Confirm promoting a flagged candidate still works normally (the badge never disables the Promote button).
6. Submit a single (candidateCount=1) generation and confirm it behaves exactly as it did before this feature — one job, no batch grouping, and it still gets a similarity check against the style's promoted assets (with no batch-siblings to compare against, since it's alone).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (all prior tests plus this feature's new tests, no regressions)

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/themes/page.tsx app/components/JobCard.tsx
git commit -m "feat: add candidate-count selector and similarity badge to theme generation UI"
```
