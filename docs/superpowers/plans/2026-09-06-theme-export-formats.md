# Theme Export Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user export any theme asset as a Tailwind v4 `@theme` CSS file or a W3C Design Tokens JSON file, via a per-theme "Export" control on the asset detail page.

**Architecture:** A new `parseThemeCss()` function reverses the existing `tokensToCss()` — the theme's own `.css` file is the one universally-reliable source of structured tokens for any theme asset. Two small, focused exporter functions (one per format) convert `ThemeTokens` into each target's real, verified shape. A new API route reads the asset, parses its CSS, converts to the requested format, and returns it as a downloadable file. No new persistence — this is a pure, on-demand computation.

**Tech Stack:** Next.js API route (existing pattern), Vitest (existing pattern: temp SQLite via `setProjectRootForTests`, real temp files for storage), Zod (existing `ThemeTokensSchema`, reused for defense-in-depth re-validation on read).

**Spec:** `docs/superpowers/specs/2026-09-06-theme-export-formats-design.md`

## Global Constraints

- No new database tables or columns — this feature persists nothing.
- Reuse `ThemeTokensSchema`/`tokensToCss()` from `lib/services/ThemeGenerator.ts` unmodified.
- Two formats only: Tailwind v4 `@theme` CSS, and W3C Design Tokens JSON (2025.10). No Figma-specific format, no legacy `tailwind.config.js`, no batch export.
- The export control lives on the theme asset's detail page (`app/dashboard/assets/[id]/page.tsx`), not a separate dedicated page.
- Download filenames are derived from the asset's Style Bible name, slugified, plus the format's extension (e.g. `"DaisyUI: Cyberpunk"` → `daisyui-cyberpunk.css` / `daisyui-cyberpunk.json`).
- W3C color tokens only support hex input colors (the only format any generator in this codebase has ever actually produced) — a non-hex color input is a clear, explicit export error, not a silent guess.
- W3C dimension tokens only support `px`/`rem` units (the W3C spec itself only defines these two) — an `em` value (technically valid per this codebase's `CSS_LENGTH_RE` but never actually produced by any generator) is a clear, explicit export error, not a silent approximation.

---

## Context for the implementer

This codebase forbids wrapper classes, factory patterns, DTOs, and utility libraries (see `AGENTS.md` at the repo root) — write flat, direct, procedural code. Every file write must be wrapped in `try/catch` with `console.error` logging.

The existing `tokensToCss()` (`lib/services/ThemeGenerator.ts:41-53`) — confirmed current, exact output format, this plan's `parseThemeCss()` reverses it exactly:
```typescript
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
```

`ThemeTokensSchema` (`lib/services/ThemeGenerator.ts:20-29`) — reused unmodified for defense-in-depth re-validation when reading a theme's CSS back:
```typescript
export const ThemeTokensSchema = z.object({
  colorBackground: z.string().regex(CSS_COLOR_RE, ...),
  colorForeground: z.string().regex(CSS_COLOR_RE, ...),
  colorAccent: z.string().regex(CSS_COLOR_RE, ...),
  colorBorder: z.string().regex(CSS_COLOR_RE, ...),
  fontHeading: z.string().regex(CSS_FONT_RE, ...),
  fontBody: z.string().regex(CSS_FONT_RE, ...),
  spaceUnit: z.string().regex(CSS_LENGTH_RE, ...),
  radiusBase: z.string().regex(CSS_LENGTH_RE, ...),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
```
`CSS_LENGTH_RE = /^\d{1,3}(\.\d+)?(px|rem|em)$/` — so `spaceUnit`/`radiusBase` are always at least one digit followed by `px`, `rem`, or `em`.

**Verified Tailwind v4 `@theme` naming conventions** (confirmed directly against Tailwind's own current documentation during planning, not assumed from training data):
- `--color-{name}` generates `bg-{name}`, `text-{name}`, `border-{name}`, `fill-{name}`, etc.
- `--spacing` (singular, no suffix) is a single base multiplier for Tailwind's entire numeric spacing scale — e.g. `--spacing: 4px` makes `p-4` resolve to `4 × 4px = 16px`. This is exactly what `spaceUnit` already represents conceptually (a base spacing unit), so it maps directly.
- `--radius-{name}` generates `rounded-{name}`.
- `--font-{name}` generates `font-{name}` utilities (the whole `font-family` value, fallbacks included, goes in as one variable value).

**Verified W3C Design Tokens Format Module (2025.10) token shapes** (confirmed directly against the spec at designtokens.org during planning):
- Color: `{ "$type": "color", "$value": { "colorSpace": "srgb", "components": [r, g, b], "alpha": 1 } }` where `r`/`g`/`b` are floats in `[0, 1]`.
- Font family: `{ "$type": "fontFamily", "$value": "Name" }` for a single font, or `{ "$type": "fontFamily", "$value": ["Name", "Fallback"] }` for multiple — the spec allows either shape depending on whether there's one name or several.
- Dimension: `{ "$type": "dimension", "$value": { "value": <number>, "unit": "px" | "rem" } }` — the spec only defines these two units.
- Top-level grouping is explicitly not mandated by the spec ("Groups are arbitrary and tools SHOULD NOT use them to infer the type or purpose of design tokens") — this plan groups tokens under `color`/`font`/`dimension` keys for readability, matching common real-world token-file conventions.

The existing `Asset`/`Style` fields this plan depends on (confirmed current):
- `Asset.image_path: string | null` — the theme's CSS filename under `storage/themes/`.
- `Asset.output_kind: 'image' | 'theme'`.
- `Asset.style_id: string` — foreign key to the owning Style Bible.
- `Style.name: string` — used for the download filename.
- `styleService.getById(id: string): Promise<Style | null>` (`lib/services/StyleService.ts`).
- `assetService.getById(id: string): Promise<Asset | null>` (`lib/services/AssetService.ts`).

The existing route pattern for an asset sub-action (`app/api/assets/[id]/edit/route.ts` is the precedent — a sibling route under `[id]/`) and the existing response shape (`{ success: true, data }` / `{ success: false, error }`, matching `app/api/assets/[id]/route.ts`) — the export route deviates from the JSON-response shape only for its success case, since it must return a raw file body with download headers, not a JSON envelope.

---

### Task 1: `parseThemeCss()` — reverse the existing CSS writer

**Files:**
- Modify: `lib/services/ThemeGenerator.ts` (add the new function; do not change `tokensToCss` or `ThemeTokensSchema`)
- Test: `test/parseThemeCss.test.ts`

**Interfaces:**
- Consumes: `ThemeTokensSchema`, `ThemeTokens` (both already exist in this file).
- Produces: `parseThemeCss(css: string): ThemeTokens` — Tasks 4 imports and calls this.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/parseThemeCss.test.ts
import { describe, it, expect } from 'vitest';
import { parseThemeCss, tokensToCss, type ThemeTokens } from '@/lib/services/ThemeGenerator';

const SAMPLE_TOKENS: ThemeTokens = {
  colorBackground: '#1a1420',
  colorForeground: '#f0e6d2',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

const OTHER_TOKENS: ThemeTokens = {
  colorBackground: '#ffffff',
  colorForeground: '#212529',
  colorAccent: '#2c3e50',
  colorBorder: '#dee2e6',
  fontHeading: "'Lato', sans-serif",
  fontBody: "'Lato', sans-serif",
  spaceUnit: '0.5rem',
  radiusBase: '0.375rem',
};

describe('parseThemeCss', () => {
  it('round-trips through tokensToCss and recovers the original tokens', () => {
    expect(parseThemeCss(tokensToCss(SAMPLE_TOKENS))).toEqual(SAMPLE_TOKENS);
    expect(parseThemeCss(tokensToCss(OTHER_TOKENS))).toEqual(OTHER_TOKENS);
  });

  it('parses a real theme.css file body directly', () => {
    const css = `:root {
  --color-bg: #0a0a0f;
  --color-fg: #e8e8f5;
  --color-accent: #ff00e6;
  --color-border: #00fff2;
  --font-heading: 'Rajdhani', 'Orbitron', sans-serif;
  --font-body: 'Inter', 'Helvetica Neue', sans-serif;
  --space-unit: 8px;
  --radius-base: 0px;
}
`;
    expect(parseThemeCss(css)).toEqual({
      colorBackground: '#0a0a0f',
      colorForeground: '#e8e8f5',
      colorAccent: '#ff00e6',
      colorBorder: '#00fff2',
      fontHeading: "'Rajdhani', 'Orbitron', sans-serif",
      fontBody: "'Inter', 'Helvetica Neue', sans-serif",
      spaceUnit: '8px',
      radiusBase: '0px',
    });
  });

  it('throws a clear error when a required variable is missing', () => {
    expect(() => parseThemeCss(':root { --color-bg: #fff; }')).toThrow(/--color-fg/);
  });

  it('throws when a value fails ThemeTokensSchema validation', () => {
    const css = tokensToCss(SAMPLE_TOKENS).replace('#1a1420', 'not-a-color');
    expect(() => parseThemeCss(css)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- parseThemeCss.test.ts`
Expected: FAIL — `parseThemeCss is not a function` (or a TypeScript error if run through `tsc`, but Vitest will report a runtime failure)

- [ ] **Step 3: Write the implementation**

Add to `lib/services/ThemeGenerator.ts`, after the existing `tokensToCss` function:

```typescript
export function parseThemeCss(css: string): ThemeTokens {
  function extract(varName: string): string {
    const match = css.match(new RegExp(`--${varName}:\\s*([^;]+);`));
    if (!match) {
      throw new Error(`Theme CSS is missing required custom property --${varName}`);
    }
    return match[1].trim();
  }

  return ThemeTokensSchema.parse({
    colorBackground: extract('color-bg'),
    colorForeground: extract('color-fg'),
    colorAccent: extract('color-accent'),
    colorBorder: extract('color-border'),
    fontHeading: extract('font-heading'),
    fontBody: extract('font-body'),
    spaceUnit: extract('space-unit'),
    radiusBase: extract('radius-base'),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- parseThemeCss.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/ThemeGenerator.ts test/parseThemeCss.test.ts
git commit -m "feat: add parseThemeCss to reverse tokensToCss for theme export"
```

---

### Task 2: Tailwind v4 `@theme` exporter

**Files:**
- Create: `lib/services/themeExport/tailwindExporter.ts`
- Test: `test/tailwindExporter.test.ts`

**Interfaces:**
- Consumes: `ThemeTokens` from `lib/services/ThemeGenerator.ts` (existing).
- Produces: `tokensToTailwindTheme(tokens: ThemeTokens): string` — Task 4 imports and calls this.

- [ ] **Step 1: Write the failing test**

```typescript
// test/tailwindExporter.test.ts
import { describe, it, expect } from 'vitest';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

const TOKENS: ThemeTokens = {
  colorBackground: '#1a1420',
  colorForeground: '#f0e6d2',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

describe('tokensToTailwindTheme', () => {
  it('produces an @theme block with the verified Tailwind v4 variable names', () => {
    const css = tokensToTailwindTheme(TOKENS);
    expect(css).toBe(`@theme {
  --color-background: #1a1420;
  --color-foreground: #f0e6d2;
  --color-accent: #e8a33d;
  --color-border: #4a3728;
  --font-heading: 'Cinzel', serif;
  --font-body: 'EB Garamond', serif;
  --spacing: 8px;
  --radius-base: 4px;
}
`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tailwindExporter.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/themeExport/tailwindExporter'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/themeExport/tailwindExporter.ts
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

// Variable names verified directly against Tailwind v4's current documentation
// (tailwindcss.com/docs/theme): --color-* generates bg-*/text-*/border-*
// utilities, --spacing is a single base multiplier for the whole numeric
// spacing scale, --radius-* generates rounded-*, --font-* generates font-*.
export function tokensToTailwindTheme(tokens: ThemeTokens): string {
  return `@theme {
  --color-background: ${tokens.colorBackground};
  --color-foreground: ${tokens.colorForeground};
  --color-accent: ${tokens.colorAccent};
  --color-border: ${tokens.colorBorder};
  --font-heading: ${tokens.fontHeading};
  --font-body: ${tokens.fontBody};
  --spacing: ${tokens.spaceUnit};
  --radius-base: ${tokens.radiusBase};
}
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tailwindExporter.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add lib/services/themeExport/tailwindExporter.ts test/tailwindExporter.test.ts
git commit -m "feat: add Tailwind v4 @theme exporter"
```

---

### Task 3: W3C Design Tokens JSON exporter

**Files:**
- Create: `lib/services/themeExport/w3cExporter.ts`
- Test: `test/w3cExporter.test.ts`

**Interfaces:**
- Consumes: `ThemeTokens` from `lib/services/ThemeGenerator.ts` (existing).
- Produces: `tokensToW3cTokens(tokens: ThemeTokens): string` — Task 4 imports and calls this. Throws a plain `Error` for a non-hex color or a non-`px`/`rem` dimension unit.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/w3cExporter.test.ts
import { describe, it, expect } from 'vitest';
import { tokensToW3cTokens } from '@/lib/services/themeExport/w3cExporter';
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

const TOKENS: ThemeTokens = {
  colorBackground: '#ffffff',
  colorForeground: '#212529',
  colorAccent: '#2c3e50',
  colorBorder: '#dee2e6',
  fontHeading: "'Playfair Display', serif",
  fontBody: "'Lato', sans-serif",
  spaceUnit: '0.5rem',
  radiusBase: '0.375rem',
};

describe('tokensToW3cTokens', () => {
  it('produces valid Design Tokens Format Module JSON with the verified token shapes', () => {
    const doc = JSON.parse(tokensToW3cTokens(TOKENS));

    // Color: #ffffff -> components [1, 1, 1]; #212529 -> [33,37,41]/255
    expect(doc.color.background).toEqual({
      $type: 'color',
      $value: { colorSpace: 'srgb', components: [1, 1, 1], alpha: 1 },
    });
    expect(doc.color.foreground.$type).toBe('color');
    expect(doc.color.foreground.$value.colorSpace).toBe('srgb');
    expect(doc.color.foreground.$value.components[0]).toBeCloseTo(0x21 / 255, 5);
    expect(doc.color.foreground.$value.components[1]).toBeCloseTo(0x25 / 255, 5);
    expect(doc.color.foreground.$value.components[2]).toBeCloseTo(0x29 / 255, 5);
    expect(doc.color.foreground.$value.alpha).toBe(1);

    // Font family: multiple names -> array
    expect(doc.font.heading).toEqual({ $type: 'fontFamily', $value: ['Playfair Display', 'serif'] });
    expect(doc.font.body).toEqual({ $type: 'fontFamily', $value: ['Lato', 'sans-serif'] });

    // Dimension: value + unit split out
    expect(doc.dimension['space-unit']).toEqual({ $type: 'dimension', $value: { value: 0.5, unit: 'rem' } });
    expect(doc.dimension['radius-base']).toEqual({ $type: 'dimension', $value: { value: 0.375, unit: 'rem' } });
  });

  it('handles 3-digit hex shorthand', () => {
    // #f0a expands to #ff00aa: r=0xff, g=0x00, b=0xaa
    const doc = JSON.parse(tokensToW3cTokens({ ...TOKENS, colorAccent: '#f0a' }));
    expect(doc.color.accent.$value.components[0]).toBeCloseTo(1, 5);
    expect(doc.color.accent.$value.components[1]).toBeCloseTo(0, 5);
    expect(doc.color.accent.$value.components[2]).toBeCloseTo(170 / 255, 5);
  });

  it('throws a clear error for a non-hex color', () => {
    expect(() => tokensToW3cTokens({ ...TOKENS, colorAccent: 'rgb(255, 0, 0)' })).toThrow(/hex/);
  });

  it('throws a clear error for an em dimension unit', () => {
    expect(() => tokensToW3cTokens({ ...TOKENS, spaceUnit: '1em' })).toThrow(/px|rem/);
  });

  it('uses a single string (not an array) for a single-name font', () => {
    const doc = JSON.parse(tokensToW3cTokens({ ...TOKENS, fontBody: 'Arial' }));
    expect(doc.font.body).toEqual({ $type: 'fontFamily', $value: 'Arial' });
  });
});
```

Note: the 3-digit-hex test above has a typo-shaped expression (`0x aa / 255`) — this is intentional as written text cannot contain a literal hex byte cleanly in this format; when you write this test for real, compute the expected value as `0xaa / 255` (i.e. `#f0a` expands to `#ff00aa`, so components are `[1, 0, 0xaa / 255]`). Write the corrected literal directly — do not leave the placeholder shape above in the actual test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- w3cExporter.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/themeExport/w3cExporter'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/themeExport/w3cExporter.ts
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

// Token shapes verified directly against the Design Tokens Format Module
// spec (2025.10, designtokens.org) during planning.

function hexToRgbComponents(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const expand = (c: string) => c + c;
  let r: string, g: string, b: string;
  if (clean.length === 3 || clean.length === 4) {
    r = expand(clean[0]);
    g = expand(clean[1]);
    b = expand(clean[2]);
  } else if (clean.length === 6 || clean.length === 8) {
    r = clean.slice(0, 2);
    g = clean.slice(2, 4);
    b = clean.slice(4, 6);
  } else {
    throw new Error(`Cannot export color "${hex}" as a W3C token — unrecognized hex length.`);
  }
  return [parseInt(r, 16) / 255, parseInt(g, 16) / 255, parseInt(b, 16) / 255];
}

function colorToken(value: string) {
  if (!value.startsWith('#')) {
    throw new Error(`Cannot export color "${value}" as a W3C token — only hex colors are supported.`);
  }
  const [r, g, b] = hexToRgbComponents(value);
  return { $type: 'color', $value: { colorSpace: 'srgb', components: [r, g, b], alpha: 1 } };
}

function fontFamilyToken(value: string) {
  const names = value.split(',').map(part => part.trim().replace(/^['"]|['"]$/g, ''));
  return { $type: 'fontFamily', $value: names.length === 1 ? names[0] : names };
}

function dimensionToken(value: string) {
  const match = value.match(/^(\d+(?:\.\d+)?)(px|rem)$/);
  if (!match) {
    throw new Error(`Cannot export dimension "${value}" as a W3C token — only px and rem units are supported.`);
  }
  return { $type: 'dimension', $value: { value: parseFloat(match[1]), unit: match[2] as 'px' | 'rem' } };
}

export function tokensToW3cTokens(tokens: ThemeTokens): string {
  const doc = {
    color: {
      background: colorToken(tokens.colorBackground),
      foreground: colorToken(tokens.colorForeground),
      accent: colorToken(tokens.colorAccent),
      border: colorToken(tokens.colorBorder),
    },
    font: {
      heading: fontFamilyToken(tokens.fontHeading),
      body: fontFamilyToken(tokens.fontBody),
    },
    dimension: {
      'space-unit': dimensionToken(tokens.spaceUnit),
      'radius-base': dimensionToken(tokens.radiusBase),
    },
  };
  return JSON.stringify(doc, null, 2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- w3cExporter.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/themeExport/w3cExporter.ts test/w3cExporter.test.ts
git commit -m "feat: add W3C Design Tokens JSON exporter"
```

---

### Task 4: Export API route

**Files:**
- Create: `app/api/assets/[id]/export/route.ts`
- Test: `test/assetExportRoute.test.ts`

**Interfaces:**
- Consumes: `parseThemeCss` (Task 1), `tokensToTailwindTheme` (Task 2), `tokensToW3cTokens` (Task 3), existing `assetService.getById`, `styleService.getById`, existing `getProjectRoot()`.
- Produces: nothing consumed by later tasks — Task 5 only links to this route's URL, it doesn't import any of its code.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/assetExportRoute.test.ts
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
import { GET } from '@/app/api/assets/[id]/export/route';

let tempRoot: string;

const TOKENS: ThemeTokens = {
  colorBackground: '#1a1420',
  colorForeground: '#f0e6d2',
  colorAccent: '#e8a33d',
  colorBorder: '#4a3728',
  fontHeading: "'Cinzel', serif",
  fontBody: "'EB Garamond', serif",
  spaceUnit: '8px',
  radiusBase: '4px',
};

async function makeThemeAsset(styleName: string): Promise<{ assetId: string }> {
  const style = await styleService.create({ name: styleName, createdBy: 'user-1', parameters: '{}' });
  const filename = `theme-${style.id}.css`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'themes', filename), tokensToCss(TOKENS));
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
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeexport-'));
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

describe('GET /api/assets/[id]/export', () => {
  it('exports a theme asset as Tailwind CSS with the correct headers and filename', async () => {
    const { assetId } = await makeThemeAsset('DaisyUI: Cyberpunk');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="daisyui-cyberpunk.css"');
    const body = await res.text();
    expect(body).toContain('@theme {');
    expect(body).toContain('--color-background: #1a1420;');
  });

  it('exports a theme asset as W3C tokens JSON with the correct headers and filename', async () => {
    const { assetId } = await makeThemeAsset('Bootswatch: Flatly');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=w3c`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="bootswatch-flatly.json"');
    const doc = JSON.parse(await res.text());
    expect(doc.color.background.$type).toBe('color');
  });

  it('returns 404 for a nonexistent asset', async () => {
    const req = new NextRequest('http://localhost/api/assets/00000000-0000-0000-0000-000000000000/export?format=tailwind');
    const res = await GET(req, { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-theme asset', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', imagePath: 'x.png', outputKind: 'image',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid format param', async () => {
    const { assetId } = await makeThemeAsset('x');
    const req = new NextRequest(`http://localhost/api/assets/${assetId}/export?format=nonsense`);
    const res = await GET(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('returns 500 when the theme CSS file is missing on disk', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'theme', prompt: 'x', imagePath: 'missing.css', outputKind: 'theme',
    });
    const req = new NextRequest(`http://localhost/api/assets/${asset.id}/export?format=tailwind`);
    const res = await GET(req, { params: Promise.resolve({ id: asset.id }) });
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- assetExportRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/assets/[id]/export/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/assets/[id]/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { styleService } from '@/lib/services/StyleService';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import { tokensToW3cTokens } from '@/lib/services/themeExport/w3cExporter';

export const dynamic = 'force-dynamic';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

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
  if (format !== 'tailwind' && format !== 'w3c') {
    return NextResponse.json({ success: false, error: 'format must be "tailwind" or "w3c"' }, { status: 400 });
  }

  let css: string;
  try {
    css = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'themes', asset.image_path), 'utf-8');
  } catch (e) {
    console.error(`Failed to read theme file for export (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: 'Could not read the theme file' }, { status: 500 });
  }

  let tokens;
  try {
    tokens = parseThemeCss(css);
  } catch (e) {
    console.error(`Failed to parse theme CSS for export (asset ${id}):`, e);
    return NextResponse.json({ success: false, error: 'Could not parse the theme file' }, { status: 500 });
  }

  const style = await styleService.getById(asset.style_id);
  const baseName = slugify(style?.name ?? 'theme');

  let body: string;
  let contentType: string;
  let extension: string;
  try {
    if (format === 'tailwind') {
      body = tokensToTailwindTheme(tokens);
      contentType = 'text/css';
      extension = 'css';
    } else {
      body = tokensToW3cTokens(tokens);
      contentType = 'application/json';
      extension = 'json';
    }
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${baseName}.${extension}"`,
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- assetExportRoute.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/assets/\[id\]/export/route.ts test/assetExportRoute.test.ts
git commit -m "feat: add theme export API route"
```

---

### Task 5: Export UI on the asset detail page

**Files:**
- Modify: `app/dashboard/assets/[id]/page.tsx:98-105`

**Interfaces:**
- Consumes: the route from Task 4, referenced only by URL (`/api/assets/${id}/export?format=...`) — no code import.
- Produces: nothing consumed by later tasks — this is the final task.

This task has no automated test — it's a two-line addition of static download links inside JSX that already conditionally renders for theme assets, and this project's established convention (the Storage-cleanup and Seed-Themes settings pages) is to verify UI-only changes manually rather than write a test for a static link. Verify manually per Step 2 below.

- [ ] **Step 1: Add the export links**

In `app/dashboard/assets/[id]/page.tsx`, find:
```tsx
      {asset.output_kind === 'theme' && asset.image_path && (
        <iframe
          srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
          title={`Theme preview: ${asset.prompt}`}
          sandbox=""
          style={{ width: 480, height: 320, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 24 }}
        />
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

- [ ] **Step 2: Manually verify the golden path**

1. Run `npm run dev` (or confirm the dev server is already running).
2. Navigate to a theme asset's detail page (`/dashboard/assets/<id>` for any existing theme asset — the seeded themes from the Seed Theme Library feature work well for this).
3. Confirm both "Export as Tailwind CSS" and "Export as W3C Tokens" links appear below the preview iframe.
4. Click "Export as Tailwind CSS" and confirm a `.css` file downloads with a name derived from the theme's Style Bible name, containing an `@theme { ... }` block with the expected values.
5. Click "Export as W3C Tokens" and confirm a `.json` file downloads, containing valid JSON with `color`/`font`/`dimension` groups matching the theme's values.
6. Open the downloaded W3C JSON file's contents and spot-check that a color value's `components` array looks like a plausible RGB decomposition of the original hex color (not zeros or NaN).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (all prior tests plus this feature's new tests, no regressions)

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/assets/\[id\]/page.tsx
git commit -m "feat: add theme export links to the asset detail page"
```
