# Live Theme Tweaking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user tweak any of a theme job's 8 tokens in a dedicated detail page during the review step, with edits saving immediately and a "Reset to original" safety net, before promoting or discarding the candidate.

**Architecture:** Two new sibling API routes under `app/api/jobs/[id]/theme/` (a `PATCH` that validates and persists an edit, capturing the AI's original tokens into `jobs.options` on the very first edit; a `POST .../reset` that restores from that capture) plus one new detail page and a small `JobCard` addition. No schema changes — `jobs.options` (an existing free-form JSON column) gains one new key, read/written with the same `JSON.parse(job.options)` pattern already used elsewhere in this codebase (e.g. `JobCard.tsx`'s `hasPieces` check, the split page's `options.pieces` read).

**Tech Stack:** Next.js API routes (existing pattern), Vitest (existing pattern: temp SQLite via `setProjectRootForTests`, real temp files), React client components (existing pattern: `'use client'`, `use()` for the `params` promise, matching `app/dashboard/jobs/[id]/split/page.tsx`).

**Spec:** `docs/superpowers/specs/2026-09-06-live-theme-tweaking-design.md`

## Global Constraints

- All 8 `ThemeTokens` fields are tweakable — colors, fonts, spacing, radius.
- Edits save immediately (debounced), overwriting the job's own CSS file in place — no draft/save-button step.
- Editing is only available for a theme job in `complete` status — not yet promoted, not yet discarded.
- No schema changes. The AI's original tokens are captured into the existing `jobs.options` JSON column, never a second physical file (a sidecar file would be silently deleted by `AssetService.ts`'s `cleanupOrphanedIn()`, which only protects filenames matching an asset's `image_path` or an active job's `result_path`).
- `originalTokens` is written to `options` once, on the first edit only, and never overwritten afterward.

---

## Context for the implementer

**The existing `ThemeTokens` shape and serialization** (`lib/services/ThemeGenerator.ts`, read directly, current as of this planning session):

```typescript
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

export function tokensToCss(tokens: ThemeTokens): string { /* writes a :root { --color-bg: ...; ... } block */ }
export function parseThemeCss(css: string): ThemeTokens { /* the exact reverse, throws if a --custom-property is missing or a value fails ThemeTokensSchema */ }
```

**The existing `jobs` schema and services** (read directly, current as of this planning session):
- `lib/database/schema.ts`'s `JobSchema`: `id, style_id, created_by, asset_type, prompt, status, result_path, created_at, updated_at, options, output_kind, batch_id`. `options: z.string()` — a free-form JSON blob, no fixed shape enforced.
- `JobStatusSchema = z.enum(['pending', 'processing', 'complete', 'promoted', 'discarded', 'failed'])`.
- `lib/services/JobService.ts`: `getById(id): Promise<Job | null>` — no method exists for updating `options` or `result_path` on an arbitrary job. Per this codebase's established convention (see `app/api/generate/route.ts`'s direct `UPDATE jobs SET batch_id = ?` and `AGENTS.md`'s "direct SQL over ORM" rule), the new routes below do a direct SQL `UPDATE` rather than adding a new service method for a single call site.
- `app/api/jobs/[id]/route.ts` already has a working `GET` returning `{ success: true, data: job }` — the new edit page reuses this directly, no new GET route needed.
- The existing `options` JSON read pattern, copied verbatim from `app/components/JobCard.tsx`'s `hasPieces` check:
  ```typescript
  try {
    const pieces = JSON.parse(job.options).pieces;
    return Array.isArray(pieces) && pieces.length > 0;
  } catch {
    return false;
  }
  ```
  The new routes below read/write `options` the same way — `JSON.parse`/`JSON.stringify` with a try/catch, no shared helper (this pattern already appears at 2 existing call sites without one; introducing a new abstraction now would be an unrelated refactor).

**The existing detail-page pattern** (`app/dashboard/jobs/[id]/split/page.tsx`, read directly — this is the template the new edit page follows):
```typescript
'use client';
import { useEffect, useState, use as usePromise } from 'react';
import type { Job } from '@/lib/database/schema';

export default function SplitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    let ignore = false;
    (async () => {
      const res = await fetch(`/api/jobs/${id}`);
      const body = await res.json();
      if (ignore || !body.success) return;
      setJob(body.data);
    })();
    return () => { ignore = true; };
  }, [id]);
  if (!job) return <p className="page-subtitle">Loading…</p>;
  // ...
}
```
The `ignore`-flag pattern guards against React StrictMode's dev-mode double-invoke of this effect writing stale state after a re-mount — same reasoning as this file's own comment explains.

**The theme preview iframe pattern**, copied verbatim from `app/components/JobCard.tsx`:
```typescript
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';
// ...
<iframe
  srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}`)}
  title={`Theme preview: ${job.prompt}`}
  sandbox=""
  style={{ width: 260, height: 180, border: 'none' }}
/>
```

**Path-traversal guard convention**, applied consistently across every route that joins a DB-sourced filename into a physical path (`app/api/jobs/[id]/similarity/route.ts`, `app/api/assets/[id]/contrast/route.ts`, `app/api/assets/[id]/export/route.ts`, `lib/services/ClaudeApiThemeGenerator.ts`):
```typescript
if (resultPath.includes('/') || resultPath.includes('\\') || resultPath.includes('..')) {
  // reject or skip, per that call site's own error-handling shape
}
```

---

### Task 1: `PATCH /api/jobs/[id]/theme`

**Files:**
- Create: `app/api/jobs/[id]/theme/route.ts`
- Test: `test/jobThemeEditRoute.test.ts`

**Interfaces:**
- Consumes: `jobService.getById` (existing), `ThemeTokensSchema`/`tokensToCss`/`parseThemeCss` (existing, `lib/services/ThemeGenerator.ts`), `getProjectRoot` (existing, `lib/utils/projectRoot`), `DatabaseConnection` (existing, `lib/database`).
- Produces: nothing consumed by later tasks by import — Task 3 only references this route's URL.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/jobThemeEditRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { tokensToCss, parseThemeCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { PATCH } from '@/app/api/jobs/[id]/theme/route';

let tempRoot: string;

const ORIGINAL: ThemeTokens = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
  fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
};
const EDITED: ThemeTokens = { ...ORIGINAL, colorAccent: '#2c7be5', spaceUnit: '10px' };

async function makeCompleteThemeJob(): Promise<{ jobId: string; filename: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `job-${crypto.randomUUID()}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(ORIGINAL));
  const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
  DatabaseConnection.getInstance()
    .prepare("UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?")
    .run(filename, job.id);
  return { jobId: job.id, filename };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobthemeedit-'));
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

function patchRequest(tokens: ThemeTokens): NextRequest {
  return new NextRequest('http://localhost/api/jobs/x/theme', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
  });
}

describe('PATCH /api/jobs/[id]/theme', () => {
  it('persists a valid edit to the job\'s CSS file and returns the new tokens', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(EDITED);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(EDITED);
  });

  it('captures the original tokens into jobs.options on the first edit only', async () => {
    const { jobId } = await makeCompleteThemeJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });

    const jobAfterFirst = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterFirst!.options).originalTokens).toEqual(ORIGINAL);

    // A second edit must not overwrite the already-captured original.
    const SECOND_EDIT = { ...EDITED, colorBackground: '#000000' };
    await PATCH(patchRequest(SECOND_EDIT), { params: Promise.resolve({ id: jobId }) });
    const jobAfterSecond = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterSecond!.options).originalTokens).toEqual(ORIGINAL);
  });

  it('rejects an invalid token value with 400 and does not touch the file', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    const invalid = { ...EDITED, colorAccent: 'javascript:alert(1)' };
    const res = await PATCH(patchRequest(invalid as ThemeTokens), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(400);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(ORIGINAL);
  });

  it('rejects with 409 when the job is not in complete status', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
    // Still 'pending' — never marked complete.
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- jobThemeEditRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/jobs/[id]/theme/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/jobs/[id]/theme/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { ThemeTokensSchema, tokensToCss, parseThemeCss } from '@/lib/services/ThemeGenerator';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }
    if (job.status !== 'complete') {
      return NextResponse.json({ success: false, error: 'Only a completed job can be edited' }, { status: 409 });
    }
    // A 'complete' theme job always has a result_path (the worker sets it
    // when marking the job complete) — a missing one here would mean the
    // job's own invariant is already broken, not something this route can
    // recover from gracefully.
    if (!job.result_path) {
      return NextResponse.json({ success: false, error: 'Job has no result file' }, { status: 500 });
    }
    if (job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const tokens = ThemeTokensSchema.parse(await req.json());
    const filePath = path.join(getProjectRoot(), 'storage', 'themes', job.result_path);

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }

    if (options.originalTokens === undefined) {
      const currentCss = await fsPromises.readFile(filePath, 'utf-8');
      const currentTokens = parseThemeCss(currentCss);
      options = { ...options, originalTokens: currentTokens };
      DatabaseConnection.getInstance()
        .prepare('UPDATE jobs SET options = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(options), Date.now(), id);
    }

    await fsPromises.writeFile(filePath, tokensToCss(tokens));

    return NextResponse.json({ success: true, data: tokens });
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

Run: `npm test -- jobThemeEditRoute.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/jobs/\[id\]/theme/route.ts test/jobThemeEditRoute.test.ts
git commit -m "feat: add PATCH route for live theme editing"
```

---

### Task 2: `POST /api/jobs/[id]/theme/reset`

**Files:**
- Create: `app/api/jobs/[id]/theme/reset/route.ts`
- Test: `test/jobThemeResetRoute.test.ts`

**Interfaces:**
- Consumes: `jobService.getById` (existing), `tokensToCss` (existing), `getProjectRoot` (existing).
- Produces: nothing consumed by later tasks by import — Task 3 only references this route's URL.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/jobThemeResetRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { tokensToCss, parseThemeCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { PATCH } from '@/app/api/jobs/[id]/theme/route';
import { POST } from '@/app/api/jobs/[id]/theme/reset/route';

let tempRoot: string;

const ORIGINAL: ThemeTokens = {
  colorBackground: '#1c1a17', colorForeground: '#ede7dc', colorAccent: '#e8a33d', colorBorder: '#3c352a',
  fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
};
const EDITED: ThemeTokens = { ...ORIGINAL, colorAccent: '#2c7be5' };

async function makeCompleteThemeJob(): Promise<{ jobId: string; filename: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `job-${crypto.randomUUID()}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(ORIGINAL));
  const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme' });
  DatabaseConnection.getInstance()
    .prepare("UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?")
    .run(filename, job.id);
  return { jobId: job.id, filename };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobthemereset-'));
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

function patchRequest(tokens: ThemeTokens): NextRequest {
  return new NextRequest('http://localhost/api/jobs/x/theme', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
  });
}

describe('POST /api/jobs/[id]/theme/reset', () => {
  it('restores the file to the original tokens after an edit', async () => {
    const { jobId, filename } = await makeCompleteThemeJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });

    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(ORIGINAL);

    const css = await fsPromises.readFile(path.join(tempRoot, 'storage', 'themes', filename), 'utf-8');
    expect(parseThemeCss(css)).toEqual(ORIGINAL);
  });

  it('returns 404 when the job has never been edited (no originalTokens captured)', async () => {
    const { jobId } = await makeCompleteThemeJob();
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- jobThemeResetRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/jobs/[id]/theme/reset/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/jobs/[id]/theme/reset/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { ThemeTokensSchema, tokensToCss } from '@/lib/services/ThemeGenerator';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }
    if (options.originalTokens === undefined) {
      return NextResponse.json({ success: false, error: 'This job has never been edited' }, { status: 404 });
    }
    if (!job.result_path || job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const originalTokens = ThemeTokensSchema.parse(options.originalTokens);
    const filePath = path.join(getProjectRoot(), 'storage', 'themes', job.result_path);
    await fsPromises.writeFile(filePath, tokensToCss(originalTokens));

    return NextResponse.json({ success: true, data: originalTokens });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- jobThemeResetRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/jobs/\[id\]/theme/reset/route.ts test/jobThemeResetRoute.test.ts
git commit -m "feat: add reset-to-original route for theme editing"
```

---

### Task 3: Edit page and `JobCard` link

**Files:**
- Create: `app/dashboard/jobs/[id]/edit/page.tsx`
- Modify: `app/components/JobCard.tsx`

**Interfaces:**
- Consumes: `GET /api/jobs/[id]` (existing route, referenced by URL only), `PATCH /api/jobs/[id]/theme` and `POST /api/jobs/[id]/theme/reset` (Tasks 1-2, referenced by URL only), `ThemeTokens` type (existing, `lib/services/ThemeGenerator.ts`), `buildThemePreviewHtml` (existing, `lib/utils/themePreview`).
- Produces: nothing consumed by later tasks — this is the final task.

This task has no automated test — this codebase has no component-testing infrastructure (confirmed during earlier planning this session: zero `.test.tsx` files, no `@testing-library/react`), matching the established convention from the dedup/multi-candidate feature's own final UI task. Verify manually per Step 3 below.

- [ ] **Step 1: Create the edit page**

```typescript
// app/dashboard/jobs/[id]/edit/page.tsx
'use client';

import { useEffect, useRef, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Job } from '@/lib/database/schema';
import { parseThemeCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

const FIELDS: { key: keyof ThemeTokens; label: string }[] = [
  { key: 'colorBackground', label: 'Background color' },
  { key: 'colorForeground', label: 'Foreground color' },
  { key: 'colorAccent', label: 'Accent color' },
  { key: 'colorBorder', label: 'Border color' },
  { key: 'fontHeading', label: 'Heading font' },
  { key: 'fontBody', label: 'Body font' },
  { key: 'spaceUnit', label: 'Space unit' },
  { key: 'radiusBase', label: 'Border radius' },
];

const DEBOUNCE_MS = 400;

export default function EditThemePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [tokens, setTokens] = useState<ThemeTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const res = await fetch(`/api/jobs/${id}`);
      const body = await res.json();
      if (ignore || !body.success) return;
      setJob(body.data);
      try {
        const css = await (await fetch(`/api/themes/${body.data.result_path}`)).text();
        setTokens(parseThemeCss(css));
      } catch {
        setError('Could not read this theme\'s current values.');
      }
    })();
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function handleFieldChange(key: keyof ThemeTokens, value: string) {
    if (!tokens) return;
    const next = { ...tokens, [key]: value };
    setTokens(next);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => savePatch(next), DEBOUNCE_MS);
  }

  async function savePatch(next: ThemeTokens) {
    try {
      const res = await fetch(`/api/jobs/${id}/theme`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const body = await res.json();
      if (!body.success) setError(body.error ?? 'Could not save that change.');
    } catch {
      setError('Could not reach the server.');
    }
  }

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}/theme/reset`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not reset this theme.');
      } else {
        setTokens(body.data);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setResetting(false);
    }
  }

  if (!job || !tokens) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Edit theme</h1>
      <p className="page-subtitle">
        Changes save automatically. Use Reset to original if a tweak doesn&apos;t work out.
      </p>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <iframe
          srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}`)}
          title={`Theme preview: ${job.prompt}`}
          sandbox=""
          style={{ width: 480, height: 340, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />

        <div className="card" style={{ flex: 1, minWidth: 280 }}>
          {FIELDS.map(({ key, label }) => (
            <div className="field" key={key}>
              <label htmlFor={key}>{label}</label>
              <input
                id={key}
                value={tokens[key]}
                onChange={e => handleFieldChange(key, e.target.value)}
              />
            </div>
          ))}

          {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={handleReset} disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset to original'}
            </button>
            <button className="btn btn-primary" onClick={() => router.push('/dashboard/jobs')}>
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add the "Edit" link to `JobCard`**

In `app/components/JobCard.tsx`, add the import:

```typescript
import Link from 'next/link';
```

(Already imported — confirm, don't duplicate.) Add the edit link inside the existing actions `<div>`, right after the "Split into elements" link:

```tsx
            {hasPieces && job.result_path && (
              <Link href={`/dashboard/jobs/${job.id}/split`} className="btn">
                Split into elements
              </Link>
            )}
            {job.output_kind === 'theme' && job.status === 'complete' && (
              <Link href={`/dashboard/jobs/${job.id}/edit`} className="btn">
                Edit
              </Link>
            )}
```

- [ ] **Step 3: Manually verify the golden path**

1. Run `npm run dev` (or confirm the dev server is already running).
2. Generate a theme (mock generator is fine — no API key needed).
3. On `/dashboard/jobs`, confirm the completed theme job's card now shows an "Edit" link alongside Promote/Retry/Discard.
4. Click it, confirm the edit page loads with the live preview and all 8 fields pre-filled with the job's current values.
5. Change a color field, wait ~1 second, confirm no error appears. Refresh the page — confirm the change persisted (the preview and form both reflect the edited value, not the original).
6. Click "Reset to original" — confirm all 8 fields snap back to what the job originally generated, and the preview updates to match.
7. Make another edit, then go back to `/dashboard/jobs` and Promote the job — confirm the resulting asset's detail page shows the edited (not original) values, since promotion just points at the same file.
8. Confirm a job in `pending`/`processing`/`promoted`/`discarded`/`failed` status never shows an "Edit" link.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (all prior tests plus this feature's new tests, no regressions)

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/jobs/\[id\]/edit/page.tsx app/components/JobCard.tsx
git commit -m "feat: add live theme editing page and JobCard edit link"
```
