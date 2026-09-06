# Accessibility Contrast Checking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a WCAG AA pass/fail badge on every theme asset card, and the exact contrast ratio on the asset detail page — computed on demand, purely informational, never blocking anything.

**Architecture:** Two small pure functions implement the real WCAG 1.4.3 formula. A new sibling route, `GET /api/assets/[id]/contrast`, mirrors the already-shipped `[id]/export` route's exact structure and reuses the existing `parseThemeCss()`. `AssetCard` (currently a plain function component) becomes a small client component that fetches this route on mount for theme assets only; the asset detail page (already a client component) does the same.

**Tech Stack:** Next.js API route (existing pattern), Vitest (existing pattern: temp SQLite via `setProjectRootForTests`, real temp files).

**Spec:** `docs/superpowers/specs/2026-09-06-contrast-checking-design.md`

## Global Constraints

- No new database tables or columns — this feature persists nothing, computed on demand every time.
- Checks background vs. foreground only — no accent, no border.
- AA threshold only (4.5:1), pass/fail — no AAA tier.
- Purely informational — no blocking or warning anywhere else in the app.
- The badge appears only on `AssetCard` (used only by `app/dashboard/assets/page.tsx` — confirmed no other page renders promoted theme assets as cards).
- A failed contrast fetch must fail silently (no badge/ratio shown) — never a visible error, since this is informational only.

---

## Context for the implementer

This codebase forbids wrapper classes, factory patterns, DTOs, and utility libraries (see `AGENTS.md` at the repo root) — write flat, direct, procedural code.

**The verified WCAG 2.1 formula** (Success Criterion 1.4.3, confirmed directly against W3C's own Understanding-WCAG documentation during planning — use these constants verbatim):
```
Per channel (R, G, or B, normalized to 0-1 from the 0-255 byte value):
  linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ^ 2.4

Relative luminance:
  L = 0.2126 * R_linear + 0.7152 * G_linear + 0.0722 * B_linear

Contrast ratio:
  (L_lighter + 0.05) / (L_darker + 0.05)   where L_lighter is the higher of the two luminances

AA threshold, normal text: ratio >= 4.5 (unrounded — the spec explicitly warns 4.499 must not
pass as if it were 4.5).
```
Two properties of this are algebraically exact and used as the anchor tests in Task 1:
- Black (`#000000`) has L=0 exactly (0 ≤ 0.04045, so `linear = 0/12.92 = 0` for every channel).
- White (`#ffffff`) has L=1 exactly (each channel normalizes to 1, `linear = ((1+0.055)/1.055)^2.4 = 1^2.4 = 1`, and the three coefficients sum to exactly 1.0).
- So black vs. white gives `(1+0.05)/(0+0.05) = 1.05/0.05 = 21` exactly, and any color against itself gives `(L+0.05)/(L+0.05) = 1` exactly.

`ThemeTokens`' colors are always 6-digit hex in this codebase today (confirmed: `MockThemeGenerator`, `ClaudeApiThemeGenerator`'s tool schema, and every seed-theme mapper all only ever produce 6-digit hex) — the new `contrastChecker.ts` only needs to handle that shape, matching the same "only what's actually reachable" scoping already used by the W3C token exporter in the Export Formats feature.

**The existing `GET /api/assets/[id]/export` route** (`app/api/assets/[id]/export/route.ts`), whose exact structure this plan's new route mirrors:
```typescript
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get('format');

  const asset = await assetService.getById(id);
  if (!asset) {
    return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
  }
  if (asset.output_kind !== 'theme' || !asset.image_path) {
    return NextResponse.json({ success: false, error: 'Only theme assets can be exported this way' }, { status: 400 });
  }
  if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid image path' }, { status: 400 });
  }
  // ... reads the file, calls parseThemeCss(), converts, returns
}
```
`parseThemeCss(css: string): ThemeTokens` (from `lib/services/ThemeGenerator.ts`, already built and shipped) reverses the theme's stored `.css` file back into `{ colorBackground, colorForeground, colorAccent, colorBorder, fontHeading, fontBody, spaceUnit, radiusBase }`.

**Real, confirmed CSS custom properties** (`app/globals.css:1-19`) — use these exactly, do not invent new ones: `--keeper: #8ea885` (the existing positive/success color, used for `.badge[data-status='complete']`) and `--reject: #c46a4f` (the existing negative/failure color, used for `.badge[data-status='failed']` and every error message in this codebase).

**No component-testing setup exists in this codebase** — confirmed: `package.json` has no `@testing-library/react` or similar, and there are zero `.test.tsx` files anywhere in the repo. Task 3 (the UI change) therefore has no automated test, matching this project's established convention for UI-only changes (e.g. the Storage/Seed-Themes settings pages, and the Export Formats feature's UI task) — manual verification instead.

**`AssetCard`'s current exact code** (`app/components/AssetCard.tsx`) — a plain function component today, with no `'use client'` directive and no hooks:
```typescript
import Link from 'next/link';
import type { Asset } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

export function AssetCard({ asset }: { asset: Asset }) {
  const states: string[] = (() => {
    try {
      return JSON.parse(asset.states);
    } catch {
      return [];
    }
  })();

  return (
    <Link href={`/dashboard/assets/${asset.id}`} className="card" style={{ padding: 0, overflow: 'hidden', display: 'block' }}>
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
      <div style={{ padding: '10px 12px' }}>
        <div className="frame-label" style={{ marginBottom: 4 }}>
          {asset.asset_type}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.4, marginBottom: asset.nine_slice_margins || states.length ? 6 : 0 }}>
          {asset.prompt}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {asset.nine_slice_margins && <span className="badge">9-sliced</span>}
          {states.length > 0 && <span className="badge">{states.length} state{states.length === 1 ? '' : 's'}</span>}
        </div>
      </div>
    </Link>
  );
}
```

**The asset detail page's current relevant section** (`app/dashboard/assets/[id]/page.tsx:98-115`, already a client component with an existing `useEffect` fetching the asset on mount):
```tsx
      {asset.output_kind === 'theme' && asset.image_path && (
        <>
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12 }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <a className="btn" href={`/api/assets/${id}/export?format=tailwind`} download>
              Export as Tailwind CSS
            </a>
            <a className="btn" href={`/api/assets/${id}/export?format=w3c`} download>
              Export as W3C Tokens
            </a>
          </div>
        </>
      )}
```

---

### Task 1: `getContrastRatio` / `meetsWcagAA`

**Files:**
- Create: `lib/services/contrastChecker.ts`
- Test: `test/contrastChecker.test.ts`

**Interfaces:**
- Consumes: nothing (pure math, no dependencies on other tasks).
- Produces: `getContrastRatio(hex1: string, hex2: string): number` and `meetsWcagAA(ratio: number): boolean` — Task 2 imports and calls both.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/contrastChecker.test.ts
import { describe, it, expect } from 'vitest';
import { getContrastRatio, meetsWcagAA } from '@/lib/services/contrastChecker';

describe('getContrastRatio', () => {
  it('returns exactly 21 for black vs white (the maximum possible contrast)', () => {
    expect(getContrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('returns exactly 1 for a color against itself (same luminance both sides)', () => {
    expect(getContrastRatio('#808080', '#808080')).toBeCloseTo(1, 5);
  });

  it('is symmetric — argument order does not matter', () => {
    const a = getContrastRatio('#1c1a17', '#ede7dc');
    const b = getContrastRatio('#ede7dc', '#1c1a17');
    expect(a).toBeCloseTo(b, 10);
  });

  it("computes a real theme's contrast ratio correctly", () => {
    // GameForge's own FIXED_MOCK_TOKENS (lib/services/ThemeGenerator.ts):
    // a dark background (#1c1a17) against light cream text (#ede7dc).
    // Hand-derived during planning: approximately 14.1:1 — cross-check
    // this against an independent tool (e.g. https://webaim.org/resources/contrastchecker/,
    // entering #1c1a17 as background and #ede7dc as foreground) before
    // finalizing this test. If your independent check gives a precise
    // value, you may tighten this to `toBeCloseTo(<real value>, 1)`
    // instead of the range check below — either is acceptable as long
    // as the value has been independently verified, not just trusted
    // from this plan's hand derivation.
    const ratio = getContrastRatio('#1c1a17', '#ede7dc');
    expect(ratio).toBeGreaterThan(10);
    expect(ratio).toBeLessThan(18);
  });
});

describe('meetsWcagAA', () => {
  it('passes at exactly the 4.5 threshold', () => {
    expect(meetsWcagAA(4.5)).toBe(true);
  });

  it('fails just below the threshold, unrounded', () => {
    expect(meetsWcagAA(4.499)).toBe(false);
  });

  it('passes for a comfortably high ratio', () => {
    expect(meetsWcagAA(21)).toBe(true);
  });

  it('fails for a comfortably low ratio', () => {
    expect(meetsWcagAA(1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- contrastChecker.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/contrastChecker'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/contrastChecker.ts

// Verified against the real WCAG 2.1 Success Criterion 1.4.3 formula
// (w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) during planning.
// Only handles 6-digit hex — the only shape any theme generator in this
// codebase actually produces (mock, AI-generated, and all seed themes).

function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

export function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsWcagAA(ratio: number): boolean {
  return ratio >= 4.5;
}
```

- [ ] **Step 4: Cross-check the non-trivial reference value against a live tool**

Before finalizing, open `https://webaim.org/resources/contrastchecker/` (or any real, independent WCAG contrast checker), enter `#1c1a17` as the background and `#ede7dc` as the foreground, and read off the reported ratio. Confirm it falls between 10 and 18 (matching this plan's hand-derived estimate of ~14.1). If it doesn't, or if you want a tighter assertion, update the "computes a real theme's contrast ratio correctly" test to use the tool's exact reported value with `toBeCloseTo(<value>, 1)` instead of the range check. Record what the tool actually reported in your task report.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- contrastChecker.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/services/contrastChecker.ts test/contrastChecker.test.ts
git commit -m "feat: add WCAG contrast ratio checker"
```

---

### Task 2: Contrast API route

**Files:**
- Create: `app/api/assets/[id]/contrast/route.ts`
- Test: `test/assetContrastRoute.test.ts`

**Interfaces:**
- Consumes: `getContrastRatio`, `meetsWcagAA` (Task 1); existing `parseThemeCss` from `lib/services/ThemeGenerator.ts`; existing `assetService.getById`; existing `getProjectRoot()`.
- Produces: nothing consumed by later tasks by import — Task 3 only references this route's URL (`/api/assets/${id}/contrast`), never imports its code.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/assetContrastRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';
import { GET } from '@/app/api/assets/[id]/contrast/route';

let tempRoot: string;

const HIGH_CONTRAST_TOKENS: ThemeTokens = {
  colorBackground: '#000000',
  colorForeground: '#ffffff',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

const LOW_CONTRAST_TOKENS: ThemeTokens = {
  ...HIGH_CONTRAST_TOKENS,
  colorBackground: '#888888',
  colorForeground: '#999999',
};

async function makeThemeAsset(tokens: ThemeTokens): Promise<{ assetId: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `theme-${style.id}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(tokens));
  const asset = await assetService.create({
    styleId: style.id,
    createdBy: 'user-1',
    assetType: 'theme',
    prompt: 'x',
    imagePath: filename,
    outputKind: 'theme',
  });
  return { assetId: asset.id };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-contrast-'));
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

describe('GET /api/assets/[id]/contrast', () => {
  it('returns a passing ratio for a high-contrast theme', async () => {
    const { assetId } = await makeThemeAsset(HIGH_CONTRAST_TOKENS);
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.ratio).toBeCloseTo(21, 5);
    expect(body.data.meetsAA).toBe(true);
  });

  it('returns a failing result for a low-contrast theme', async () => {
    const { assetId } = await makeThemeAsset(LOW_CONTRAST_TOKENS);
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.meetsAA).toBe(false);
  });

  it('returns 404 for a nonexistent asset', async () => {
    const req = new NextRequest('http://localhost/api/assets/00000000-0000-0000-0000-000000000000/contrast');
    const res = await GET(req, { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-theme asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'x.png', outputKind: 'image',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a path-traversal image_path', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    const assetId = '11111111-1111-1111-1111-111111111111';
    db.prepare(
      `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted, output_kind)
       VALUES (?, ?, 'user-1', 'theme', 'x', '../../../secrets.css', ?, 0, 'theme')`
    ).run(assetId, style.id, Date.now());
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when the theme CSS file is missing on disk', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'missing.css', outputKind: 'theme',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/contrast`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- assetContrastRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/assets/[id]/contrast/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/assets/[id]/contrast/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { getContrastRatio, meetsWcagAA } from '@/lib/services/contrastChecker';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const asset = await assetService.getById(id);
  if (!asset) {
    return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
  }
  if (asset.output_kind !== 'theme' || !asset.image_path) {
    return NextResponse.json({ success: false, error: 'Only theme assets have a contrast check' }, { status: 400 });
  }
  // Same guard as app/api/assets/[id]/export/route.ts — image_path comes
  // from the database, never user-typed paths, but is defense-in-depth
  // against a corrupted/hostile git-synced import setting it to something
  // unexpected.
  if (asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid image path' }, { status: 400 });
  }

  let css: string;
  try {
    css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', asset.image_path), 'utf-8');
  } catch (e) {
    console.error(`Failed to read theme file for contrast check (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: 'Could not read the theme file' }, { status: 500 });
  }

  let tokens;
  try {
    tokens = parseThemeCss(css);
  } catch (e) {
    console.error(`Failed to parse theme CSS for contrast check (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: 'Could not parse the theme file' }, { status: 500 });
  }

  const ratio = getContrastRatio(tokens.colorBackground, tokens.colorForeground);
  return NextResponse.json({ success: true, data: { ratio, meetsAA: meetsWcagAA(ratio) } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- assetContrastRoute.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/assets/\[id\]/contrast/route.ts test/assetContrastRoute.test.ts
git commit -m "feat: add theme contrast-check API route"
```

---

### Task 3: Contrast badge on the card, exact ratio on the detail page

**Files:**
- Modify: `app/components/AssetCard.tsx` (entire file — becomes a client component)
- Modify: `app/dashboard/assets/[id]/page.tsx` (add a fetch + display near the export links)

**Interfaces:**
- Consumes: the route from Task 2, referenced only by URL (`/api/assets/${id}/contrast`) — no code import.
- Produces: nothing consumed by later tasks — this is the final task.

This task has no automated test — this codebase has no component-testing setup (confirmed: no `@testing-library/react` in `package.json`, zero `.test.tsx` files anywhere), matching the established convention for UI-only changes in this project. Verify manually per Step 3 below.

- [ ] **Step 1: Update `AssetCard.tsx`**

Replace the entire file with:

```typescript
// app/components/AssetCard.tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Asset } from '@/lib/database/schema';
import { buildThemePreviewHtml } from '@/lib/utils/themePreview';

export function AssetCard({ asset }: { asset: Asset }) {
  const states: string[] = (() => {
    try {
      return JSON.parse(asset.states);
    } catch {
      return [];
    }
  })();

  const [contrast, setContrast] = useState<{ ratio: number; meetsAA: boolean } | null>(null);

  useEffect(() => {
    if (asset.output_kind !== 'theme') return;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets/${asset.id}/contrast`);
        const body = await res.json();
        if (!ignore && body.success) setContrast(body.data);
      } catch {
        // Purely informational — a failed fetch just means no badge shows.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [asset.id, asset.output_kind]);

  return (
    <Link href={`/dashboard/assets/${asset.id}`} className="card" style={{ padding: 0, overflow: 'hidden', display: 'block' }}>
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
      <div style={{ padding: '10px 12px' }}>
        <div className="frame-label" style={{ marginBottom: 4 }}>
          {asset.asset_type}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.4, marginBottom: asset.nine_slice_margins || states.length || contrast ? 6 : 0 }}>
          {asset.prompt}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {asset.nine_slice_margins && <span className="badge">9-sliced</span>}
          {states.length > 0 && <span className="badge">{states.length} state{states.length === 1 ? '' : 's'}</span>}
          {contrast && (
            <span className="badge" style={{ color: contrast.meetsAA ? 'var(--keeper)' : 'var(--reject)' }}>
              {contrast.meetsAA ? 'AA ✓' : 'AA ✗'}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Update the asset detail page**

In `app/dashboard/assets/[id]/page.tsx`, add a new state variable and effect alongside the existing ones near the top of the component (after the existing `useState`/`useEffect` block that fetches the asset):

```typescript
  const [contrast, setContrast] = useState<{ ratio: number; meetsAA: boolean } | null>(null);

  useEffect(() => {
    if (asset?.output_kind !== 'theme') return;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/assets/${id}/contrast`);
        const body = await res.json();
        if (!ignore && body.success) setContrast(body.data);
      } catch {
        // Purely informational — a failed fetch just means nothing shows.
      }
    })();
    return () => {
      ignore = true;
    };
  }, [id, asset?.output_kind]);
```

Then find the existing theme block:
```tsx
      {asset.output_kind === 'theme' && asset.image_path && (
        <>
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12 }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <a className="btn" href={`/api/assets/${id}/export?format=tailwind`} download>
              Export as Tailwind CSS
            </a>
            <a className="btn" href={`/api/assets/${id}/export?format=w3c`} download>
              Export as W3C Tokens
            </a>
          </div>
        </>
      )}
```
Replace with:
```tsx
      {asset.output_kind === 'theme' && asset.image_path && (
        <>
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12 }}
          />
          {contrast && (
            <p style={{ fontSize: 13, color: contrast.meetsAA ? 'var(--keeper)' : 'var(--reject)', marginBottom: 12 }}>
              Contrast: {contrast.ratio.toFixed(2)}:1 — {contrast.meetsAA ? 'passes' : 'fails'} WCAG AA
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <a className="btn" href={`/api/assets/${id}/export?format=tailwind`} download>
              Export as Tailwind CSS
            </a>
            <a className="btn" href={`/api/assets/${id}/export?format=w3c`} download>
              Export as W3C Tokens
            </a>
          </div>
        </>
      )}
```

- [ ] **Step 3: Manually verify the golden path**

1. Run `npm run dev` (or confirm the dev server is already running).
2. Navigate to `/dashboard/assets` and confirm theme asset cards now show an "AA ✓" or "AA ✗" badge alongside any existing 9-sliced/state badges, and non-theme (sprite) cards show no such badge.
3. Click into a theme asset with an "AA ✓" badge and confirm the detail page shows a "Contrast: X.XX:1 — passes WCAG AA" line in the keeper (green) color, below the preview and above the export links.
4. If any seeded theme has a low-contrast pairing, confirm its card shows "AA ✗" and its detail page shows the fails-WCAG-AA message in the reject (red) color. If none of the 58 seeded themes happen to fail, this is fine — the automated tests in Task 2 already cover the failing case directly.
5. Confirm a non-theme (sprite) asset's card and detail page show no contrast badge/message at all.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (all prior tests plus this feature's new tests, no regressions)

- [ ] **Step 5: Commit**

```bash
git add app/components/AssetCard.tsx app/dashboard/assets/\[id\]/page.tsx
git commit -m "feat: add contrast badge to theme asset cards and detail page"
```
