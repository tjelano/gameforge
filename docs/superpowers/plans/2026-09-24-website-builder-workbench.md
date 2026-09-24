# Website Builder Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single new dashboard page (`/dashboard/website`) that lets a user pick a Style Bible, build/edit a Page from its components, see it live, and click any element in the live preview to apply an AI-mediated edit — all without leaving the page — plus a nav restructure that visually separates "Website" tools from "Assets" tools.

**Architecture:** A new client page composes four already-shipped pieces (`StyleBiblePicker`, `PageEditor`, `PreviewFrame`, `JobCard`) around one new server capability: an "editable" render mode for `/api/pages/[id]/render` that keeps each composed component's `data-gf-id`s and tags it with its own asset id + content hash, so `PreviewFrame`'s existing click-to-select machinery (built for single-component editing in PR #32) can resolve a click inside a *composed* page back to the right component and PATCH it through the existing per-component patch endpoint. No new AI pipeline, no new patch endpoint, no new sandbox relaxation beyond what PR #32 already shipped.

**Tech Stack:** Next.js App Router, TypeScript, Zod, better-sqlite3 (via existing services), Vitest + @testing-library/react, postcss (already a dependency, used by `pageDocument.ts`).

**Spec:** `docs/superpowers/specs/2026-09-24-website-builder-workbench-design.md`

## Global Constraints

- Never add `allow-scripts` to the preview iframe's sandbox, in any mode. (Spec, Security section.)
- All iframe-DOM reads stay inside `lib/preview/inspectFrame.ts` — no new file reads `iframe.contentDocument`. (Spec, Security section.)
- The render route's CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:;`) is unchanged. (Spec, Security section.)
- Non-editable rendering (`/api/pages/[id]/render` with no `editable` param, used by export/download) must remain byte-for-byte unaffected by every change in this plan. (Spec, Testing section.)
- This feature reuses `/api/assets/[id]/component/patch-element` unchanged — no new backend patch endpoint. (Spec, Data flow section.)
- No new top-level npm dependency.

---

## Task 1: Editable page composition in `pageDocument.ts`

**Files:**
- Modify: `lib/services/pageDocument.ts`
- Test: `test/pageDocument.test.ts`

**Interfaces:**
- Consumes: nothing new (pure module, `postcss` already imported).
- Produces:
  - `export interface EditablePageComponentTokens extends PageComponentTokens { assetId: string; revisionHash: string; }`
  - `export function composeEditablePageHtml(items: EditablePageComponentTokens[], themeCss?: string): string` — same output shape as `composePageHtml`, except each item's wrapper div also carries `data-gf-component-asset-id="<assetId>"` and `data-gf-rev="<revisionHash>"`.
  - `composePageHtml`'s existing signature and behavior are unchanged (Task 3 will pass it `EditablePageComponentTokens[]`, which is structurally assignable to `PageComponentTokens[]`, and it will ignore the extra fields).

- [ ] **Step 1: Write the failing tests**

Append to `test/pageDocument.test.ts`:

```ts
describe('composeEditablePageHtml', () => {
  it('wraps each component with its asset id and revision hash as data attributes', () => {
    const html = composeEditablePageHtml([
      { html: '<button class="btn">A</button>', css: '.btn { color: red; }', assetId: 'asset-1', revisionHash: 'hash-1' },
      { html: '<button class="btn">B</button>', css: '.btn { color: blue; }', assetId: 'asset-2', revisionHash: 'hash-2' },
    ]);
    expect(html).toContain('data-gf-component-asset-id="asset-1"');
    expect(html).toContain('data-gf-rev="hash-1"');
    expect(html).toContain('data-gf-component-asset-id="asset-2"');
    expect(html).toContain('data-gf-rev="hash-2"');
  });

  it('still scopes CSS per item the same way composePageHtml does', () => {
    const html = composeEditablePageHtml([
      { html: '<div class="title">A</div>', css: '.title { color: red; }', assetId: 'a1', revisionHash: 'h1' },
      { html: '<div class="title">B</div>', css: '.title { color: blue; }', assetId: 'a2', revisionHash: 'h2' },
    ]);
    const matches = [...html.matchAll(/(\.page-item-\d+)\s+\.title/g)].map(m => m[1]);
    expect(new Set(matches).size).toBe(2);
  });

  it('produces the exact same output as composePageHtml when the extra fields are stripped, proving no drift between the two wrapper shapes', () => {
    const plainItems = [
      { html: '<p>hi</p>', css: '.a { color: red; }' },
      { html: '<p>bye</p>', css: '.b { color: blue; }' },
    ];
    const editableItems = plainItems.map((item, i) => ({ ...item, assetId: `asset-${i}`, revisionHash: `hash-${i}` }));
    const plain = composePageHtml(plainItems);
    const editable = composeEditablePageHtml(editableItems)
      .replace(/ data-gf-component-asset-id="[^"]*"/g, '')
      .replace(/ data-gf-rev="[^"]*"/g, '');
    expect(editable).toBe(plain);
  });
});

it('composePageHtml output is unaffected by the existence of composeEditablePageHtml (regression guard)', () => {
  const html = composePageHtml([{ html: '<p>hi</p>', css: '.a { color: red; }' }]);
  expect(html).not.toContain('data-gf-component-asset-id');
  expect(html).not.toContain('data-gf-rev');
});
```

Update the top import line of `test/pageDocument.test.ts` to:

```ts
import { composePageHtml, composeEditablePageHtml } from '@/lib/services/pageDocument';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pageDocument.test.ts`
Expected: FAIL — `composeEditablePageHtml is not a function` / `does not exist`.

- [ ] **Step 3: Implement `composeEditablePageHtml`**

Replace the body of `lib/services/pageDocument.ts` from the `composePageHtml` export onward with:

```ts
export interface EditablePageComponentTokens extends PageComponentTokens {
  // assetId is always a crypto.randomUUID() from AssetService.create() (never user-typed) and
  // revisionHash is always a sha256 hex digest from componentElementTree.ts's hashDocument() — both
  // charsets are always attribute-safe, so no escaping is needed when splicing them into the
  // wrapper div below (same reasoning PageService.ts's findPagesReferencingAsset uses for its own
  // unescaped LIKE-pattern interpolation).
  assetId: string;
  revisionHash: string;
}

function composeItems(
  items: PageComponentTokens[],
  themeCss: string | undefined,
  wrapperAttrsFor: (item: PageComponentTokens, i: number) => string,
): string {
  const styleBlocks: string[] = [];
  const bodyBlocks: string[] = [];

  items.forEach((item, i) => {
    const scopeClass = `page-item-${i}`;
    styleBlocks.push(scopeComponentCss(item.css, scopeClass));
    bodyBlocks.push(`<div class="${scopeClass}"${wrapperAttrsFor(item, i)}>\n${item.html}\n</div>`);
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

export function composePageHtml(items: PageComponentTokens[], themeCss?: string): string {
  return composeItems(items, themeCss, () => '');
}

// Used by the render route's editable mode (Task 3) for the workbench's live, click-to-edit
// preview. Never used for export/download — that path always calls composePageHtml above, whose
// output is untouched by this function's existence (see the regression test in
// test/pageDocument.test.ts).
export function composeEditablePageHtml(items: EditablePageComponentTokens[], themeCss?: string): string {
  return composeItems(items, themeCss, (item) => {
    const editable = item as EditablePageComponentTokens;
    return ` data-gf-component-asset-id="${editable.assetId}" data-gf-rev="${editable.revisionHash}"`;
  });
}
```

Leave `scopeComponentCss` and the `PageComponentTokens` interface above this block exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pageDocument.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add lib/services/pageDocument.ts test/pageDocument.test.ts
git commit -m "feat: add composeEditablePageHtml for the workbench's live editable preview

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `componentAssetId`/`componentRevisionHash` in `inspectFrame.ts`

**Files:**
- Modify: `lib/preview/inspectFrame.ts`
- Test: `test/inspectFrame.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FrameElementInfo` gains two required fields, `componentAssetId: string | null` and `componentRevisionHash: string | null`, populated by `getElementAt()` via `el.closest('[data-gf-component-asset-id]')` — the wrapper div `composeEditablePageHtml` (Task 1) produces. Every other export (`getRevisionHash`, `preventFrameAnchorNavigation`, `injectHighlight`, `removeHighlight`) is unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/inspectFrame.test.ts`, update the existing narrow-shape assertion (line ~75) from:

```ts
    expect(Object.keys(info!).sort()).toEqual(['classes', 'dataGfId', 'id', 'rect', 'tagName']);
```

to:

```ts
    expect(Object.keys(info!).sort()).toEqual(['classes', 'componentAssetId', 'componentRevisionHash', 'dataGfId', 'id', 'rect', 'tagName']);
```

Then add these new tests inside the `describe('inspectFrame', ...)` block, after the existing `data-gf-id` ancestor tests:

```ts
  it('getElementAt resolves componentAssetId and componentRevisionHash from the nearest data-gf-component-asset-id wrapper', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <div class="page-item-0" data-gf-component-asset-id="asset-1" data-gf-rev="hash-1">
          <button class="btn" data-gf-id="1">Go</button>
        </div>
        <div class="page-item-1" data-gf-component-asset-id="asset-2" data-gf-rev="hash-2">
          <button class="btn" data-gf-id="1">Also Go</button>
        </div>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const buttons = iframe.contentDocument!.querySelectorAll('button');
    buttons[0].getBoundingClientRect = () => new DOMRect(0, 0, 80, 30);
    buttons[1].getBoundingClientRect = () => new DOMRect(0, 40, 80, 30);

    const first = getElementAt(iframe, 10, 10);
    expect(first).not.toBeNull();
    expect(first!.componentAssetId).toBe('asset-1');
    expect(first!.componentRevisionHash).toBe('hash-1');

    // Two different wrapped components reuse the same data-gf-id ("1") -- confirms resolution is
    // scoped per-wrapper, not accidentally global across the composed page.
    const second = getElementAt(iframe, 10, 50);
    expect(second).not.toBeNull();
    expect(second!.componentAssetId).toBe('asset-2');
    expect(second!.componentRevisionHash).toBe('hash-2');
  });

  it('getElementAt resolves componentAssetId through an icon-inside-button, same as the data-gf-id ancestor walk', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <div class="page-item-0" data-gf-component-asset-id="asset-1" data-gf-rev="hash-1">
          <button class="icon-btn" data-gf-id="1"><svg><circle cx="5" cy="5" r="5"></circle></svg></button>
        </div>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const btn = iframe.contentDocument!.querySelector('button')!;
    const svg = iframe.contentDocument!.querySelector('svg')!;
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    svg.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    const info = getElementAt(iframe, 110, 60);
    expect(info).not.toBeNull();
    expect(info!.componentAssetId).toBe('asset-1');
  });

  it('getElementAt returns null componentAssetId/componentRevisionHash outside any wrapper (non-page-mode content)', () => {
    const btn = iframe.contentDocument!.querySelector('button')!;
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    const rect = btn.getBoundingClientRect();
    const info = getElementAt(iframe, rect.left + 1, rect.top + 1);
    expect(info).not.toBeNull();
    expect(info!.componentAssetId).toBeNull();
    expect(info!.componentRevisionHash).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inspectFrame.test.ts`
Expected: FAIL — the narrow-shape assertion fails (missing keys), and the new tests fail with `componentAssetId` being `undefined`, not `'asset-1'`/`null`.

- [ ] **Step 3: Implement the new fields**

In `lib/preview/inspectFrame.ts`, change the `FrameElementInfo` interface to:

```ts
export interface FrameElementInfo {
  // Every string field below is read out of AI-generated or hand-edited preview markup — it is
  // attacker-influenced content, not GameForge's own trusted text. Render it as plain text (JSX
  // interpolation, which auto-escapes) — never via dangerouslySetInnerHTML, and never interpolated
  // into a CSS or query selector string.
  tagName: string;
  classes: string[];
  id: string | null; // the DOM `id` attribute the element may carry, NOT data-gf-id
  dataGfId: string | null;
  // Populated only inside a page-mode composed document (composeEditablePageHtml, Task 1 of the
  // website-builder-workbench plan) -- null for a single-component preview or any click that lands
  // outside every composed item's wrapper.
  componentAssetId: string | null;
  componentRevisionHash: string | null;
  rect: DOMRect;
}
```

Then in `getElementAt()`, change the `return` statement from:

```ts
  const target = el.closest<HTMLElement>('[data-gf-id]') ?? el;
  const rect = target.getBoundingClientRect();
  return {
    tagName: target.tagName.toLowerCase(),
    classes: Array.from(target.classList),
    id: target.id || null,
    // `|| null`, not a bare attribute read: getAttribute returns "" (not null) for a literal
    // empty attribute value. A stray `data-gf-id=""` in hand-edited content must still mean
    // "absent" — not "has a value" — to satisfy the "null means absent/unselectable" contract
    // ElementPatchPanel's `dataGfId === null` check relies on.
    dataGfId: target.getAttribute('data-gf-id') || null,
    rect,
  };
```

to:

```ts
  const target = el.closest<HTMLElement>('[data-gf-id]') ?? el;
  const rect = target.getBoundingClientRect();
  // Independent of `target` above -- a page-mode wrapper (composeEditablePageHtml) is an ancestor
  // of whatever data-gf-id element target resolved to, so walking from `el` (inclusive) finds the
  // same nearest wrapper either way. Null for single-component previews, which never emit this
  // attribute at all.
  const componentWrapper = el.closest<HTMLElement>('[data-gf-component-asset-id]');
  return {
    tagName: target.tagName.toLowerCase(),
    classes: Array.from(target.classList),
    id: target.id || null,
    // `|| null`, not a bare attribute read: getAttribute returns "" (not null) for a literal
    // empty attribute value. A stray `data-gf-id=""` in hand-edited content must still mean
    // "absent" — not "has a value" — to satisfy the "null means absent/unselectable" contract
    // ElementPatchPanel's `dataGfId === null` check relies on.
    dataGfId: target.getAttribute('data-gf-id') || null,
    componentAssetId: componentWrapper?.getAttribute('data-gf-component-asset-id') || null,
    componentRevisionHash: componentWrapper?.getAttribute('data-gf-rev') || null,
    rect,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inspectFrame.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add lib/preview/inspectFrame.ts test/inspectFrame.test.ts
git commit -m "feat: resolve componentAssetId/componentRevisionHash from page-mode wrappers in inspectFrame

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `?editable=1` mode on the page render route

**Files:**
- Modify: `app/api/pages/[id]/render/route.ts`
- Test: `test/pageRenderRoute.test.ts`

**Interfaces:**
- Consumes: `composeEditablePageHtml`, `EditablePageComponentTokens` (Task 1); `hashDocument` from `lib/services/componentElementTree.ts` (already exported, `hashDocument(rawBytes: string): string`).
- Produces: `GET /api/pages/[id]/render?editable=1` returns the same page, but with `data-gf-id`s preserved and each component wrapped with `data-gf-component-asset-id`/`data-gf-rev` (Task 1's wrapper). Without `?editable=1`, behavior is byte-for-byte unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/pageRenderRoute.test.ts`, inside the existing `describe('GET /api/pages/[id]/render', ...)` block:

```ts
  it('with ?editable=1, keeps data-gf-id and wraps each component with its asset id and a content hash', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head>'
      + '<body><button data-gf-id="1" class="btn gf-1">Go</button></body></html>';
    const asset = await makeComponentAsset(style.id, 'ided.html', document);
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify([asset.id]) });

    const res = await GET(new NextRequest('http://localhost/x?editable=1'), { params: Promise.resolve({ id: page.id }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-gf-id="1"');
    expect(body).toContain(`data-gf-component-asset-id="${asset.id}"`);

    const { hashDocument } = await import('@/lib/services/componentElementTree');
    const expectedHash = hashDocument(document);
    expect(body).toContain(`data-gf-rev="${expectedHash}"`);
  });

  it('without ?editable=1, still strips data-gf-id and never emits data-gf-component-asset-id (regression guard)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head>'
      + '<body><button data-gf-id="1" class="btn gf-1">Go</button></body></html>';
    const asset = await makeComponentAsset(style.id, 'ided.html', document);
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify([asset.id]) });

    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: page.id }) });
    const body = await res.text();
    expect(body).not.toContain('data-gf-id');
    expect(body).not.toContain('data-gf-component-asset-id');
  });

  it('editable mode still sanitizes untrusted component content', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const hostileAsset = await makeComponentAsset(style.id, 'hostile.html',
      '<!DOCTYPE html><html><head><style>.a {}</style></head><body><button onclick="alert(1)">Go</button><script>alert(document.cookie)</script></body></html>');
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify([hostileAsset.id]) });

    const res = await GET(new NextRequest('http://localhost/x?editable=1'), { params: Promise.resolve({ id: page.id }) });
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('onclick');
  });

  it('?editable=1&download=1 together still produce a clean export (download wins)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const document = '<!DOCTYPE html><html><head><style>.btn { color: red; }</style></head>'
      + '<body><button data-gf-id="1" class="btn gf-1">Go</button></body></html>';
    const asset = await makeComponentAsset(style.id, 'ided.html', document);
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify([asset.id]) });

    const res = await GET(new NextRequest('http://localhost/x?editable=1&download=1'), { params: Promise.resolve({ id: page.id }) });
    const body = await res.text();
    expect(body).not.toContain('data-gf-id');
    expect(body).not.toContain('data-gf-component-asset-id');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
  });

  it('editable mode still respects the edited_externally trust bypass', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const asset = await makeComponentAsset(style.id, 'trusted.html', IMG_DOC);
    await assetService.update(asset.id, 'user-1', { editedExternally: true });
    const page = await pageService.create({ styleId: style.id, name: 'x', createdBy: 'user-1' });
    await pageService.update(page.id, 'user-1', { componentAssetIds: JSON.stringify([asset.id]) });

    const res = await GET(new NextRequest('http://localhost/x?editable=1'), { params: Promise.resolve({ id: page.id }) });
    const body = await res.text();
    expect(body).toContain('<img');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pageRenderRoute.test.ts`
Expected: FAIL — the new `?editable=1` tests fail (no `data-gf-component-asset-id` in the output yet); the regression test passes already (it's asserting current behavior).

- [ ] **Step 3: Implement `?editable=1`**

In `app/api/pages/[id]/render/route.ts`, change the imports at the top from:

```ts
import { composePageHtml, type PageComponentTokens } from '@/lib/services/pageDocument';
```

to:

```ts
import { composePageHtml, composeEditablePageHtml, type EditablePageComponentTokens } from '@/lib/services/pageDocument';
import { hashDocument } from '@/lib/services/componentElementTree';
```

Then replace the body of the `GET` handler's `try` block from `const componentAssetIds = ...` through `const html = composePageHtml(items, themeCss ?? undefined);` with:

```ts
    // download always wins if both are somehow present: it's this route's other existing purpose,
    // "a clean, final export document" (see this file's own header comment) -- workbench callers
    // (Task 6) never pass download=1, and the existing Download HTML link (Style Hub) never passes
    // editable=1, so this only matters for a hand-crafted URL, but a downloaded file should never
    // carry data-gf-id/data-gf-component-asset-id regardless.
    const editable = req.nextUrl.searchParams.get('editable') === '1' && req.nextUrl.searchParams.get('download') !== '1';

    const componentAssetIds = JSON.parse(page.component_asset_ids) as string[];
    const items: EditablePageComponentTokens[] = [];
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
        const tokens = parseComponentHtml(document);
        // An asset marked `edited_externally` already had its trust decision
        // made at WRITE time (PATCH .../component with trustAsEdited) — skip
        // only the sanitize calls for that case, same as the component-serve
        // and export routes. composePageHtml/composeEditablePageHtml still
        // scope and reassemble this content unconditionally either way.
        const trusted = asset.edited_externally === 1;
        const html = trusted ? tokens.html : sanitizeComponentHtml(tokens.html);
        items.push({
          // Editable mode (the workbench's live click-to-edit preview) needs data-gf-id intact to
          // resolve a click to an element; the export/download path (editable=false) strips it, as
          // before.
          html: editable ? html : stripElementIds(html),
          css: trusted ? tokens.css : sanitizeComponentCss(tokens.css),
          assetId,
          // Hashes the exact raw file bytes applyElementPatch's readVerifiedTokens() compares
          // against (lib/services/componentPatchService.ts) — this is what lets a click in the
          // composed page's iframe carry a documentHash the existing patch-element endpoint
          // accepts as still-current.
          revisionHash: hashDocument(document),
        });
      } catch (e) {
        console.error(`Failed to load component asset ${assetId} for page ${id}, skipping:`, e);
      }
    }

    const themeCss = await assetService.loadThemeCssForStyle(page.style_id);
    const html = editable
      ? composeEditablePageHtml(items, themeCss ?? undefined)
      : composePageHtml(items, themeCss ?? undefined);
```

Leave everything else in the route (the 404 check, the response headers, the `?download=1` handling, the outer `catch`) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pageRenderRoute.test.ts`
Expected: PASS (all tests, old and new — including every pre-existing test, confirming non-editable behavior is unaffected).

- [ ] **Step 5: Commit**

```bash
git add "app/api/pages/[id]/render/route.ts" test/pageRenderRoute.test.ts
git commit -m "feat: add ?editable=1 render mode for the workbench's live click-to-edit preview

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `kind: 'page'` and function-form `patchEndpoint` in `PreviewFrame`

**Files:**
- Modify: `app/components/PreviewFrame.tsx`
- Test: `test/previewFrame.test.tsx`

**Interfaces:**
- Consumes: `FrameElementInfo` (Task 2's extended shape).
- Produces:
  - `PreviewFrameProps.kind?: 'component' | 'page'` — `'page'` gets the exact same sandbox relaxation, anchor-nav guard, hover-highlight, select-mode toggle, and `ElementPatchPanel` rendering as `'component'` already has.
  - `PreviewFrameProps.patchEndpoint?: string | ((info: FrameElementInfo) => string)` — a function is called with the clicked element's info to resolve the endpoint per click; a string behaves exactly as before.
  - For `kind: 'page'` selections, `documentHash` comes from `info.componentRevisionHash`, not the page-wide `getRevisionHash(frame)` (which reads a single `meta[name="gf-rev"]` that page-mode documents don't emit).

- [ ] **Step 1: Write the failing tests**

In `test/previewFrame.test.tsx`, update the `elementInfoOf` helper to satisfy the extended `FrameElementInfo` shape:

```ts
function elementInfoOf(overrides: Partial<FrameElementInfo> = {}): FrameElementInfo {
  return {
    tagName: 'button',
    classes: ['btn'],
    id: null,
    dataGfId: '1',
    componentAssetId: null,
    componentRevisionHash: null,
    rect: new DOMRect(0, 0, 10, 10),
    ...overrides,
  };
}
```

Then add these tests inside `describe('PreviewFrame', ...)`, after the existing `'renders sandbox="allow-same-origin" for component previews'` test:

```ts
  it('renders sandbox="allow-same-origin" for page previews', () => {
    render(<PreviewFrame title="t" width={100} height={100} src="/api/pages/1/render?editable=1" kind="page" />);
    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
  });

  it('shows the select-mode toggle when fullscreen and kind is page', () => {
    const { container } = render(
      <PreviewFrame title="t" width={100} height={100} src="/api/pages/1/render?editable=1" kind="page" />,
    );
    enterFullscreen(container);
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy();
  });

  it('resolves patchEndpoint via a function using the clicked element info, for kind="page"', () => {
    vi.mocked(getElementAt).mockReturnValue(elementInfoOf({ componentAssetId: 'asset-1', componentRevisionHash: 'hash-1' }));
    const patchEndpointFn = vi.fn((info: FrameElementInfo) => `/api/assets/${info.componentAssetId}/component/patch-element`);

    const { container } = render(
      <PreviewFrame title="t" width={100} height={100} src="/api/pages/1/render?editable=1" kind="page" patchEndpoint={patchEndpointFn} />,
    );
    enterFullscreen(container);
    clickSelectToggle();

    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    fireEvent(iframe.contentWindow!, new MouseEvent('click', { clientX: 1, clientY: 1 }));

    expect(patchEndpointFn).toHaveBeenCalledWith(expect.objectContaining({ componentAssetId: 'asset-1' }));
    expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy();
  });

  it('uses componentRevisionHash, not getRevisionHash, as the documentHash for kind="page" selections', () => {
    vi.mocked(getElementAt).mockReturnValue(elementInfoOf({ componentAssetId: 'asset-1', componentRevisionHash: 'hash-1' }));

    const { container } = render(
      <PreviewFrame title="t" width={100} height={100} src="/api/pages/1/render?editable=1" kind="page" patchEndpoint={() => '/x'} />,
    );
    enterFullscreen(container);
    clickSelectToggle();

    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    fireEvent(iframe.contentWindow!, new MouseEvent('click', { clientX: 1, clientY: 1 }));

    expect(getRevisionHash).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/previewFrame.test.tsx`
Expected: FAIL — `kind="page"` is not assignable (TS) / behaves like a non-editable preview at runtime (no sandbox relaxation, no Select button, no panel).

- [ ] **Step 3: Implement `kind: 'page'` and function-form `patchEndpoint`**

In `app/components/PreviewFrame.tsx`, make these changes:

1. Update the props interface:

```ts
  /** Component and page previews: enables the sandbox relaxation and select-mode toggle. */
  kind?: 'component' | 'page';
  /**
   * Enables the Apply UI once an element is selected. Omit for highlight-only select mode. A
   * function is called with the clicked element's info to resolve the endpoint per click — used by
   * kind="page", where each click can target a different composed component's own asset id.
   */
  patchEndpoint?: string | ((info: FrameElementInfo) => string);
```

2. Update `resolveSandbox`:

```ts
function resolveSandbox(kind: PreviewFrameProps['kind']): '' | 'allow-same-origin' {
  return kind === 'component' || kind === 'page' ? 'allow-same-origin' : '';
}
```

3. Right after the `const [reloadKey, setReloadKey] = useState(0);` line, add:

```ts
  // Component and page previews share every piece of the select/highlight/patch machinery below —
  // they differ only in how a click's documentHash is resolved (see handleClick in attachAll) and
  // in what patchEndpoint (Task 6/7 of the workbench plan) resolves to per click.
  const isEditablePreview = kind === 'component' || kind === 'page';
```

4. In `attachAll`, change:

```ts
    const cleanupAnchor = kind === 'component' ? preventFrameAnchorNavigation(frame) : undefined;
```
to:
```ts
    const cleanupAnchor = isEditablePreview ? preventFrameAnchorNavigation(frame) : undefined;
```

and change `handleClick`'s body from:

```ts
    function handleClick(e: MouseEvent) {
      const info = getElementAt(frame!, e.clientX, e.clientY);
      if (selectMode) {
        const documentHash = getRevisionHash(frame!);
        setSelection(info ? { ...info, documentHash } : null);
      }
```

to:

```ts
    function handleClick(e: MouseEvent) {
      const info = getElementAt(frame!, e.clientX, e.clientY);
      if (selectMode) {
        // Page mode composes multiple components into one document -- there is no single
        // page-wide gf-rev meta tag that could mean anything (each component has its own revision).
        // componentRevisionHash (Task 2) is the per-wrapper hash the patch-element endpoint expects
        // instead.
        const documentHash = kind === 'page' ? (info?.componentRevisionHash ?? null) : getRevisionHash(frame!);
        setSelection(info ? { ...info, documentHash } : null);
      }
```

and update the `useCallback` deps array (it already includes `kind`, so no change needed there — but double check it reads `[kind, selectMode]`).

5. Update the effect gate:

```ts
    if (!frame || kind !== 'component' || !(selectMode || onElementClick)) return;
```
to:
```ts
    if (!frame || !isEditablePreview || !(selectMode || onElementClick)) return;
```

6. Update `effectiveSrc`:

```ts
  const effectiveSrc = kind === 'component' && src ? `${src}&patchV=${reloadKey}` : src;
```
to:
```ts
  const effectiveSrc = isEditablePreview && src ? `${src}&patchV=${reloadKey}` : src;
```

7. Update the Select button's render condition:

```ts
          {kind === 'component' ? (
```
to:
```ts
          {isEditablePreview ? (
```

8. Update the `ElementPatchPanel` render block from:

```ts
      {kind === 'component' && patchEndpoint && selection ? (
        <ElementPatchPanel patchEndpoint={patchEndpoint} selection={selection} onPatched={handlePatched} />
      ) : null}
```
to:
```ts
      {isEditablePreview && patchEndpoint && selection ? (
        <ElementPatchPanel
          patchEndpoint={typeof patchEndpoint === 'function' ? patchEndpoint(selection) : patchEndpoint}
          selection={selection}
          onPatched={handlePatched}
        />
      ) : null}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/previewFrame.test.tsx`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add app/components/PreviewFrame.tsx test/previewFrame.test.tsx
git commit -m "feat: support kind=page and function-form patchEndpoint in PreviewFrame

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: "Website" nav group and `/dashboard/website` route

**Files:**
- Modify: `lib/dashboardRoutes.ts`
- Modify: `app/components/NavRail.tsx`
- Modify: `app/globals.css`
- Test: `test/dashboardRoutesGrouping.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DASHBOARD_ROUTES` gains one entry, `{ href: '/dashboard/website', label: 'Website' }`. Two new exports, `NAV_ASSET_ROUTES` and `NAV_WEBSITE_ROUTES`, partition what `NAV_PRIMARY_ROUTES` used to hold — `NAV_PRIMARY_ROUTES` stays exported as their concatenation, so the copilot's route enum (`lib/services/copilotTool.ts`, which reads `DASHBOARD_ROUTES` directly) and any other existing consumer keep working unchanged.

- [ ] **Step 1: Write the failing tests**

Replace `test/dashboardRoutesGrouping.test.ts`'s `'exactly 12 routes are visible...'` test and add new grouping tests:

```ts
import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROUTES, NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES, NAV_ASSET_ROUTES, NAV_WEBSITE_ROUTES } from '@/lib/dashboardRoutes';

describe('NavRail route grouping', () => {
  it('finds the Overview and Settings hub routes', () => {
    expect(NAV_OVERVIEW_ROUTE.label).toBe('Overview');
    expect(NAV_SETTINGS_HUB_ROUTE.label).toBe('Settings');
  });

  it('every DASHBOARD_ROUTES entry is either visible in one group or a known-hidden settings sub-route', () => {
    const visible = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    const hiddenSettingsSubRoutes = DASHBOARD_ROUTES.filter(r => r.href.startsWith('/dashboard/settings/'));
    const accountedFor = [...visible, ...hiddenSettingsSubRoutes];
    expect(accountedFor.map(r => r.href).sort()).toEqual(DASHBOARD_ROUTES.map(r => r.href).sort());
  });

  it('exactly 13 routes are visible and exactly the 6 settings sub-routes are hidden', () => {
    const visible = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    expect(visible).toHaveLength(13);
    const hidden = DASHBOARD_ROUTES.filter(r => !visible.includes(r));
    expect(hidden).toHaveLength(6);
    expect(hidden.every(r => r.href.startsWith('/dashboard/settings/'))).toBe(true);
  });

  it('NAV_PRIMARY_ROUTES excludes every settings route, including the hub itself', () => {
    expect(NAV_PRIMARY_ROUTES.some(r => r.href.startsWith('/dashboard/settings'))).toBe(false);
    expect(NAV_PRIMARY_ROUTES.some(r => r.href === '/dashboard')).toBe(false);
  });

  it('NAV_PRIMARY_ROUTES is exactly NAV_ASSET_ROUTES followed by NAV_WEBSITE_ROUTES', () => {
    expect(NAV_PRIMARY_ROUTES).toEqual([...NAV_ASSET_ROUTES, ...NAV_WEBSITE_ROUTES]);
  });

  it('NAV_WEBSITE_ROUTES includes the new workbench route', () => {
    expect(NAV_WEBSITE_ROUTES.some(r => r.href === '/dashboard/website')).toBe(true);
  });

  it('no route appears in both NAV_ASSET_ROUTES and NAV_WEBSITE_ROUTES', () => {
    const assetHrefs = new Set(NAV_ASSET_ROUTES.map(r => r.href));
    expect(NAV_WEBSITE_ROUTES.every(r => !assetHrefs.has(r.href))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboardRoutesGrouping.test.ts`
Expected: FAIL — `NAV_ASSET_ROUTES`/`NAV_WEBSITE_ROUTES` don't exist yet; the "13 routes visible" count fails against the current 12.

- [ ] **Step 3: Implement the route grouping**

Replace `lib/dashboardRoutes.ts` in full with:

```ts
export interface DashboardRoute {
  href: string;
  label: string;
}

// Single source of truth for both NavRail's link list and the copilot's
// navigate_to_page tool enum -- see lib/services/copilotTool.ts. Keep this
// to GameForge's static routes only; a dynamic route (a specific job's
// edit page, a specific asset) has no id the model could validly supply.
export const DASHBOARD_ROUTES: DashboardRoute[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/themes', label: 'Themes' },
  { href: '/dashboard/components', label: 'Components' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/presets', label: 'Presets' },
  { href: '/dashboard/website', label: 'Website' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/drive', label: 'Drive' },
  { href: '/dashboard/settings', label: 'Settings' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
  { href: '/dashboard/settings/google-drive', label: 'Google Drive' },
  { href: '/dashboard/settings/ollama', label: 'Ollama' },
  { href: '/dashboard/settings/design-preview', label: 'Design Preview' },
];

// NavRail's own grouping -- Overview and the Settings hub render as their
// own single links; every other visible route renders under one of two
// labeled groups (Assets: generation/management of individual UI assets;
// Website: assembling and shipping a full site from those assets), and the
// 6 individual settings sub-routes stay hidden from the visible rail (still
// valid DASHBOARD_ROUTES entries, so the AI copilot can still navigate
// straight to one directly). Exported from here rather than computed inline
// in NavRail.tsx so this exact grouping can be tested without rendering any
// React.
export const NAV_OVERVIEW_ROUTE = DASHBOARD_ROUTES.find(r => r.href === '/dashboard')!;
export const NAV_SETTINGS_HUB_ROUTE = DASHBOARD_ROUTES.find(r => r.href === '/dashboard/settings')!;

const ASSET_ROUTE_HREFS = [
  '/dashboard/generate',
  '/dashboard/ui-sheets',
  '/dashboard/themes',
  '/dashboard/components',
  '/dashboard/jobs',
  '/dashboard/assets',
  '/dashboard/styles',
  '/dashboard/presets',
];
const WEBSITE_ROUTE_HREFS = ['/dashboard/website', '/dashboard/export', '/dashboard/drive'];

export const NAV_ASSET_ROUTES = DASHBOARD_ROUTES.filter(r => ASSET_ROUTE_HREFS.includes(r.href));
export const NAV_WEBSITE_ROUTES = DASHBOARD_ROUTES.filter(r => WEBSITE_ROUTE_HREFS.includes(r.href));
export const NAV_PRIMARY_ROUTES = [...NAV_ASSET_ROUTES, ...NAV_WEBSITE_ROUTES];
```

- [ ] **Step 4: Run the route-grouping tests to verify they pass**

Run: `npx vitest run test/dashboardRoutesGrouping.test.ts`
Expected: PASS.

- [ ] **Step 5: Update NavRail.tsx's rendering**

In `app/components/NavRail.tsx`, update the import line from:

```ts
import { NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES, type DashboardRoute } from '@/lib/dashboardRoutes';
```
to:
```ts
import { NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_ASSET_ROUTES, NAV_WEBSITE_ROUTES, type DashboardRoute } from '@/lib/dashboardRoutes';
```

Then change the main render block from:

```tsx
      {renderLink(NAV_OVERVIEW_ROUTE)}
      {NAV_PRIMARY_ROUTES.map(renderLink)}
      <div className="rail-divider" />
```
to:
```tsx
      {renderLink(NAV_OVERVIEW_ROUTE)}
      <div className="rail-group-label">Assets</div>
      {NAV_ASSET_ROUTES.map(renderLink)}
      <div className="rail-group-label">Website</div>
      {NAV_WEBSITE_ROUTES.map(renderLink)}
      <div className="rail-divider" />
```

- [ ] **Step 6: Add the group-label style**

In `app/globals.css`, immediately after the existing `.rail-divider { ... }` rule, add:

```css
.rail-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ink-faint);
  margin: 16px 12px 4px;
}

.rail-group-label:first-of-type {
  margin-top: 8px;
}
```

- [ ] **Step 7: Run the full suite to confirm nothing else regressed**

Run: `npx vitest run test/dashboardRoutesGrouping.test.ts test/navRailLoginPage.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/dashboardRoutes.ts app/components/NavRail.tsx app/globals.css test/dashboardRoutesGrouping.test.ts
git commit -m "feat: add Website nav group and /dashboard/website route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Workbench page — Style Bible picker, page list, PageEditor, live click-to-edit preview

**Files:**
- Create: `app/dashboard/website/page.tsx`

**Interfaces:**
- Consumes: `useStyles()` (`lib/hooks/useStyles.ts`), `StyleBiblePicker` (`app/components/StyleBiblePicker.tsx`), `PageEditor` (`app/components/PageEditor.tsx`), `PreviewFrame` (Task 4's `kind: 'page'`), `GET/POST /api/styles/[id]/pages`, `GET /api/styles/[id]/assets`, `PUT/DELETE /api/pages/[id]`, `GET /api/pages/[id]/render?editable=1` (Task 3), `POST /api/assets/[id]/component/patch-element` (existing, unchanged).
- Produces: the `/dashboard/website` route. No new exports consumed elsewhere.

No automated test file for this task: this codebase has no dedicated test file for any top-level dashboard page component (`app/dashboard/styles/[id]/page.tsx`, `app/dashboard/components/page.tsx`, `app/dashboard/jobs/page.tsx` all have none) — every piece this page composes (`StyleBiblePicker`, `PageEditor`, `PreviewFrame`, the API routes) already has its own tests, and top-level page wiring is verified live in a real browser (Task 8) per this project's standing practice.

- [ ] **Step 1: Create the workbench page**

Create `app/dashboard/website/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Page, AssetWithContrast } from '@/lib/database/schema';
import { useStyles } from '@/lib/hooks/useStyles';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';
import { PageEditor } from '@/app/components/PageEditor';
import { PreviewFrame } from '@/app/components/PreviewFrame';

export default function WebsiteWorkbenchPage() {
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
  const [styleId, setStyleId] = useState('');
  const activeStyleId = styleId || styles[0]?.id || '';

  const [pages, setPages] = useState<Page[]>([]);
  const [components, setComponents] = useState<AssetWithContrast[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);

  useEffect(() => {
    if (!activeStyleId) return;
    let ignore = false;
    setSelectedPageId(null);
    setCreatingNew(false);
    (async () => {
      const [pagesRes, assetsRes] = await Promise.all([
        fetch(`/api/styles/${activeStyleId}/pages`),
        fetch(`/api/styles/${activeStyleId}/assets`),
      ]);
      const pagesBody = await pagesRes.json();
      const assetsBody = await assetsRes.json();
      if (ignore) return;
      if (pagesBody.success) setPages(pagesBody.data);
      if (assetsBody.success) setComponents((assetsBody.data as AssetWithContrast[]).filter(a => a.output_kind === 'component'));
    })();
    return () => { ignore = true; };
  }, [activeStyleId]);

  async function refreshPages() {
    const res = await fetch(`/api/styles/${activeStyleId}/pages`);
    const body = await res.json();
    if (body.success) setPages(body.data);
  }

  async function refreshComponents() {
    const res = await fetch(`/api/styles/${activeStyleId}/assets`);
    const body = await res.json();
    if (body.success) setComponents((body.data as AssetWithContrast[]).filter(a => a.output_kind === 'component'));
  }

  function handleNewPage() {
    setSelectedPageId(null);
    setCreatingNew(true);
    setPageError(null);
  }

  function handleSelectPage(id: string) {
    setSelectedPageId(id);
    setCreatingNew(false);
    setPageError(null);
  }

  async function handleCreatePage(value: { name: string; componentAssetIds: string[] }) {
    setPageError(null);
    try {
      const res = await fetch(`/api/styles/${activeStyleId}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.name }),
      });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not create page.');
        return;
      }
      const newPageId = body.data.id;
      if (value.componentAssetIds.length > 0) {
        const orderRes = await fetch(`/api/pages/${newPageId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ componentAssetIds: value.componentAssetIds }),
        });
        const orderBody = await orderRes.json();
        if (!orderBody.success) {
          setPageError(orderBody.error ?? 'Page was created, but could not save component order.');
        }
      }
      setCreatingNew(false);
      setSelectedPageId(newPageId);
      setPreviewVersion(v => v + 1);
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
      setPreviewVersion(v => v + 1);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    }
  }

  async function handleDeletePage(pageId: string) {
    if (deletingPageId) return;
    if (!window.confirm("Delete this page? This can't be undone from the UI.")) return;
    setPageError(null);
    setDeletingPageId(pageId);
    try {
      const res = await fetch(`/api/pages/${pageId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setPageError(body.error ?? 'Could not delete page.');
        return;
      }
      if (selectedPageId === pageId) setSelectedPageId(null);
      await refreshPages();
    } catch {
      setPageError('Could not reach the server.');
    } finally {
      setDeletingPageId(null);
    }
  }

  const selectedPage = pages.find(p => p.id === selectedPageId) ?? null;

  return (
    <>
      <h1 className="page-title">Website</h1>
      <p className="page-subtitle">
        Pick a Style Bible, build a page from its components, and click any element in the live
        preview to change it.
      </p>

      {!stylesLoading && !stylesError && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 24 }}>
          No Style Bibles yet. <Link href="/dashboard/styles">Create one</Link> before building a page.
        </div>
      ) : (
        <div style={{ maxWidth: 320, marginBottom: 24 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />
        </div>
      )}
      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}

      {activeStyleId && (
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 420px', minWidth: 320 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>Pages</div>
              <button className="btn" onClick={handleNewPage}>New Page</button>
            </div>
            {pageError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 8 }}>{pageError}</p>}
            {pages.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 16 }}>No pages yet for this Style Bible.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {pages.map(p => (
                  <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      className={selectedPageId === p.id && !creatingNew ? 'btn btn-primary' : 'btn'}
                      style={{ flex: 1, textAlign: 'left' }}
                      onClick={() => handleSelectPage(p.id)}
                    >
                      {p.name}
                    </button>
                    <button type="button" className="btn" onClick={() => handleDeletePage(p.id)} disabled={deletingPageId === p.id}>
                      {deletingPageId === p.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {(creatingNew || selectedPage) && (
              // Keyed on the page identity (or 'new') so PageEditor fully remounts -- and resets its
              // own internal name/componentAssetIds state -- whenever the user switches which page
              // they're editing. Same "remount to reset state on identity change" pattern as
              // ElementPatchPanel's own key (app/components/ElementPatchPanel.tsx).
              <PageEditor
                key={selectedPageId ?? 'new'}
                styleId={activeStyleId}
                availableComponents={components}
                initialName={selectedPage?.name}
                initialComponentAssetIds={selectedPage ? JSON.parse(selectedPage.component_asset_ids) : undefined}
                onSubmit={creatingNew ? handleCreatePage : (value) => handleUpdatePage(selectedPage!.id, value)}
                submitLabel={creatingNew ? 'Create Page' : 'Save Changes'}
              />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 320 }}>
            {creatingNew || !selectedPage ? (
              <div className="empty-state">Save the page to see a live preview.</div>
            ) : (
              // Keyed on the page id so switching pages fully remounts the iframe/select-mode state
              // instead of carrying over a selection from a different page's DOM.
              <PreviewFrame
                key={selectedPage.id}
                title={`Live preview: ${selectedPage.name}`}
                src={`/api/pages/${selectedPage.id}/render?editable=1&v=${previewVersion}`}
                width="100%"
                height={640}
                border
                kind="page"
                patchEndpoint={(info) => (info.componentAssetId ? `/api/assets/${info.componentAssetId}/component/patch-element` : '')}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint app lib worker.ts`
Expected: no new errors.

- [ ] **Step 3: Manual smoke check**

Start the dev server (`npm run dev`), sign in, navigate to `/dashboard/website`. Confirm: the Style Bible picker lists existing Style Bibles; clicking "New Page", typing a name, and clicking "Create Page" makes the page appear in the list, selected, with an (empty) live preview on the right; adding an existing component via the "Available components" list and clicking "Save Changes" makes it appear in the preview.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/website/page.tsx
git commit -m "feat: add Website Builder Workbench page (Style Bible picker, page list, live editor)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Inline "Generate new component" in the workbench

**Files:**
- Modify: `app/dashboard/website/page.tsx`

**Interfaces:**
- Consumes: `useJobStore` (`lib/store/useJobStore.ts`), `usePolling` (`lib/hooks/usePolling.ts`), `JobCard` (`app/components/JobCard.tsx`), `POST /api/generate` (existing, same payload shape as `app/dashboard/components/page.tsx`), `POST /api/assets/from-job` (existing).
- Produces: nothing new consumed elsewhere — purely additive UI on the same page.

- [ ] **Step 1: Add the inline generate section**

In `app/dashboard/website/page.tsx`, add these imports:

```ts
import { useJobStore } from '@/lib/store/useJobStore';
import { usePolling } from '@/lib/hooks/usePolling';
import { JobCard } from '@/app/components/JobCard';

const COMPONENT_TYPES = ['Button', 'Card', 'Nav Bar', 'Form', 'Other'] as const;
```

Inside `WebsiteWorkbenchPage`, after the `previewVersion` state declaration, add:

```ts
  // Scoped to this Style Bible specifically (unlike the Components page's own global "Live queue",
  // which shows every style's in-flight component jobs) -- the workbench is a Style-Bible-scoped
  // building surface, so an unrelated style's jobs would just be noise here.
  const jobs = useJobStore(s => s.jobs).filter(j => j.output_kind === 'component' && j.style_id === activeStyleId);
  const refreshActiveJobs = useJobStore(s => s.refreshActive);
  usePolling(refreshActiveJobs, 2000);

  const [componentType, setComponentType] = useState<typeof COMPONENT_TYPES[number]>('Button');
  const [componentPrompt, setComponentPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [promotingJobId, setPromotingJobId] = useState<string | null>(null);
```

After `handleDeletePage`, add:

```ts
  // ponytail: always generates via Claude (no provider picker), unlike the full Components page
  // (app/dashboard/components/page.tsx), which also offers OpenRouter/Ollama -- a deliberate
  // corner cut to keep this inline form compact. If a user wants Ollama/OpenRouter for this
  // generation, add the same provider <select> + openrouterModel input ComponentsPage already has
  // and thread it into the body below the same way.
  async function handleGenerateComponent(e: React.FormEvent) {
    e.preventDefault();
    if (!activeStyleId || !componentPrompt.trim() || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          styleId: activeStyleId,
          assetType: 'component',
          prompt: `${componentType}: ${componentPrompt.trim()}`,
          outputKind: 'component',
          options: { componentType },
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setGenerateError(body.error ?? 'Generation failed to queue.');
      } else {
        setComponentPrompt('');
        refreshActiveJobs();
      }
    } catch {
      setGenerateError('Could not reach the server.');
    } finally {
      setGenerating(false);
    }
  }

  async function handlePromoteJob(jobId: string) {
    setPromotingJobId(jobId);
    try {
      const res = await fetch('/api/assets/from-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const body = await res.json();
      if (body.success) await refreshComponents();
      await refreshActiveJobs();
    } finally {
      setPromotingJobId(null);
    }
  }
```

In the left panel `<div>` (the `flex: '0 0 420px'` column), after the `(creatingNew || selectedPage) && (<PageEditor .../>)` block, add:

```tsx
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Generate new component</div>
              <form onSubmit={handleGenerateComponent} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <select value={componentType} onChange={e => setComponentType(e.target.value as typeof COMPONENT_TYPES[number])}>
                  {COMPONENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <textarea
                  value={componentPrompt}
                  onChange={e => setComponentPrompt(e.target.value)}
                  placeholder="a primary call-to-action button, rounded corners"
                />
                <button className="btn btn-primary" type="submit" disabled={generating || !componentPrompt.trim()}>
                  {generating ? 'Queuing…' : 'Queue generation'}
                </button>
                {generateError && <p style={{ color: 'var(--reject)', fontSize: 13 }}>{generateError}</p>}
              </form>
              {jobs.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {jobs.map(job => (
                    <JobCard key={job.id} job={job} onPromote={handlePromoteJob} busy={promotingJobId === job.id} />
                  ))}
                </div>
              )}
            </div>
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint app lib worker.ts`
Expected: no new errors.

- [ ] **Step 3: Manual smoke check**

On `/dashboard/website` with a Style Bible selected, queue a component generation from the new inline form; confirm a `JobCard` appears and updates as the (mock, if no `PIXELLAB_API_KEY`-equivalent applies — component generation uses Claude/Ollama/OpenRouter, not Pixellab) job completes; click "Promote to Asset"; confirm the new component appears in the open `PageEditor`'s "Available components" list without a page reload.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/website/page.tsx
git commit -m "feat: add inline component generation to the Website Builder Workbench

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated suite**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all pass, zero new failures/warnings.

- [ ] **Step 2: Live end-to-end walkthrough**

With the dev server running and a real (or mock, if `PIXELLAB_API_KEY`/model credentials aren't configured) generation backend:

1. Navigate to `/dashboard/website`. Confirm the sidebar now shows an "Assets" group and a separate "Website" group (containing Website, Export, Drive), per Task 5.
2. Pick or create a Style Bible with at least 2 promoted components (use the inline "Generate new component" form from Task 7 if none exist yet — queue 2, wait for completion, promote both).
3. Click "New Page", name it, add both components, click "Create Page". Confirm the live preview on the right shows both components composed, in order.
4. Click the preview's fullscreen button, then "Select". Hover over an element inside the first component — confirm a highlight outline appears. Click it, type an instruction (e.g. "make this button red"), click "Apply". Confirm the preview reloads showing the change, and that clicking a different element (in the second component) after that still resolves to the correct component (not the first one).
5. Exit fullscreen, remove one component via the `PageEditor`'s "Remove" button, click "Save Changes". Confirm the live preview updates to reflect the removal without a manual page refresh.
6. Navigate to `/dashboard/styles/<the same style id>` and open the same page's existing preview/download link (`/api/pages/<id>/render?download=1`). Confirm it downloads a page with `data-gf-id` and `data-gf-component-asset-id` both absent (export/non-editable mode unaffected by this feature).
7. Confirm no browser console error mentions `allow-scripts` or a CSP violation while using the workbench.

- [ ] **Step 3: Record the outcome**

If every check in Step 2 passes, the feature is complete. If any check fails, return to the relevant task above, fix, re-run that task's own tests, and repeat this task from Step 1.
