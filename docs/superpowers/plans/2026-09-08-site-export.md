# Site Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a Style Bible's Pages as a real, runnable Next.js + Tailwind project written to `storage/exports/{subdir}/` — real per-component `.tsx` files (deduplicated across Pages), a shared auto-generated nav, and the Style Bible's theme mapped into Tailwind v4's `@theme` block.

**Architecture:** A new pure conversion function (`htmlToJsx`) turns already-sanitized component HTML into JSX text. A new orchestration service (`SiteExporter`) loads a style's Pages, resolves+deduplicates their component assets, converts each, and writes a complete Next.js project's files to disk. A new mutating API route exposes this, gated by session auth. A new UI section on the Style Bible Hub page triggers it.

**Tech Stack:** Next.js 16.3.4 (App Router), TypeScript 5.7, better-sqlite3, Zod, `htmlparser2` (promoted from transitive to direct dependency), the existing `postcss`-based sanitization pipeline.

**Spec:** docs/superpowers/specs/2026-09-08-site-export-design.md

## Global Constraints

- No new DB schema/migration — this feature computes from existing `pages`/`assets`/`styles` rows only.
- Direct SQL via `DatabaseConnection.getInstance().prepare(...)`, no ORM. Zod `.parse()` on every DB row read back (all reads here go through existing services, which already do this).
- Every mutating route requires `getCurrentUser(req)` (401 if null) — the export route writes files to disk, so it is mutating.
- `try/catch` + `console.error` logging on every file-system operation, matching every existing exporter/service in this codebase.
- `fs.mkdir(dir, { recursive: true })` before every file write.
- `path.join(getProjectRoot(), ...)` for all physical paths.
- Disable UI buttons on submission to prevent double-click.
- No wrapper classes/DTOs/factories/repository patterns/custom error classes (return typed `{error: '...'}` variants instead, matching `PresetService.applyPreset`'s established convention).
- `subdir` validated with `z.string().regex(/^[a-z0-9-]+$/)` (NOT `.min(1)` alone, which is `GodotExporter.ts`'s existing, out-of-scope, pre-existing gap — do not touch `GodotExporter.ts` in this plan).
- Re-sanitize component HTML/CSS (`sanitizeComponentHtml`/`sanitizeComponentCss`) at read time, matching the established defense-in-depth convention (component-serve route, page-render route).
- Exported project's pinned dependency versions: `react`/`react-dom` `^19.1.0`, `typescript` `^5.7.2`, `next` `^16.3.4` (GameForge's own current versions — confirmed directly against this repo's `package.json`, not `@latest`).
- `htmlparser2` version to pin as a new direct dependency: `^12.0.0` (confirmed directly against `node_modules/htmlparser2/package.json`'s installed version).

---

## Task 1: `htmlToJsx` pure conversion function

**Files:**
- Create: `lib/services/siteExportDocument.ts`
- Test: `test/siteExportDocument.test.ts`
- Modify: `package.json` (promote `htmlparser2` to a direct dependency)

**Interfaces:**
- Consumes: nothing from other tasks — pure function, no DB/fs/Node-only imports (same convention as `lib/services/pageDocument.ts` and `lib/services/componentDocument.ts`).
- Produces: `htmlToJsx(html: string): string` — Task 2 calls this on each distinct component's already-sanitized HTML.

- [ ] **Step 1: Promote `htmlparser2` to a direct dependency**

Edit `package.json`'s `"dependencies"` block, adding `htmlparser2` alphabetically (between `google-auth-library` and `next`):

```json
    "google-auth-library": "10.5.0",
    "htmlparser2": "^12.0.0",
    "next": "^16.3.4",
```

Run `npm install --ignore-scripts` (this machine's better-sqlite3 gyp rebuild fails without `--ignore-scripts` — see this repo's own established convention) and confirm it completes without error.

- [ ] **Step 2: Write the failing tests**

Create `test/siteExportDocument.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { htmlToJsx } from '@/lib/services/siteExportDocument';

describe('htmlToJsx', () => {
  it('converts a simple element with a class attribute to className referencing styles[...]', () => {
    const result = htmlToJsx('<button class="btn-primary">Buy now</button>');
    expect(result).toBe('<button className={styles[\'btn-primary\']}>Buy now</button>');
  });

  it('rewrites multiple space-separated classes into a template literal of styles[...] lookups', () => {
    const result = htmlToJsx('<div class="card shadow">Hi</div>');
    expect(result).toBe('<div className={`${styles[\'card\']} ${styles[\'shadow\']}`}>Hi</div>');
  });

  it('maps the "for" attribute to htmlFor', () => {
    const result = htmlToJsx('<label for="email">Email</label>');
    expect(result).toBe('<label htmlFor={"email"}>Email</label>');
  });

  it('emits a bare boolean attribute shorthand for an empty-string attribute value', () => {
    const result = htmlToJsx('<button disabled>Wait</button>');
    expect(result).toBe('<button disabled>Wait</button>');
  });

  it('self-closes void elements', () => {
    expect(htmlToJsx('<br>')).toBe('<br />');
    expect(htmlToJsx('<hr>')).toBe('<hr />');
    expect(htmlToJsx('<input type="text">')).toBe('<input type={"text"} />');
  });

  it('does not re-encode already-decoded HTML entities in text content', () => {
    const result = htmlToJsx('<p>Save &amp; enjoy</p>');
    expect(result).toBe('<p>Save & enjoy</p>');
  });

  it('escapes literal curly braces in text content so they are not read as a JSX expression', () => {
    const result = htmlToJsx('<p>Buy {now}</p>');
    expect(result).toBe('<p>{"Buy {now}"}</p>');
  });

  it('renders nested elements and preserves attributes on each level', () => {
    const result = htmlToJsx('<nav class="nav"><a href="/" class="link">Home</a></nav>');
    expect(result).toBe('<nav className={styles[\'nav\']}><a href={"/"} className={styles[\'link\']}>Home</a></nav>');
  });

  it('renders multiple top-level sibling nodes joined with no separator', () => {
    const result = htmlToJsx('<span>A</span><span>B</span>');
    expect(result).toBe('<span>A</span><span>B</span>');
  });

  it('regular (non-class, non-boolean) attribute values are wrapped as a JS string expression, not a bare quoted literal', () => {
    // JSX plain double-quoted attribute values do not follow JS string
    // escaping rules the way {"..."} does - wrapping every non-class,
    // non-boolean attribute as a JS expression container guarantees
    // correct escaping regardless of the value's content (e.g. an
    // embedded double quote), rather than relying on JSX's own,
    // less-well-specified plain-attribute-string parsing.
    const result = htmlToJsx('<a href="/a&quot;b">x</a>');
    expect(result).toBe('<a href={"/a\\"b"}>x</a>');
  });
});
```

- [ ] **Step 2b: Run tests to verify they fail**

Run: `npx vitest run test/siteExportDocument.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/siteExportDocument'`.

- [ ] **Step 3: Write the implementation**

Create `lib/services/siteExportDocument.ts`:

```ts
// lib/services/siteExportDocument.ts
//
// Pure HTML -> JSX text conversion, used only by SiteExporter.ts at
// export time. No DB/fs/Node-only imports - same convention as
// pageDocument.ts and componentDocument.ts. The input HTML has ALREADY
// passed sanitizeComponentHtml, so only the small, fully-known
// ALLOWED_TAGS/ALLOWED_ATTRIBUTES vocabulary from componentSanitize.ts
// can appear here - this function does not need to handle arbitrary
// HTML-in-the-wild edge cases.
//
// The emitted JSX assumes a `styles` import is in scope (a CSS Module,
// e.g. `import styles from './Button-a1b2c3.module.css'`) - SiteExporter.ts
// is responsible for actually writing that import into the generated
// .tsx file; this function only emits the `styles['class-name']`
// reference text.

import { parseDocument } from 'htmlparser2';

interface ParsedNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: ParsedNode[];
}

const ATTRIBUTE_NAME_MAP: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
};

const VOID_ELEMENTS = new Set(['br', 'hr', 'input']);

function escapeJsxText(text: string): string {
  if (!text.includes('{') && !text.includes('}')) return text;
  return `{${JSON.stringify(text)}}`;
}

function renderClassAttribute(value: string): string {
  const classNames = value.split(/\s+/).filter(Boolean);
  if (classNames.length === 1) {
    return `className={styles[${JSON.stringify(classNames[0])}]}`;
  }
  const lookups = classNames.map(c => `\${styles[${JSON.stringify(c)}]}`).join(' ');
  return `className={\`${lookups}\`}`;
}

function renderAttributes(attribs: Record<string, string>): string {
  return Object.entries(attribs).map(([name, value]) => {
    if (name === 'class') return renderClassAttribute(value);
    const jsxName = ATTRIBUTE_NAME_MAP[name] ?? name;
    if (value === '') return jsxName; // boolean attribute shorthand, e.g. `disabled`
    // Wrapped as a JS string expression ({"..."}), not a bare
    // double-quoted JSX literal - JSX's plain-attribute-string escaping
    // is not the same as JS string escaping, so this guarantees correct
    // escaping via JSON.stringify regardless of the value's content.
    return `${jsxName}={${JSON.stringify(value)}}`;
  }).join(' ');
}

function renderNode(node: ParsedNode): string {
  if (node.type === 'text') {
    return escapeJsxText(node.data ?? '');
  }
  if (node.type === 'tag' && node.name) {
    const attrs = renderAttributes(node.attribs ?? {});
    const attrsStr = attrs ? ` ${attrs}` : '';
    if (VOID_ELEMENTS.has(node.name)) {
      return `<${node.name}${attrsStr} />`;
    }
    const children = (node.children ?? []).map(renderNode).join('');
    return `<${node.name}${attrsStr}>${children}</${node.name}>`;
  }
  return '';
}

export function htmlToJsx(html: string): string {
  const doc = parseDocument(html) as unknown as { children: ParsedNode[] };
  return doc.children.map(renderNode).join('');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/siteExportDocument.test.ts`
Expected: PASS (10/10).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/services/siteExportDocument.ts test/siteExportDocument.test.ts
git commit -m "feat: add htmlToJsx pure conversion function"
```

---

## Task 2: `SiteExporter` service

**Files:**
- Create: `lib/services/SiteExporter.ts`
- Test: `test/siteExporter.test.ts`

**Interfaces:**
- Consumes: `htmlToJsx(html: string): string` (Task 1); `pageService.getActivePagesForStyle(styleId: string): Promise<Page[]>` (existing, returns **newest-first**, `ORDER BY created_at DESC` — confirmed directly against `lib/services/PageService.ts`); `assetService.getById(id: string): Promise<Asset | null>` and `assetService.loadThemeCssForStyle(styleId: string | null): Promise<string | null>` (existing, `lib/services/AssetService.ts`); `parseComponentHtml(document: string): ComponentTokens` (existing, `lib/services/componentDocument.ts`); `sanitizeComponentHtml`/`sanitizeComponentCss` (existing, `lib/services/componentSanitize.ts`); `parseThemeCss(css: string): ThemeTokens` (existing, re-exported from `lib/services/ThemeGenerator.ts`); `tokensToTailwindTheme(tokens: ThemeTokens): string` (existing, `lib/services/themeExport/tailwindExporter.ts`).
- Produces: `siteExporter.exportSite(styleId: string, subdir: string): Promise<{pagesExported: number; componentsExported: number; targetDir: string} | {error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS'}>` — Task 3's route calls this.

- [ ] **Step 1: Write the failing tests**

Create `test/siteExporter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { siteExporter } from '@/lib/services/SiteExporter';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-siteexport-'));
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

async function makeComponentAsset(styleId: string, filename: string, document: string) {
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), document);
  return assetService.create({
    styleId,
    createdBy: 'user-1',
    assetType: 'button',
    prompt: 'a button',
    imagePath: filename,
    outputKind: 'component',
  });
}

const COMPONENT_DOC = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head><body><button class="btn">Go</button></body></html>';

describe('siteExporter.exportSite', () => {
  it('exports two pages, deduplicating a component shared by both into one file', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const shared = await makeComponentAsset(style.id, 'shared.html', COMPONENT_DOC);
    const pageA = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const pageB = await pageService.create({ styleId: style.id, name: 'About', createdBy: 'user-1' });
    await pageService.update(pageA.id, { componentAssetIds: JSON.stringify([shared.id]) });
    await pageService.update(pageB.id, { componentAssetIds: JSON.stringify([shared.id]) });

    const result = await siteExporter.exportSite(style.id, 'test-export');
    expect(result).not.toHaveProperty('error');
    const ok = result as { pagesExported: number; componentsExported: number; targetDir: string };
    expect(ok.pagesExported).toBe(2);
    expect(ok.componentsExported).toBe(1);

    const componentFiles = await fsPromises.readdir(path.join(ok.targetDir, 'components'));
    const tsxFiles = componentFiles.filter(f => f.endsWith('.tsx'));
    expect(tsxFiles.length).toBe(1);
  });

  it('selects the oldest-created page as home (app/page.tsx), despite getActivePagesForStyle returning newest-first', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'First', createdBy: 'user-1' });
    await new Promise(r => setTimeout(r, 5));
    await pageService.create({ styleId: style.id, name: 'Second', createdBy: 'user-1' });

    const result = await siteExporter.exportSite(style.id, 'test-home');
    const ok = result as { targetDir: string };
    // buildPageFile's output has no page-name text in it (it only emits
    // component imports/JSX) - so home-selection is proven by WHICH
    // slug directory exists, not by content. "First" (oldest) must be
    // the home page (app/page.tsx, no slug dir of its own); "Second"
    // (newest) must get its own slugified route directory.
    await expect(fsPromises.access(path.join(ok.targetDir, 'app', 'page.tsx'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(ok.targetDir, 'app', 'first'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(ok.targetDir, 'app', 'second', 'page.tsx'))).resolves.toBeUndefined();
  });

  it('skips a stale (deleted) component reference without failing the export', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const valid = await makeComponentAsset(style.id, 'valid.html', COMPONENT_DOC);
    const stale = await makeComponentAsset(style.id, 'stale.html', COMPONENT_DOC);
    await assetService.softDelete(stale.id);
    const page = await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    await pageService.update(page.id, { componentAssetIds: JSON.stringify([valid.id, stale.id]) });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await siteExporter.exportSite(style.id, 'test-stale');
      expect(result).not.toHaveProperty('error');
      const ok = result as { componentsExported: number };
      expect(ok.componentsExported).toBe(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns NOTHING_TO_EXPORT for a style with zero pages', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const result = await siteExporter.exportSite(style.id, 'test-empty');
    expect(result).toEqual({ error: 'NOTHING_TO_EXPORT' });
  });

  it('returns ALREADY_EXISTS if the target subdir already exists', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const first = await siteExporter.exportSite(style.id, 'test-dup');
    expect(first).not.toHaveProperty('error');
    const second = await siteExporter.exportSite(style.id, 'test-dup');
    expect(second).toEqual({ error: 'ALREADY_EXISTS' });
  });

  it('writes a package.json with the pinned dependency versions and a package.json in the exported project', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const result = await siteExporter.exportSite(style.id, 'test-pkg');
    const ok = result as { targetDir: string };
    const pkg = JSON.parse(await fsPromises.readFile(path.join(ok.targetDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies.next).toBe('^16.3.4');
    expect(pkg.dependencies.react).toBe('^19.1.0');
    expect(pkg.scripts.dev).toBe('next dev');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/siteExporter.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/SiteExporter'`.

- [ ] **Step 3: Write the implementation**

Create `lib/services/SiteExporter.ts`:

```ts
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import { htmlToJsx } from '@/lib/services/siteExportDocument';
import type { Page, Asset } from '@/lib/database/schema';

export interface SiteExportResult {
  pagesExported: number;
  componentsExported: number;
  targetDir: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pascalCase(name: string): string {
  return name.replace(/(^|[-_\s]+)([a-z0-9])/gi, (_m, _sep, ch) => ch.toUpperCase());
}

function componentName(asset: Asset): string {
  return `${pascalCase(asset.asset_type)}${asset.id.replace(/-/g, '').slice(0, 6)}`;
}

interface ConvertedComponent {
  asset: Asset;
  componentName: string;
  jsx: string;
  css: string;
}

class SiteExporterImpl {
  async exportSite(styleId: string, subdir: string): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' }> {
    const pagesNewestFirst = await pageService.getActivePagesForStyle(styleId);
    if (pagesNewestFirst.length === 0) {
      return { error: 'NOTHING_TO_EXPORT' };
    }
    // getActivePagesForStyle returns newest-first (ORDER BY created_at
    // DESC) - reverse to oldest-first so pages[0] is the home page and
    // the nav lists pages in creation order.
    const pages: Page[] = [...pagesNewestFirst].reverse();

    const targetDir = path.join(getProjectRoot(), 'storage', 'exports', subdir);
    try {
      await fsPromises.access(targetDir);
      return { error: 'ALREADY_EXISTS' };
    } catch {
      // ENOENT is the expected, non-error case - the target doesn't exist yet.
    }

    const componentsByAssetId = new Map<string, ConvertedComponent>();
    const pageComponentNames: string[][] = [];

    for (const page of pages) {
      const assetIds = JSON.parse(page.component_asset_ids) as string[];
      const namesForThisPage: string[] = [];
      for (const assetId of assetIds) {
        if (!componentsByAssetId.has(assetId)) {
          const converted = await this.convertComponent(assetId, page.id);
          if (!converted) continue;
          componentsByAssetId.set(assetId, converted);
        }
        namesForThisPage.push(componentsByAssetId.get(assetId)!.componentName);
      }
      pageComponentNames.push(namesForThisPage);
    }

    const components = [...componentsByAssetId.values()];

    try {
      await fsPromises.mkdir(path.join(targetDir, 'app'), { recursive: true });
      await fsPromises.mkdir(path.join(targetDir, 'components'), { recursive: true });

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

      const themeCss = await assetService.loadThemeCssForStyle(styleId);
      let themeBlock = '';
      if (themeCss) {
        try {
          themeBlock = tokensToTailwindTheme(parseThemeCss(themeCss));
        } catch (e) {
          console.error(`Could not convert theme CSS to Tailwind theme for style ${styleId}, exporting without it:`, e);
        }
      }
      await fsPromises.writeFile(
        path.join(targetDir, 'app', 'globals.css'),
        `@import "tailwindcss";\n\n${themeBlock}`
      );

      const slugs = this.buildPageSlugs(pages);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'layout.tsx'), this.buildLayoutFile(pages, slugs));
      await fsPromises.writeFile(path.join(targetDir, 'app', 'page.tsx'), this.buildPageFile(pages[0], pageComponentNames[0], components));

      for (let i = 1; i < pages.length; i++) {
        const pageDir = path.join(targetDir, 'app', slugs[i]);
        await fsPromises.mkdir(pageDir, { recursive: true });
        await fsPromises.writeFile(path.join(pageDir, 'page.tsx'), this.buildPageFile(pages[i], pageComponentNames[i], components));
      }

      await fsPromises.writeFile(path.join(targetDir, 'package.json'), this.buildPackageJson());
      await fsPromises.writeFile(path.join(targetDir, 'tsconfig.json'), this.buildTsConfig());
    } catch (e) {
      console.error(`Failed to write exported site files to ${targetDir}:`, e);
      throw e;
    }

    return { pagesExported: pages.length, componentsExported: components.length, targetDir };
  }

  private async convertComponent(assetId: string, pageId: string): Promise<ConvertedComponent | null> {
    try {
      const asset = await assetService.getById(assetId);
      if (!asset || asset.is_deleted || asset.output_kind !== 'component' || !asset.image_path) {
        console.error(`Page ${pageId} references a stale/invalid component asset ${assetId}, skipping`);
        return null;
      }
      const filename = asset.image_path;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        console.error(`Page ${pageId} references a component asset ${assetId} with an unsafe filename, skipping`);
        return null;
      }
      const document = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', filename), 'utf-8');
      const tokens = parseComponentHtml(document);
      const html = sanitizeComponentHtml(tokens.html);
      const css = sanitizeComponentCss(tokens.css);
      return { asset, componentName: componentName(asset), jsx: htmlToJsx(html), css };
    } catch (e) {
      console.error(`Failed to convert component asset ${assetId} for export, skipping:`, e);
      return null;
    }
  }

  private buildComponentFile(component: ConvertedComponent): string {
    return `import styles from './${component.componentName}.module.css';

export function ${component.componentName}() {
  return (
    <>
${component.jsx}
    </>
  );
}
`;
  }

  private buildPageSlugs(pages: Page[]): string[] {
    const used = new Set<string>();
    return pages.map((page, i) => {
      if (i === 0) return ''; // home page has no slug directory
      let slug = slugify(page.name) || 'page';
      if (used.has(slug)) {
        slug = `${slug}-${page.id.replace(/-/g, '').slice(0, 6)}`;
      }
      used.add(slug);
      return slug;
    });
  }

  private buildLayoutFile(pages: Page[], slugs: string[]): string {
    const links = pages.map((page, i) => {
      const href = i === 0 ? '/' : `/${slugs[i]}`;
      return `        <a href="${href}">${page.name}</a>`;
    }).join('\n');
    return `import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ display: 'flex', gap: 16, padding: 16 }}>
${links}
        </nav>
        {children}
      </body>
    </html>
  );
}
`;
  }

  private buildPageFile(page: Page, componentNames: string[], allComponents: ConvertedComponent[]): string {
    const usedComponents = allComponents.filter(c => componentNames.includes(c.componentName));
    const imports = usedComponents.map(c => `import { ${c.componentName} } from '@/components/${c.componentName}';`).join('\n');
    const elements = componentNames.map(name => `      <${name} />`).join('\n');
    return `${imports}

export default function Page() {
  return (
    <>
${elements}
    </>
  );
}
`;
  }

  private buildPackageJson(): string {
    return JSON.stringify({
      name: 'exported-site',
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
      },
      dependencies: {
        next: '^16.3.4',
        react: '^19.1.0',
        'react-dom': '^19.1.0',
        tailwindcss: '^4.0.0',
      },
      devDependencies: {
        typescript: '^5.7.2',
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
        '@types/node': '^24.0.0',
      },
    }, null, 2);
  }

  private buildTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        paths: { '@/*': ['./*'] },
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    }, null, 2);
  }
}

export const siteExporter = new SiteExporterImpl();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/siteExporter.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/SiteExporter.ts test/siteExporter.test.ts
git commit -m "feat: add SiteExporter service"
```

---

## Task 3: `POST /api/styles/[id]/site-export` route

**Files:**
- Create: `app/api/styles/[id]/site-export/route.ts`
- Test: `test/siteExportRoute.test.ts`

**Interfaces:**
- Consumes: `siteExporter.exportSite(styleId, subdir)` (Task 2); `getCurrentUser(req)` (existing, `lib/utils/session.ts`).
- Produces: `POST /api/styles/[id]/site-export` — Task 4's UI calls this.

- [ ] **Step 1: Write the failing test**

Create `test/siteExportRoute.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { pageService } from '@/lib/services/PageService';
import { seedSession } from '@/test/helpers/testSession';
import { POST } from '@/app/api/styles/[id]/site-export/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-siteexportroute-'));
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

describe('POST /api/styles/[id]/site-export', () => {
  it('returns 401 when not logged in', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ subdir: 'test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(401);
  });

  it('exports when logged in and returns page/component counts', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await pageService.create({ styleId: style.id, name: 'Home', createdBy: 'user-1' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: 'route-test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.pagesExported).toBe(1);
  });

  it('rejects an invalid subdir', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: '../escape' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a style with no pages', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const { cookieHeader } = await seedSession('Test User');
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ subdir: 'empty-test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
```

`seedSession`'s real signature (confirmed directly against `test/helpers/testSession.ts` while writing this plan): `seedSession(name = 'Test User'): Promise<{ userId: string; cookieHeader: string }>` — it creates a real user via `userService.create({name})` and a real session via `sessionService.create(user.id)`, returning the cookie as `cookieHeader: \`session=${token}\``. The seeded user's id is unrelated to any `createdBy: 'user-1'` string used elsewhere in these tests — harmless, since this route only checks that SOME user is logged in (`getCurrentUser`), not that they match `created_by`, matching this codebase's consistent no-ownership-check convention for jobs/assets/pages/presets.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/siteExportRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/styles/[id]/site-export/route'`.

- [ ] **Step 3: Write the implementation**

Create `app/api/styles/[id]/site-export/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { siteExporter } from '@/lib/services/SiteExporter';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const SiteExportSchema = z.object({
  subdir: z.string().regex(/^[a-z0-9-]+$/, 'subdir must contain only lowercase letters, numbers, and hyphens'),
});

const ERROR_MESSAGES: Record<string, string> = {
  NOTHING_TO_EXPORT: 'This Style Bible has no pages to export.',
  ALREADY_EXISTS: 'That folder name is already used — pick another.',
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = SiteExportSchema.parse(await req.json());
    const result = await siteExporter.exportSite(id, input.subdir);

    if ('error' in result) {
      return NextResponse.json({ success: false, error: ERROR_MESSAGES[result.error] }, { status: 400 });
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

Run: `npx vitest run test/siteExportRoute.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/styles/[id]/site-export/route.ts test/siteExportRoute.test.ts
git commit -m "feat: add POST /api/styles/[id]/site-export route"
```

---

## Task 4: "Export site" section on the Style Bible Hub page

**Files:**
- Modify: `app/dashboard/styles/[id]/page.tsx`

**Interfaces:**
- Consumes: `POST /api/styles/[id]/site-export` (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Read the current file in full**

Read `app/dashboard/styles/[id]/page.tsx`'s CURRENT state directly before editing (confirmed during this plan's own research: it currently has state through `showSavePreset`/`savePresetStatus`, a "Pages" section ending around line 356, then a "Save as preset" card at line 358). Confirm exact current line numbers before making changes — this file has been modified many times this session and may have shifted further.

- [ ] **Step 2: Add state**

Add near the existing Pages-related state (after `pageError`):

```ts
  const [exportSubdir, setExportSubdir] = useState('my-site');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ pagesExported: number; componentsExported: number; targetDir: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
```

- [ ] **Step 3: Add the handler**

Add near the other page handlers (after `handleDeletePage`):

```ts
  async function handleExportSite(e: React.FormEvent) {
    e.preventDefault();
    if (exporting || !exportSubdir.trim()) return;
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      const res = await fetch(`/api/styles/${id}/site-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: exportSubdir.trim() }),
      });
      const body = await res.json();
      if (body.success) {
        setExportResult(body.data);
      } else {
        setExportError(body.error ?? 'Export failed.');
      }
    } catch {
      setExportError('Could not reach the server.');
    } finally {
      setExporting(false);
    }
  }
```

- [ ] **Step 4: Add the JSX section**

Place this after the existing "Pages" section's closing `</div>` and before the "Save as preset" card:

```tsx
      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Export site</h2>
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 12 }}>
          Writes a real Next.js + Tailwind project to <code>storage/exports/</code> containing every
          Page in this Style Bible, ready for <code>npm install &amp;&amp; npm run dev</code>.
        </p>
        <form onSubmit={handleExportSite} style={{ display: 'flex', gap: 10 }}>
          <input
            value={exportSubdir}
            onChange={e => setExportSubdir(e.target.value)}
            placeholder="my-site"
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
          />
          <button className="btn btn-primary" type="submit" disabled={exporting || !exportSubdir.trim()}>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </form>
        {exportError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 10 }}>{exportError}</p>}
        {exportResult && (
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 10 }}>
            Exported {exportResult.pagesExported} page{exportResult.pagesExported === 1 ? '' : 's'} and{' '}
            {exportResult.componentsExported} component{exportResult.componentsExported === 1 ? '' : 's'} to{' '}
            <code>{exportResult.targetDir}</code>.
          </p>
        )}
      </div>
```

- [ ] **Step 5: Manually verify**

No dedicated test — matches this codebase's established convention of zero `.test.tsx` files. Run `npx tsc --noEmit` to confirm the file compiles. Full exercise happens in Task 5's manual browser walkthrough.

- [ ] **Step 6: Commit**

```bash
git add "app/dashboard/styles/[id]/page.tsx"
git commit -m "feat: add Export site section to the Style Bible Hub page"
```

---

## Task 5: Final verification

**Files:** None created or modified — this task only runs checks.

**Interfaces:** None.

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: every test file passes, including all new files from Tasks 1-3.

- [ ] **Step 3: Grep sweep for wiring completeness**

Run:
```bash
grep -rn "siteExporter" lib/ app/ --include='*.ts'
grep -rn "htmlToJsx" lib/ --include='*.ts'
grep -n "site-export" "app/dashboard/styles/[id]/page.tsx"
```
Expected: `siteExporter` used in its own service file plus the route file; `htmlToJsx` used in `siteExportDocument.ts` (definition) and `SiteExporter.ts` (call site); the Hub page grep returns at least one match (the fetch call).

- [ ] **Step 4: Manual browser + exported-project verification**

Start the dev server (`npm run dev`). Create a test account if needed. Create a Style Bible, generate or directly insert 2+ promoted component assets and 2+ Pages if none exist in the fresh worktree's DB — reuse at least one component asset across both Pages so deduplication is actually exercised (a direct DB insert for verification purposes is fine here, matching this session's established pattern — clean it up afterward). Then:

1. Open the Style Bible Hub page, use the new "Export site" form, export to a subdir like `verify-export`.
2. Confirm the success message shows the right page/component counts.
3. In a terminal, `cd storage/exports/verify-export`, run `npm install`, then `npm run dev` (on a different port if 3000 is taken by GameForge itself — Next.js will prompt to use another port automatically).
4. Open the exported site in a browser. Confirm: the nav bar lists both Pages and both links work; the shared component renders identically on both pages (proving deduplication didn't break anything); Tailwind's `@theme` colors are visible if any component or the theme CSS references them.
5. Stop the exported project's dev server.

Clean up any test accounts/data/exported folders created purely for this verification afterward (matches the established discipline from every prior feature's final task this session) — do not leave throwaway rows in `data.db` or folders under `storage/exports/`.

- [ ] **Step 5: Commit (if Step 4 surfaced any fixes)**

Only if manual verification found something to fix. Otherwise this task ends at Step 4.
