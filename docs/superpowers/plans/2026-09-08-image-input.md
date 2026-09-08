# Image Input for Generation & Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach a reference image (screenshot/sketch) alongside a text prompt when generating a theme, component, or sprite — and, separately, regenerate an existing promoted asset with a new image/note describing a desired change, without ever mutating the original.

**Architecture:** A new `lib/services/referenceImage.ts` helper encapsulates save/load of an uploaded image under `storage/references/`. `/api/generate` gains two new optional top-level fields (`referenceImage`, `basedOnAssetId`) and writes the reference file before creating the job, storing only its filename (plus an optional Pixellab strength number) in the job's existing `options` JSON column — no schema/migration change. `worker.ts` resolves both at dispatch time (loads the reference image bytes; if `basedOnAssetId` is set, reads that asset's current stored content off disk) and passes them into whichever of the three generator classes handles the job. Each generator gains new optional parameters, not a new interface shape — real implementations use them, mocks accept and ignore them.

**Tech Stack:** Next.js 16 API routes, Zod, better-sqlite3 (unchanged schema), Claude Messages API (native image content blocks), Pixellab's `create-image-pixflux` `init_image` parameter, Vitest with real temp SQLite/filesystem (no mocks for services; `fetch` is mocked only where this codebase already mocks it, for the two Claude-API generator classes).

**Spec:** `docs/superpowers/specs/2026-09-08-image-input-design.md`

## Global Constraints

- No new database columns or migrations — reference image filename and Pixellab strength live inside the existing `jobs.options` JSON text column.
- Reference images are never git-synced (matches jobs themselves, already absent from `GitService.ts`'s `DATA_DIRS`).
- Every filesystem operation gets a try/catch with `console.error(...)` logging on failure, per `AGENTS.md`.
- Server-side validation is the real boundary for the uploaded image (size + MIME type) — client-side checks are UX-only, never trusted alone.
- All new/changed files follow this codebase's existing conventions exactly: `path.join(getProjectRoot(), ...)` for physical paths, `fs.mkdir(dir, { recursive: true })` before every write, filenames (not URLs) stored in the database, real temp SQLite + real temp files in tests (no mocking of this app's own services).

---

### Task 1: Reference image storage helper

**Files:**
- Create: `lib/services/referenceImage.ts`
- Test: `test/referenceImage.test.ts`

**Interfaces:**
- Produces: `ReferenceImagePayload` type (`{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }`), `saveReferenceImage(payload: ReferenceImagePayload): Promise<string>` (returns the saved filename), `loadReferenceImage(filename: string | undefined): Promise<ReferenceImagePayload | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/referenceImage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { saveReferenceImage, loadReferenceImage } from '@/lib/services/referenceImage';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-refimg-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('saveReferenceImage / loadReferenceImage', () => {
  it('round-trips a png payload through storage/references/', async () => {
    const original = { base64: Buffer.from('fake-png-bytes').toString('base64'), mediaType: 'image/png' as const };
    const filename = await saveReferenceImage(original);
    expect(filename).toMatch(/^reference-.*\.png$/);

    const filePath = path.join(tempRoot, 'storage', 'references', filename);
    const onDisk = await fsPromises.readFile(filePath);
    expect(onDisk.toString()).toBe('fake-png-bytes');

    const loaded = await loadReferenceImage(filename);
    expect(loaded).toEqual(original);
  });

  it('round-trips a jpeg payload with the correct extension', async () => {
    const original = { base64: Buffer.from('fake-jpeg-bytes').toString('base64'), mediaType: 'image/jpeg' as const };
    const filename = await saveReferenceImage(original);
    expect(filename).toMatch(/\.jpg$/);
    const loaded = await loadReferenceImage(filename);
    expect(loaded?.mediaType).toBe('image/jpeg');
  });

  it('returns null for an undefined filename', async () => {
    expect(await loadReferenceImage(undefined)).toBeNull();
  });

  it('returns null for a missing file instead of throwing', async () => {
    expect(await loadReferenceImage('reference-nonexistent.png')).toBeNull();
  });

  it('returns null and does not read the filesystem for a path-traversal filename', async () => {
    expect(await loadReferenceImage('../../etc/passwd')).toBeNull();
    expect(await loadReferenceImage('sub/dir.png')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/referenceImage.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/referenceImage'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/services/referenceImage.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export interface ReferenceImagePayload {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

const EXTENSION_FOR_MEDIA_TYPE: Record<ReferenceImagePayload['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MEDIA_TYPE_FOR_EXTENSION: Record<string, ReferenceImagePayload['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Saves a validated reference image under storage/references/ and returns
 * its filename. Named independently of any job id (matching every other
 * generator's own output-file naming convention, e.g. ClaudeApiThemeGenerator's
 * `theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`) — the caller
 * (the /api/generate route) doesn't yet know the job's id at the point it
 * needs to write this file, since JobService.create() mints that id itself.
 */
export async function saveReferenceImage(payload: ReferenceImagePayload): Promise<string> {
  const ext = EXTENSION_FOR_MEDIA_TYPE[payload.mediaType];
  const filename = `reference-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const dir = path.join(getProjectRoot(), 'storage', 'references');
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(path.join(dir, filename), Buffer.from(payload.base64, 'base64'));
  } catch (e) {
    console.error(`Failed to write reference image ${filename}:`, e);
    throw e;
  }
  return filename;
}

/**
 * Reads a reference image back off disk. Returns null (never throws) for an
 * unset filename, a missing file, or a filename that isn't a bare name —
 * `options` comes from the database, but this guards the same class of
 * defense-in-depth every other filename-from-DB read site in this codebase
 * already applies (e.g. ClaudeApiThemeGenerator.ts's dedup-steering loop).
 */
export async function loadReferenceImage(filename: string | undefined): Promise<ReferenceImagePayload | null> {
  if (!filename) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;

  const ext = filename.split('.').pop() ?? '';
  const mediaType = MEDIA_TYPE_FOR_EXTENSION[ext];
  if (!mediaType) return null;

  const filePath = path.join(getProjectRoot(), 'storage', 'references', filename);
  try {
    const buffer = await fsPromises.readFile(filePath);
    return { base64: buffer.toString('base64'), mediaType };
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    console.error(`Failed to read reference image ${filename}:`, e);
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/referenceImage.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/referenceImage.ts test/referenceImage.test.ts
git commit -m "feat: add reference image save/load helper"
```

---

### Task 2: Extend `/api/generate` to accept `referenceImage` and `basedOnAssetId`

**Files:**
- Modify: `app/api/generate/route.ts`
- Test: `test/generateRoute.test.ts` (new — no existing test file for this route)

**Interfaces:**
- Consumes: `saveReferenceImage` from Task 1 (`lib/services/referenceImage.ts`).
- Produces: `POST /api/generate` now accepts optional top-level `referenceImage: { base64, mediaType, referenceStrength? }` and `basedOnAssetId: string` (uuid) fields. A job's `options` JSON gains `referenceImageFilename?: string` and `referenceStrength?: number` when a reference image is supplied, and `basedOnAssetId?: string` when supplied — both consumed by `worker.ts` in Task 8.

- [ ] **Step 1: Write the failing test**

```ts
// test/generateRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { seedSession } from './helpers/testSession';
import { POST } from '@/app/api/generate/route';

let tempRoot: string;
let cookieHeader: string;
let styleId: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-generateroute-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();

  const seeded = await seedSession();
  cookieHeader = seeded.cookieHeader;
  const style = await styleService.create({ name: 'x', createdBy: seeded.userId, parameters: '{}' });
  styleId = style.id;
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

// Matches this codebase's real existing pattern (see test/pagesRoute.test.ts) -
// Cookie header, capital C, and seedSession()'s cookieHeader is already the
// full "session=<token>" string.
function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generate with referenceImage', () => {
  it('saves the reference image to storage/references/ and records its filename in options', async () => {
    const base64 = Buffer.from('fake-png-bytes').toString('base64');
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'a hero section',
      outputKind: 'component',
      referenceImage: { base64, mediaType: 'image/png' },
    }));
    const body = await res.json();
    expect(body.success).toBe(true);

    const options = JSON.parse(body.data.options);
    expect(options.referenceImageFilename).toMatch(/^reference-.*\.png$/);

    const savedPath = path.join(tempRoot, 'storage', 'references', options.referenceImageFilename);
    const saved = await fsPromises.readFile(savedPath);
    expect(saved.toString()).toBe('fake-png-bytes');
  });

  it('records referenceStrength in options when provided alongside the image', async () => {
    const base64 = Buffer.from('x').toString('base64');
    const res = await POST(req({
      styleId,
      assetType: 'sprite',
      prompt: 'a goblin',
      outputKind: 'image',
      referenceImage: { base64, mediaType: 'image/png', referenceStrength: 400 },
    }));
    const body = await res.json();
    const options = JSON.parse(body.data.options);
    expect(options.referenceStrength).toBe(400);
  });

  it('rejects an oversized base64 payload with a 400, never reaching the filesystem', async () => {
    const hugeBase64 = 'A'.repeat(11_000_000);
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'x',
      referenceImage: { base64: hugeBase64, mediaType: 'image/png' },
    }));
    expect(res.status).toBe(400);
    const referencesDir = path.join(tempRoot, 'storage', 'references');
    await expect(fsPromises.readdir(referencesDir)).rejects.toThrow();
  });

  it('rejects an unsupported mediaType with a 400', async () => {
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'x',
      referenceImage: { base64: Buffer.from('x').toString('base64'), mediaType: 'image/gif' },
    }));
    expect(res.status).toBe(400);
  });

  it('records basedOnAssetId in options when provided', async () => {
    const fakeAssetId = randomUUID();
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'make the button bigger',
      outputKind: 'component',
      basedOnAssetId: fakeAssetId,
    }));
    const body = await res.json();
    const options = JSON.parse(body.data.options);
    expect(options.basedOnAssetId).toBe(fakeAssetId);
  });

  it('creates a job with empty options when no referenceImage or basedOnAssetId is given (unchanged existing behavior)', async () => {
    const res = await POST(req({ styleId, assetType: 'sprite', prompt: 'a goblin' }));
    const body = await res.json();
    expect(JSON.parse(body.data.options)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/generateRoute.test.ts`
Expected: FAIL — `referenceImage`/`basedOnAssetId` unrecognized by `GenerateSchema`, `options.referenceImageFilename` undefined.

- [ ] **Step 3: Write the implementation**

```ts
// app/api/generate/route.ts — full replacement
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';
import { saveReferenceImage } from '@/lib/services/referenceImage';

export const dynamic = 'force-dynamic';

// A base64 string of 10,000,000 chars decodes to ~7.5MB of binary — generous
// for a single screenshot/photo reference, still bounded. Real ceiling, not
// a placeholder: rejects before saveReferenceImage() ever touches disk.
const MAX_REFERENCE_IMAGE_BASE64_LENGTH = 10_000_000;

const ReferenceImageSchema = z.object({
  base64: z.string().max(MAX_REFERENCE_IMAGE_BASE64_LENGTH),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  referenceStrength: z.number().min(0).max(900).optional(), // 0-900 matches Pixellab's documented init-image strength range
});

const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme', 'component']).optional(),
  candidateCount: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
  referenceImage: ReferenceImageSchema.optional(),
  basedOnAssetId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = GenerateSchema.parse(await req.json());

    if (input.outputKind === 'theme') {
      const pieces = (input.options as { pieces?: unknown } | undefined)?.pieces;
      if (Array.isArray(pieces) && pieces.length > 0) {
        return NextResponse.json({ success: false, error: 'Theme jobs cannot include UI-sheet options.' }, { status: 400 });
      }
    }

    if (input.outputKind === 'component' && input.candidateCount !== undefined && input.candidateCount !== 1) {
      return NextResponse.json({ success: false, error: 'Component jobs do not support multi-candidate generation.' }, { status: 400 });
    }

    let mergedOptions: Record<string, unknown> = { ...(input.options ?? {}) };
    if (input.referenceImage) {
      const filename = await saveReferenceImage({
        base64: input.referenceImage.base64,
        mediaType: input.referenceImage.mediaType,
      });
      mergedOptions.referenceImageFilename = filename;
      if (input.referenceImage.referenceStrength !== undefined) {
        mergedOptions.referenceStrength = input.referenceImage.referenceStrength;
      }
    }
    if (input.basedOnAssetId) {
      mergedOptions.basedOnAssetId = input.basedOnAssetId;
    }

    const jobInput = {
      styleId: input.styleId,
      assetType: input.assetType,
      prompt: input.prompt,
      outputKind: input.outputKind,
      options: mergedOptions,
      createdBy: user.id,
    };

    const count = input.candidateCount ?? 1;
    if (count === 1) {
      const job = await jobService.create(jobInput);
      return NextResponse.json({ success: true, data: job });
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const job = await jobService.create(jobInput);
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

Note: `jobInput` is now built explicitly (field-by-field) instead of `{ ...input, createdBy: user.id }` — the old spread would have carried the raw `referenceImage`/`basedOnAssetId`/top-level shape into `jobService.create()`, which only accepts `options` as a bag; building it explicitly keeps `JobService.create()`'s existing signature untouched (no changes needed to Task-adjacent files beyond this route).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/generateRoute.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/generate/route.ts test/generateRoute.test.ts
git commit -m "feat: accept referenceImage and basedOnAssetId on /api/generate"
```

---

### Task 3: New serving route for reference images

**Files:**
- Create: `app/api/references/[filename]/route.ts`
- Test: `test/referenceFileRoute.test.ts`

**Interfaces:**
- Produces: `GET /api/references/[filename]` — serves the raw image bytes with the correct `Content-Type`, matching the exact real pattern of `app/api/images/[filename]/route.ts` and `app/api/themes/[filename]/route.ts` (filename-sanitized, no auth check — confirmed by reading both directly, neither has one).

- [ ] **Step 1: Write the failing test**

```ts
// test/referenceFileRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { GET } from '@/app/api/references/[filename]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-refroute-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'references'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/references/[filename]', () => {
  it('serves a stored reference image as image/png', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', 'reference-1.png'), Buffer.from('fake-bytes'));
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-1.png' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('fake-bytes');
  });

  it('serves .jpg as image/jpeg and .webp as image/webp', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', 'reference-2.jpg'), Buffer.from('x'));
    const jpegRes = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-2.jpg' }) });
    expect(jpegRes.headers.get('Content-Type')).toBe('image/jpeg');

    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', 'reference-3.webp'), Buffer.from('x'));
    const webpRes = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-3.webp' }) });
    expect(webpRes.headers.get('Content-Type')).toBe('image/webp');
  });

  it('returns 404 for a missing file', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'reference-missing.png' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a path-traversal filename, never touching the filesystem', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: '../../etc/passwd' }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/referenceFileRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/references/[filename]/route'`

- [ ] **Step 3: Write the implementation**

```ts
// app/api/references/[filename]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export const dynamic = 'force-dynamic';

const CONTENT_TYPE_FOR_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Same guard as app/api/images/[filename]/route.ts and
  // app/api/themes/[filename]/route.ts — neither of those routes has an
  // auth check either (confirmed by reading both directly), this matches
  // that real existing pattern rather than inventing a stricter one.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const ext = filename.split('.').pop() ?? '';
  const contentType = CONTENT_TYPE_FOR_EXTENSION[ext];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Unsupported file type' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'references', filename);

  try {
    const data = await fsPromises.readFile(physicalPath);
    return new NextResponse(data, { headers: { 'Content-Type': contentType } });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Reference image not found' }, { status: 404 });
    }
    console.error(`Failed to read reference image ${filename}:`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/referenceFileRoute.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add "app/api/references/[filename]/route.ts" test/referenceFileRoute.test.ts
git commit -m "feat: add GET /api/references/[filename] serving route"
```

---

### Task 4: Orphan cleanup for reference images

**Files:**
- Modify: `lib/services/AssetService.ts`
- Modify: `lib/services/GitService.ts:207-212,245-250` (the two `removedImages/removedThemes/removedComponents` blocks in `pull()` and `push()`)
- Test: `test/assetServiceReferenceCleanup.test.ts`

**Interfaces:**
- Produces: `AssetService.cleanupOrphanedReferences(): Promise<number>`.

**Why this can't reuse `cleanupOrphanedIn()` as-is:** that method's protected-paths query reads `jobs.result_path` — the column used for GENERATED output. A reference image's filename lives inside `jobs.options` (a JSON blob) instead, since it's an INPUT the user supplied, not the job's result. This needs its own protected-paths query reading `json_extract(options, '$.referenceImageFilename')`, structured the same way as `cleanupOrphanedIn()` otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// test/assetServiceReferenceCleanup.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-refcleanup-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'references'), { recursive: true });
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

async function writeReferenceFile(filename: string) {
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'references', filename), 'x');
}

describe('AssetService.cleanupOrphanedReferences', () => {
  it('keeps a reference image belonging to a pending job', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'x',
      options: { referenceImageFilename: 'reference-a.png' },
    });
    await writeReferenceFile('reference-a.png');

    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(0);
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'references', 'reference-a.png'))).resolves.not.toThrow();
  });

  it('removes a reference image belonging to a failed job (matches every other job artifact\'s real existing behavior - failed jobs are never protected)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'hero', prompt: 'x',
      options: { referenceImageFilename: 'reference-b.png' },
    });
    DatabaseConnection.getInstance().prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(job.id);
    await writeReferenceFile('reference-b.png');

    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(1);
    await expect(fsPromises.access(path.join(tempRoot, 'storage', 'references', 'reference-b.png'))).rejects.toThrow();
  });

  it('removes a reference image with no matching job at all', async () => {
    await writeReferenceFile('reference-orphan.png');
    const removed = await assetService.cleanupOrphanedReferences();
    expect(removed).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assetServiceReferenceCleanup.test.ts`
Expected: FAIL — `assetService.cleanupOrphanedReferences is not a function`

- [ ] **Step 3: Write the implementation**

Add to `lib/services/AssetService.ts`, right after `cleanupOrphanedComponents()`:

```ts
  /**
   * Removes physical files in storage/references/ that are no longer
   * needed. Unlike cleanupOrphanedIn() (which protects via jobs.result_path,
   * the GENERATED-output column), a reference image's filename lives inside
   * jobs.options — it's an INPUT the user supplied, not a job's result — so
   * this needs its own protected-paths query reading that JSON field.
   */
  async cleanupOrphanedReferences(): Promise<number> {
    const db = DatabaseConnection.getInstance();
    const dir = path.join(getProjectRoot(), 'storage', 'references');

    let filenames: string[];
    try {
      filenames = (await fsPromises.readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
        .map(entry => entry.name);
    } catch (e) {
      console.error('Failed to read storage/references for cleanup:', e);
      return 0;
    }

    const activeReferencePaths = new Set(
      (db.prepare(`
        SELECT json_extract(options, '$.referenceImageFilename') AS filename FROM jobs
        WHERE json_extract(options, '$.referenceImageFilename') IS NOT NULL
        AND status IN ('pending', 'processing', 'complete')
      `).all() as { filename: string }[])
        .map(row => row.filename)
    );

    const orphans = filenames.filter(f => !activeReferencePaths.has(f));

    let removed = 0;
    for (let i = 0; i < orphans.length; i += IO_WRITE_BATCH_SIZE) {
      const chunk = orphans.slice(i, i + IO_WRITE_BATCH_SIZE);
      const results = await Promise.all(chunk.map(async (filename) => {
        const filePath = path.join(dir, filename);
        try {
          await fsPromises.unlink(filePath);
          return true;
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error(`Failed to remove orphaned reference image ${filename}:`, e);
          return false;
        }
      }));
      removed += results.filter(Boolean).length;
    }

    return removed;
  }
```

Then wire it into `lib/services/GitService.ts` alongside the other three cleanup calls (two call sites — `pull()` around line 207 and `push()` around line 245):

```ts
    const removedImages = await assetService.cleanupOrphanedImages();
    const removedThemes = await assetService.cleanupOrphanedThemes();
    const removedComponents = await assetService.cleanupOrphanedComponents();
    const removedReferences = await assetService.cleanupOrphanedReferences();
    if (removedImages > 0 || removedThemes > 0 || removedComponents > 0 || removedReferences > 0) {
      console.log(`🧹 Removed ${removedImages} orphaned images, ${removedThemes} orphaned themes, ${removedComponents} orphaned components, and ${removedReferences} orphaned reference images.`);
    }
```

(Apply this exact replacement at both the `pull()` and `push()` occurrences of this block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assetServiceReferenceCleanup.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/AssetService.ts lib/services/GitService.ts test/assetServiceReferenceCleanup.test.ts
git commit -m "feat: clean up orphaned reference images during git sync"
```

---

### Task 5: Reference image + regenerate-context support in `ClaudeApiThemeGenerator`

**Files:**
- Modify: `lib/services/ThemeGenerator.ts`
- Modify: `lib/services/ClaudeApiThemeGenerator.ts`
- Test: `test/themeGeneratorReferenceImage.test.ts`

**Interfaces:**
- Consumes: `ReferenceImagePayload` from Task 1.
- Produces: `ThemeGenerator.generate(prompt, styleId, referenceImage?, basedOnContent?)` — both new params optional, existing 2-arg call sites unaffected. `buildThemePrompt(styleParameters, jobPrompt, avoidColors?, basedOnContent?)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/themeGeneratorReferenceImage.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

let tempRoot: string;

function mockToolUseResponse() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 't1', name: 'emit_theme',
        input: {
          colorBackground: '#111', colorForeground: '#eee', colorAccent: '#f80', colorBorder: '#333',
          fontHeading: 'serif', fontBody: 'sans-serif', spaceUnit: '8px', radiusBase: '4px',
        },
      }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themerefimg-'));
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
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('ClaudeApiThemeGenerator with a reference image', () => {
  it('sends an image content block alongside the text prompt when a reference image is given', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('match this look', style.id, { base64: 'ZmFrZQ==', mediaType: 'image/png' });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const content = sentBody.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } });
    expect(content[1].type).toBe('text');
  });

  it('sends the prompt as a plain string (unchanged) when no reference image is given', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('a theme', style.id);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(typeof sentBody.messages[0].content).toBe('string');
  });

  it('includes basedOnContent in the prompt text when regenerating from an existing asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('make the accent brighter', style.id, undefined, ':root { --color-accent: #f80; }');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.messages[0].content).toContain('--color-accent: #f80');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/themeGeneratorReferenceImage.test.ts`
Expected: FAIL — extra arguments not accepted / content is always a string today.

- [ ] **Step 3: Write the implementation**

In `lib/services/ThemeGenerator.ts`, update the interface and `buildThemePrompt`:

```ts
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';

export interface ThemeGenerator {
  generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string): Promise<GeneratedTheme>;
}

export function buildThemePrompt(styleParameters: string, jobPrompt: string, avoidColors: string[] = [], basedOnContent?: string): string {
  const steering = avoidColors.length > 0
    ? `\n\nAvoid producing a palette close to these existing colors already used by this Style Bible: ${avoidColors.join(', ')}. Aim for a genuinely different combination.`
    : '';
  const basedOnSection = basedOnContent
    ? `\n\nHere is the current version's CSS, to use as your starting point for the requested change:\n${basedOnContent}`
    : '';
  return `You are generating a website design token set (CSS custom properties only — colors, fonts, a base spacing unit, a base border radius). Match this aesthetic:

Style Bible parameters (JSON): ${styleParameters}

Additional direction for this generation: ${jobPrompt}${steering}${basedOnSection}

Respond by calling the emit_theme tool with concrete token values.`;
}
```

And update `MockThemeGenerator.generate()`'s signature to match (body unchanged, it just ignores the new params):

```ts
export class MockThemeGenerator implements ThemeGenerator {
  async generate(prompt: string, _styleId: string, _referenceImage?: ReferenceImagePayload, _basedOnContent?: string): Promise<GeneratedTheme> {
    // ...unchanged body...
  }
}
```

In `lib/services/ClaudeApiThemeGenerator.ts`:

```ts
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';
// ...existing imports unchanged...

export class ClaudeApiThemeGenerator implements ThemeGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    // ...unchanged existingThemes/avoidColors block...
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt, avoidColors, basedOnContent);

    const content: string | Array<Record<string, unknown>> = referenceImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: referenceImage.mediaType, data: referenceImage.base64 } },
          { type: 'text', text: fullPrompt },
        ]
      : fullPrompt;

    const res = await fetch(this.provider.requestUrl, {
      method: 'POST',
      headers: {
        ...this.provider.buildAuthHeaders(this.apiKey),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.provider.model,
        max_tokens: 4096,
        tools: [
          {
            name: 'emit_theme',
            description: 'Emit a website design token set matching the requested aesthetic.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_theme' },
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // ...rest of the method unchanged...
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/themeGeneratorReferenceImage.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full existing theme generator test suite to confirm nothing broke**

Run: `npx vitest run test/themeGenerator.test.ts test/getThemeGeneratorSelection.test.ts`
Expected: PASS (all previously-passing tests still pass — the new params are optional and additive)

- [ ] **Step 6: Commit**

```bash
git add lib/services/ThemeGenerator.ts lib/services/ClaudeApiThemeGenerator.ts test/themeGeneratorReferenceImage.test.ts
git commit -m "feat: accept a reference image and regenerate-context in ThemeGenerator"
```

---

### Task 6: Reference image + regenerate-context support in `ClaudeApiComponentGenerator`

**Files:**
- Modify: `lib/services/ComponentGenerator.ts`
- Test: `test/componentGeneratorReferenceImage.test.ts`

**Interfaces:**
- Consumes: `ReferenceImagePayload` from Task 1.
- Produces: `ComponentGenerator.generate(prompt, styleId, componentType?, referenceImage?, basedOnContent?)`.

This task mirrors Task 5 exactly, applied to `ComponentGenerator.ts` instead of `ThemeGenerator.ts`/`ClaudeApiThemeGenerator.ts` (both real and mock classes live in the same file here).

- [ ] **Step 1: Write the failing test**

```ts
// test/componentGeneratorReferenceImage.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { ClaudeApiComponentGenerator } from '@/lib/services/ComponentGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';

let tempRoot: string;

function mockToolUseResponse() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 't1', name: 'emit_component',
        input: { html: '<button>Go</button>', css: '.x { color: red; }' },
      }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-componentrefimg-'));
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
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('ClaudeApiComponentGenerator with a reference image', () => {
  it('sends an image content block alongside the text prompt when a reference image is given', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('match this button', style.id, undefined, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const content = sentBody.messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' } });
  });

  it('includes basedOnContent in the prompt text when regenerating from an existing asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const fetchMock = mockToolUseResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    await generator.generate('make it bigger', style.id, undefined, undefined, '<button class="btn">Go</button>');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.messages[0].content).toContain('<button class="btn">Go</button>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/componentGeneratorReferenceImage.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

In `lib/services/ComponentGenerator.ts`:

```ts
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';
// ...existing imports unchanged...

function buildComponentPrompt(styleParameters: string, jobPrompt: string, componentType?: string, basedOnContent?: string): string {
  const typeHint = componentType ? `Component type: ${componentType}.\n\n` : '';
  const basedOnSection = basedOnContent
    ? `\n\nHere is the current version's HTML+CSS, to use as your starting point for the requested change:\n${basedOnContent}`
    : '';
  return `You are generating a single, reusable website UI component as plain HTML and CSS (no React, no JavaScript). ${typeHint}Style Bible parameters (JSON): ${styleParameters}

Description: ${jobPrompt}${basedOnSection}

Respond by calling the emit_component tool with the component's html and css.`;
}

export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string): Promise<GeneratedComponent>;
}

export class ClaudeApiComponentGenerator implements ComponentGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string): Promise<GeneratedComponent> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildComponentPrompt(style?.parameters ?? '{}', prompt, componentType, basedOnContent);

    const content: string | Array<Record<string, unknown>> = referenceImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: referenceImage.mediaType, data: referenceImage.base64 } },
          { type: 'text', text: fullPrompt },
        ]
      : fullPrompt;

    const res = await fetch(this.provider.requestUrl, {
      method: 'POST',
      headers: {
        ...this.provider.buildAuthHeaders(this.apiKey),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.provider.model,
        max_tokens: 4096,
        tools: [
          {
            name: 'emit_component',
            description: 'Emit a single website UI component as HTML and CSS.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_component' },
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // ...rest of the method unchanged...
  }
}
```

And `MockComponentGenerator.generate()`'s signature (body unchanged):

```ts
export class MockComponentGenerator implements ComponentGenerator {
  async generate(prompt: string, _styleId: string, _componentType?: string, _referenceImage?: ReferenceImagePayload, _basedOnContent?: string): Promise<GeneratedComponent> {
    // ...unchanged body...
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/componentGeneratorReferenceImage.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full existing component generator test suite to confirm nothing broke**

Run: `npx vitest run test/componentGenerator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/services/ComponentGenerator.ts test/componentGeneratorReferenceImage.test.ts
git commit -m "feat: accept a reference image and regenerate-context in ComponentGenerator"
```

---

### Task 7: Reference image + strength support in `PixellabGenerator`

**Files:**
- Modify: `lib/services/ThemeGenerator.ts` — no, this is wrong file; correct target below.
- Modify: `lib/services/ImageGenerator.ts` (the `GenerateOptions` interface lives here)
- Modify: `lib/services/PixellabGenerator.ts`
- Test: `test/pixellabGeneratorReferenceImage.test.ts`

**Interfaces:**
- Consumes: `ReferenceImagePayload` from Task 1.
- Produces: `GenerateOptions` gains `referenceImage?: ReferenceImagePayload` and `referenceStrength?: number`.

- [ ] **Step 1: Write the failing test**

```ts
// test/pixellabGeneratorReferenceImage.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { PixellabGenerator } from '@/lib/services/PixellabGenerator';

let tempRoot: string;

function mockPixfluxResponse() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ image: { type: 'base64', base64: Buffer.from('fake-png').toString('base64'), format: 'png' } }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-pixellabrefimg-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('PixellabGenerator with a reference image', () => {
  it('includes init_image and strength in the request body when a reference image is given', async () => {
    const fetchMock = mockPixfluxResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    await generator.generate('a goblin', 'style-1', {
      referenceImage: { base64: 'ZmFrZQ==', mediaType: 'image/png' },
      referenceStrength: 300,
    });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.init_image).toBeDefined();
    expect(sentBody.strength).toBe(300);
  });

  it('omits init_image entirely when no reference image is given (unchanged existing behavior)', async () => {
    const fetchMock = mockPixfluxResponse();
    vi.stubGlobal('fetch', fetchMock);

    const generator = new PixellabGenerator('fake-key');
    await generator.generate('a goblin', 'style-1');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.init_image).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pixellabGeneratorReferenceImage.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

In `lib/services/ImageGenerator.ts`:

```ts
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';

export interface GenerateOptions {
  signal?: AbortSignal;
  referenceImage?: ReferenceImagePayload;
  referenceStrength?: number;
}
```

In `lib/services/PixellabGenerator.ts`:

```ts
  async generate(prompt: string, styleId: string, options?: GenerateOptions & { width?: number; height?: number }): Promise<GeneratedImage> {
    const width = clampSize(options?.width);
    const height = clampSize(options?.height);

    const body: Record<string, unknown> = {
      description: prompt,
      image_size: { width, height },
      no_background: true,
    };
    // NOTE (matching this file's own header comment's precedent): the exact
    // init_image wire shape below is per Pixellab's public docs
    // (https://www.pixellab.ai/docs/options/init-image — "Supports init
    // images and forced palettes", strength range 0-900) but has NOT been
    // confirmed via a live test call the way the rest of this endpoint's
    // schema was. Before shipping, make one real create-image-pixflux call
    // with a reference image and inspect the actual accepted request/
    // response shape — adjust the field name/nesting below to match if it
    // differs, exactly as this file's existing docstring describes doing
    // for the base pixflux schema.
    if (options?.referenceImage) {
      body.init_image = { type: 'base64', base64: options.referenceImage.base64 };
      if (options.referenceStrength !== undefined) {
        body.strength = options.referenceStrength;
      }
    }

    const res = await fetch(`${API_BASE}/create-image-pixflux`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    // ...rest of the method unchanged...
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pixellabGeneratorReferenceImage.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/ImageGenerator.ts lib/services/PixellabGenerator.ts test/pixellabGeneratorReferenceImage.test.ts
git commit -m "feat: accept a reference image and strength in PixellabGenerator"
```

---

### Task 8: Wire the worker to load and pass reference images / regenerate context

**Files:**
- Modify: `worker.ts`
- Test: `test/workerReferenceImage.test.ts`

**Interfaces:**
- Consumes: `loadReferenceImage` (Task 1), the extended `generate()` signatures on all three generators (Tasks 5-7).

- [ ] **Step 1: Write the failing test**

```ts
// test/workerReferenceImage.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import { saveReferenceImage } from '@/lib/services/referenceImage';
import * as ThemeGeneratorModule from '@/lib/services/ThemeGenerator';
import { processJob } from '../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workerrefimg-'));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('processJob with a reference image', () => {
  it('loads the reference image off disk and passes it to the theme generator', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const filename = await saveReferenceImage({ base64: 'ZmFrZQ==', mediaType: 'image/png' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'match this',
      outputKind: 'theme', options: { referenceImageFilename: filename },
    });

    const generateSpy = vi.spyOn(ThemeGeneratorModule, 'getThemeGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.css', prompt: 'match this' }),
    } as any);

    await processJob({ ...job, options: JSON.stringify(job.options) });

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('match this', style.id, { base64: 'ZmFrZQ==', mediaType: 'image/png' }, undefined);
  });

  it('loads the based-on asset\'s current content and passes it to the theme generator', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', 'existing.css'), ':root { --color-accent: #f80; }');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x',
      imagePath: 'existing.css', outputKind: 'theme',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'brighten it',
      outputKind: 'theme', options: { basedOnAssetId: existingAsset.id },
    });

    const generateSpy = vi.spyOn(ThemeGeneratorModule, 'getThemeGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.css', prompt: 'brighten it' }),
    } as any);

    await processJob({ ...job, options: JSON.stringify(job.options) });

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('brighten it', style.id, undefined, ':root { --color-accent: #f80; }');
  });

  it('completes normally when neither referenceImageFilename nor basedOnAssetId is set', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', outputKind: 'theme',
    });

    const generateSpy = vi.spyOn(ThemeGeneratorModule, 'getThemeGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.css', prompt: 'x' }),
    } as any);

    await processJob({ ...job, options: JSON.stringify(job.options) });

    const generateFn = generateSpy.mock.results[0].value.generate;
    expect(generateFn).toHaveBeenCalledWith('x', style.id, undefined, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workerReferenceImage.test.ts`
Expected: FAIL — `getThemeGenerator` currently called with only 2 args, `basedOnAssetId`/`referenceImageFilename` not read.

- [ ] **Step 3: Write the implementation**

Full updated `worker.ts` (changed lines: new imports, and the body of `processJob`'s try block):

```ts
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseConnection } from '@/lib/database';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getImageGenerator } from '@/lib/services/ImageGenerator';
import { getThemeGenerator } from '@/lib/services/ThemeGenerator';
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import { assetService } from '@/lib/services/AssetService';
import { loadReferenceImage } from '@/lib/services/referenceImage';
import { WORKER_BATCH_SIZE } from '@/lib/config';
import { UiSheetOptionsSchema } from '@/lib/utils/pieceShapes';

// ...POLL_INTERVAL_MS, LOCK_FILE, isProcessAlive, acquireLock, releaseLock unchanged...

/**
 * Resolves options.basedOnAssetId to that asset's current stored content
 * (theme CSS or component HTML), for the regenerate-with-feedback flow.
 * Returns undefined (never throws) if the id is missing, the asset can't be
 * found, its output_kind isn't theme/component, or its file can't be read —
 * this is best-effort context, same reasoning as ClaudeApiThemeGenerator's
 * own dedup-steering loop not failing the whole job over one bad read.
 */
async function loadBasedOnContent(basedOnAssetId: unknown, jobId: string): Promise<string | undefined> {
  if (typeof basedOnAssetId !== 'string') return undefined;
  try {
    const asset = await assetService.getById(basedOnAssetId);
    if (!asset?.image_path) return undefined;
    if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) return undefined;
    const subdir = asset.output_kind === 'theme' ? 'themes' : asset.output_kind === 'component' ? 'components' : null;
    if (!subdir) return undefined;
    return await fsPromises.readFile(path.join(getProjectRoot(), 'storage', subdir, asset.image_path), 'utf-8');
  } catch (e) {
    console.error(`Job ${jobId}: failed to load basedOnAssetId ${basedOnAssetId} content, continuing without it:`, e);
    return undefined;
  }
}

export async function processJob(job: any): Promise<void> {
  const db = DatabaseConnection.getInstance();

  let options: any;
  try {
    options = JSON.parse(job.options);
  } catch (e) {
    db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    console.error(`❌ Job ${job.id} has malformed options JSON:`, e);
    return;
  }

  const isUiSheet = Array.isArray(options.pieces) && options.pieces.length > 0;

  let sheetOptions: ReturnType<typeof UiSheetOptionsSchema.parse> | null = null;
  if (isUiSheet) {
    const parsed = UiSheetOptionsSchema.safeParse(options);
    if (!parsed.success) {
      db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
      console.error(`❌ Job ${job.id} has invalid UI sheet options:`, parsed.error.message);
      return;
    }
    sheetOptions = parsed.data;
  }

  const referenceImage = await loadReferenceImage(
    typeof options.referenceImageFilename === 'string' ? options.referenceImageFilename : undefined
  );
  const referenceStrength = typeof options.referenceStrength === 'number' ? options.referenceStrength : undefined;
  const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);

  try {
    let result: { path: string };
    switch (job.output_kind) {
      case 'theme':
        result = await getThemeGenerator().generate(job.prompt, job.style_id, referenceImage ?? undefined, basedOnContent);
        break;
      case 'component':
        result = await getComponentGenerator().generate(job.prompt, job.style_id, undefined, referenceImage ?? undefined, basedOnContent);
        break;
      case 'image':
        result = sheetOptions
          ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
          : await getImageGenerator().generate(job.prompt, job.style_id, { referenceImage: referenceImage ?? undefined, referenceStrength });
        break;
      default:
        throw new Error(`Job ${job.id} has unrecognized output_kind: ${job.output_kind}`);
    }

    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ?, updated_at = ? WHERE id = ?`)
      .run(result.path, Date.now(), job.id);
    console.log(`✅ Job ${job.id} complete -> ${result.path}`);
  } catch (error: any) {
    db.prepare(`UPDATE jobs SET status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
    console.error(`❌ Job ${job.id} failed:`, error.message);
  }
}

// ...processJobs, scheduleNext, isMainModule block all unchanged...
```

Note: `import fs from 'fs';` stays for the existing sync lock-file calls (`fs.existsSync`, `fs.readFileSync`, etc.) — `fsPromises` is added as a genuinely separate import per `AGENTS.md`'s explicit forbidden-pattern rule against aliasing one `fs` import to serve both sync and async call sites.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workerReferenceImage.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

Run: `npx vitest run`
Expected: PASS, all files

- [ ] **Step 6: Commit**

```bash
git add worker.ts test/workerReferenceImage.test.ts
git commit -m "feat: wire reference image and regenerate-context into the worker dispatch"
```

---

### Task 9: Generate page — attach a reference image

**Files:**
- Modify: `app/dashboard/generate/page.tsx`

**Interfaces:**
- Consumes: `POST /api/generate`'s new `referenceImage` field (Task 2).

No new automated test for this task — it's a client component with no existing test file precedent in this codebase for the Generate page itself (matches the project's real existing pattern: dashboard pages are verified live in a browser during manual verification, not unit-tested; see this session's own established practice for PR #14's UI changes). This task's own manual verification step (Step 3) covers it.

- [ ] **Step 1: Write the implementation**

```tsx
'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { usePolling } from '@/lib/hooks/usePolling';
import { useJobStore } from '@/lib/store/useJobStore';
import { JobCard } from '@/app/components/JobCard';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024; // 5MB raw file - keeps the base64 payload comfortably under the server's 10MB base64-string ceiling

export default function GeneratePage() {
  const { styles, loading: stylesLoading } = useStyles();
  const jobs = useJobStore(s => s.jobs);
  const refreshActive = useJobStore(s => s.refreshActive);
  usePolling(refreshActive, 2000);

  const [styleId, setStyleId] = useState('');
  const [assetType, setAssetType] = useState('sprite');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<{ base64: string; mediaType: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const activeStyleId = styleId || styles[0]?.id || '';

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setReferenceImage(null);
      setImageError(null);
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setImageError('Only PNG, JPEG, or WebP images are supported.');
      e.target.value = '';
      setReferenceImage(null);
      return;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      setImageError('Image must be under 5MB.');
      e.target.value = '';
      setReferenceImage(null);
      return;
    }
    setImageError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:image/png;base64,AAAA..."
      const base64 = result.split(',')[1] ?? '';
      setReferenceImage({ base64, mediaType: file.type });
    };
    reader.readAsDataURL(file);
  }

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
          assetType,
          prompt: prompt.trim(),
          ...(referenceImage ? { referenceImage } : {}),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Generation failed to queue.');
      } else {
        setPrompt('');
        setReferenceImage(null);
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
      <h1 className="page-title">Generate</h1>
      <p className="page-subtitle">
        Queue a new sprite against a Style Bible. GameForge keeps every generation until you promote it to
        an asset or discard it.
      </p>

      {!stylesLoading && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 32 }}>
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before generating art.
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 32, maxWidth: 480 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />

          <div className="field">
            <label htmlFor="assetType">Asset type</label>
            <input id="assetType" value={assetType} onChange={e => setAssetType(e.target.value)} placeholder="sprite" />
          </div>

          <div className="field">
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="a goblin scout, side view, idle pose"
            />
          </div>

          <div className="field">
            <label htmlFor="referenceImage">Reference image (optional)</label>
            <input id="referenceImage" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFileChange} />
            {imageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 4 }}>{imageError}</p>}
            {referenceImage && !imageError && <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 4 }}>Image attached.</p>}
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

- [ ] **Step 2: Run the typecheck**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Manually verify live in a browser**

Start `npm run dev` and `npm run dev:worker`. On the Generate page: attach a PNG under 5MB, confirm "Image attached." appears; attach an 8MB file, confirm the size error appears and the file is cleared; attach a .txt file (rename one to trick the file picker if needed, or use dev tools), confirm the type error appears; submit a generation with an image attached against a real or mock generator and confirm the job completes; check `storage/references/` on disk for the saved file.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/generate/page.tsx
git commit -m "feat: add reference image attach field to the Generate page"
```

---

### Task 10: Asset detail page — "Regenerate with changes"

**Files:**
- Modify: `app/dashboard/assets/[id]/page.tsx`

**Interfaces:**
- Consumes: `POST /api/generate`'s new `referenceImage` and `basedOnAssetId` fields (Task 2).

No new automated test, same reasoning as Task 9 — verified live in Step 3.

- [ ] **Step 1: Write the implementation**

Add new state and a handler near the existing `handleShareToDrive`/`handleDelete` functions in `app/dashboard/assets/[id]/page.tsx`:

```tsx
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [regenerateNote, setRegenerateNote] = useState('');
  const [regenerateImage, setRegenerateImage] = useState<{ base64: string; mediaType: string } | null>(null);
  const [regenerateImageError, setRegenerateImageError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateStatus, setRegenerateStatus] = useState<string | null>(null);

  const REGEN_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const REGEN_MAX_FILE_BYTES = 5 * 1024 * 1024;

  function handleRegenerateFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setRegenerateImage(null);
      setRegenerateImageError(null);
      return;
    }
    if (!REGEN_ALLOWED_TYPES.includes(file.type)) {
      setRegenerateImageError('Only PNG, JPEG, or WebP images are supported.');
      e.target.value = '';
      return;
    }
    if (file.size > REGEN_MAX_FILE_BYTES) {
      setRegenerateImageError('Image must be under 5MB.');
      e.target.value = '';
      return;
    }
    setRegenerateImageError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      setRegenerateImage({ base64, mediaType: file.type });
    };
    reader.readAsDataURL(file);
  }

  async function handleRegenerate() {
    if (!asset || regenerating || !regenerateNote.trim()) return;
    setRegenerating(true);
    setRegenerateStatus(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          styleId: asset.style_id,
          assetType: asset.asset_type,
          prompt: regenerateNote.trim(),
          outputKind: asset.output_kind,
          basedOnAssetId: asset.id,
          ...(regenerateImage ? { referenceImage: regenerateImage } : {}),
        }),
      });
      const body = await res.json();
      if (body.success) {
        setRegenerateStatus('Queued — check the Generate page\'s live queue.');
        setRegenerateNote('');
        setRegenerateImage(null);
      } else {
        setRegenerateStatus(body.error ?? 'Could not queue regeneration.');
      }
    } catch {
      setRegenerateStatus('Could not reach the server.');
    } finally {
      setRegenerating(false);
    }
  }
```

Add the button and modal, placed alongside the existing "Share to Drive" card (after it, before the "Delete asset" card), so it only shows for theme/component/image asset kinds that this feature actually supports (matches the spec — sprite regeneration uses the image itself, no `basedOnContent` text needed, but the SAME `basedOnAssetId` mechanism still applies uniformly since the worker already branches on `output_kind` to decide whether to read file content):

```tsx
      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={() => setShowRegenerateModal(true)}>
          Regenerate with changes
        </button>
      </div>

      {showRegenerateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Regenerate with changes</strong>
              <button className="btn" onClick={() => setShowRegenerateModal(false)}>Cancel</button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 12 }}>
              Creates a new job based on this asset — the original is never changed.
            </p>
            <div className="field">
              <label htmlFor="regenerateNote">What do you want changed?</label>
              <textarea
                id="regenerateNote"
                value={regenerateNote}
                onChange={e => setRegenerateNote(e.target.value)}
                placeholder="make the accent color brighter"
              />
            </div>
            <div className="field">
              <label htmlFor="regenerateImage">Reference image (optional)</label>
              <input id="regenerateImage" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleRegenerateFileChange} />
              {regenerateImageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 4 }}>{regenerateImageError}</p>}
            </div>
            {regenerateStatus && <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 12 }}>{regenerateStatus}</p>}
            <button className="btn btn-primary" onClick={handleRegenerate} disabled={regenerating || !regenerateNote.trim()}>
              {regenerating ? 'Queuing…' : 'Queue regeneration'}
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 2: Run the typecheck**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Manually verify live in a browser**

Open an existing promoted theme or component asset's detail page. Click "Regenerate with changes," type a note, optionally attach an image, submit. Confirm a new job appears in the Generate page's live queue with `basedOnAssetId` set (check via `storage/data.db` or a quick `console.log` in the route during manual testing) and that the ORIGINAL asset is untouched after the new job completes and is reviewed.

- [ ] **Step 4: Commit**

```bash
git add "app/dashboard/assets/[id]/page.tsx"
git commit -m "feat: add Regenerate with changes to the asset detail page"
```

---

## Plan Self-Review

**Spec coverage:** Motivation (all 3 generator types) → Tasks 5-7. Two entry points → Tasks 9-10. Never-mutates-original → Task 10's `basedOnAssetId` (new job, original untouched). Storage via `jobs.options`, no schema change → Task 2. No git sync → unchanged (reference images were never added to `GitService.ts`'s `DATA_DIRS`, confirmed by omission). Cleanup → Task 4. Request shape / dedicated top-level field / server-side validation → Task 2. Generator changes → Tasks 5-7. Regenerate-with-feedback context (text for theme/component, image itself for sprite) → Task 8's `loadBasedOnContent` (theme/component only) plus Task 7's `referenceImage` (used identically whether it's a fresh reference or the "current asset" case, since sprites have no separate content-text concept). Error handling (client + server validation, existing failure path, logging) → Tasks 2 and 9-10. Serving route → Task 3. Configurable Pixellab strength → Task 7. All out-of-scope items (reverse-sync, W3C import, sitemap-assist, permanent asset-level storage, `generateUiAsset`) are untouched by every task above.

**Placeholder scan:** No TBD/TODO markers. The one explicit "verify against live spec" note in Task 7 names the exact real action to take (a live test call) and the exact real source (Pixellab's public docs, linked) — matching this codebase's own established convention for this precise situation (see `PixellabGenerator.ts`'s own header comment), not a vague deferral.

**Type consistency:** `ReferenceImagePayload` (Task 1) is the one shared type threaded through Tasks 2, 5, 6, 7, 8 — every signature uses that exact name and shape. Generator signatures: `ThemeGenerator.generate(prompt, styleId, referenceImage?, basedOnContent?)` (Task 5) matches the worker's call in Task 8 exactly (4 positional args, `undefined` for either gap). `ComponentGenerator.generate(prompt, styleId, componentType?, referenceImage?, basedOnContent?)` (Task 6) matches Task 8's call (`undefined` passed explicitly for `componentType`). `GenerateOptions.referenceImage`/`referenceStrength` (Task 7) matches Task 8's call to `getImageGenerator().generate()`. `options.referenceImageFilename`/`options.referenceStrength`/`options.basedOnAssetId` (Task 2's write side) match Task 8's read side exactly by key name.
