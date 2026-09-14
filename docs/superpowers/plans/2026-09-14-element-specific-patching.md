# Element-Specific Patching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user click a single element inside a component's live preview and ask the AI to change just that element, instead of the whole component being regenerated from scratch.

**Architecture:** Relax the component-preview iframe's sandbox to `allow-same-origin` (never `allow-scripts`) behind a narrow, audited DOM-read module. Stable `data-gf-id` attributes, assigned only at component-write time, identify elements across the click → AI patch → splice-back round trip. Patches are HTML fragment + CSS declaration list, applied via a server-assigned `.gf-<n>` class (never a `[data-gf-id]` selector, which export strips) and spliced back into the stored document with optimistic-concurrency protection.

**Tech Stack:** Next.js App Router, `htmlparser2` (already a direct dependency, provides `parseDocument`/`DomUtils`), `dom-serializer` (new direct dependency, already present transitively), `sanitize-html`, `postcss`.

**Spec:** `docs/superpowers/specs/2026-09-14-element-specific-patching-design.md` — read this in full before starting; it has the complete reasoning, including three rounds of adversarial security review and why several simpler-looking approaches (attribute-selector CSS targeting, per-element outerHTML hashing, folding ID assignment into the general sanitizer) were tried and rejected. This plan implements exactly what that spec settled on.

## Global Constraints

- `allow-scripts` must NEVER be added to any `sandbox` attribute in this codebase, now or in any future change — this is the one invariant the entire security argument depends on. Every task touching `PreviewFrame.tsx` or the sandbox value must preserve this.
- The component-serving route's CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:;`) is a required security invariant of the sandbox relaxation, not incidental hardening — it must never be weakened without updating the spec's security reasoning first.
- All frame-DOM reads go through `lib/preview/inspectFrame.ts` and ONLY that module — its return shape (`{ tagName, classes, id, rect }`) must never grow to include a node reference, `outerHTML`, or `innerHTML`. No other file may call `iframe.contentDocument` directly.
- `data-gf-id` is a GameForge-internal handle: it is added to the sanitizer's attribute allowlist, but every export/share path (`SiteExporter`, share-to-drive, asset export, page-render) must strip it before the document leaves GameForge. CSS patches must never depend on it surviving export — that's why they target a `.gf-<n>` class instead.
- `edited_externally` ("trusted") assets never get `data-gf-id` attributes on any write path, and never get CSS/HTML sanitized — this is existing, unchanged behavior. Click-to-select must detect and disable itself for unselectable (id-less) content client-side, before an AI call is made, not after a failed patch.
- Every new/modified file must pass `npx eslint app lib worker.ts`, `npx tsc --noEmit`, and `npx vitest run` before a task is considered complete — this project's CI runs all three as separate required gates.

---

### Task 1: `dom-serializer` as a direct dependency, and the shared CSP constant

**Files:**
- Modify: `package.json`
- Modify: `lib/services/componentSanitize.ts`
- Test: `test/componentSanitize.test.ts`

**Interfaces:**
- Produces: `export const COMPONENT_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;"` from `lib/services/componentSanitize.ts` — later tasks import this instead of retyping the literal.

`dom-serializer` (version `3.1.1`) is already installed transitively (via `htmlparser2`'s own dependency tree) but isn't in `package.json` — Task 3 needs to `import` it directly, which should never rely on an undeclared transitive dependency staying hoisted.

- [ ] **Step 1: Add `dom-serializer` to package.json**

In `package.json`, in the `dependencies` block (alongside the existing `htmlparser2`, `postcss`, `sanitize-html` entries), add:

```json
    "dom-serializer": "^3.1.1",
```

- [ ] **Step 2: Install and verify**

Run: `npm install --ignore-scripts` (per this machine's known `better-sqlite3` build constraint)
Expected: `package-lock.json` updates, no errors, `node_modules/dom-serializer` still present.

- [ ] **Step 3: Write the failing test for the CSP constant**

Add to `test/componentSanitize.test.ts` (new `describe` block, alongside the existing `sanitizeComponentHtml`/`sanitizeComponentCss` ones):

```typescript
import { COMPONENT_PREVIEW_CSP } from '@/lib/services/componentSanitize';

describe('COMPONENT_PREVIEW_CSP', () => {
  it('is the exact pinned literal — not just internally self-consistent', () => {
    // Pinned literal, not "matches itself" — a regression that weakens this string
    // (e.g. adding a script-src, loosening img-src) must fail this test even though
    // every other reference to the constant would still trivially match it.
    expect(COMPONENT_PREVIEW_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:;");
  });

  it('has no script-src override (relies on default-src none)', () => {
    expect(COMPONENT_PREVIEW_CSP).not.toContain('script-src');
  });

  it('restricts img-src to data: only', () => {
    expect(COMPONENT_PREVIEW_CSP).toMatch(/img-src data:;?$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/componentSanitize.test.ts`
Expected: FAIL — `COMPONENT_PREVIEW_CSP` is not exported yet.

- [ ] **Step 3: Add the constant**

In `lib/services/componentSanitize.ts`, near the top (after the existing imports, before `ALLOWED_TAGS`):

```typescript
/**
 * Required security invariant of the component-preview sandbox relaxation
 * (sandbox="allow-same-origin") — see docs/superpowers/specs/2026-09-14-element-specific-patching-design.md.
 * `script-src` is deliberately absent and falls back to `default-src 'none'`, blocking script
 * execution even if a future change mistakenly adds `allow-scripts` to the sandbox attribute.
 * Never weaken this without updating that spec's security reasoning first.
 */
export const COMPONENT_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/componentSanitize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/services/componentSanitize.ts test/componentSanitize.test.ts
git commit -m "feat: add dom-serializer dependency and shared component-preview CSP constant"
```

---

### Task 2: `data-gf-id` in the sanitizer allowlist, and `assignElementIds()`

**Files:**
- Modify: `lib/services/componentSanitize.ts`
- Test: `test/componentSanitize.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function assignElementIds(html: string, opts?: { preserveRootId?: string; startAt?: number }): string` from `lib/services/componentSanitize.ts`. Two modes:
  - No `opts` (or `opts.preserveRootId` absent): full-write mode — strips every `data-gf-id` already present, walks the whole fragment in document order, assigns `data-gf-id="1"`, `"2"`, ... from scratch.
  - `opts.preserveRootId` set: patch mode — the outermost element keeps `data-gf-id="<preserveRootId>"` unchanged (even if it arrived with a different or no id); every OTHER element in the fragment gets its existing `data-gf-id` (if any) stripped and reassigned starting at `opts.startAt` (required when `preserveRootId` is set — throws if omitted).

`htmlparser2`'s `parseDocument`/`DomUtils` (already a direct dependency, confirmed working: `parseDocument(html)` builds a DOM tree; `DomUtils.findAll`, `DomUtils.getAttributeValue`, and direct `.attribs` mutation are all available) is used here rather than `sanitize-html`'s `transformTags`, since this needs to know an element's position across the WHOLE document to assign sequential ids — `transformTags` only sees one tag at a time with no counter state carried cleanly across sibling subtrees in a testable way. `dom-serializer`'s `render()` (Task 1) serializes the mutated tree back to a string.

- [ ] **Step 1: Add `data-gf-id` to the attribute allowlist**

In `lib/services/componentSanitize.ts`, change:

```typescript
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'id'],
```

to:

```typescript
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'id', 'data-gf-id'],
```

- [ ] **Step 2: Write the failing tests**

Add to `test/componentSanitize.test.ts`:

```typescript
import { assignElementIds } from '@/lib/services/componentSanitize';

describe('assignElementIds', () => {
  it('assigns sequential ids in document order, full-write mode', () => {
    const html = '<div><span>a</span><button>b</button></div>';
    const result = assignElementIds(html);
    expect(result).toContain('data-gf-id="1"');
    expect(result).toContain('data-gf-id="2"');
    expect(result).toContain('data-gf-id="3"');
    // div gets 1, span gets 2, button gets 3 — outer-to-inner, then next sibling
    const divMatch = result.match(/<div data-gf-id="(\d+)"/);
    const spanMatch = result.match(/<span data-gf-id="(\d+)"/);
    const buttonMatch = result.match(/<button data-gf-id="(\d+)"/);
    expect(divMatch![1]).toBe('1');
    expect(spanMatch![1]).toBe('2');
    expect(buttonMatch![1]).toBe('3');
  });

  it('strips and reassigns any incoming data-gf-id in full-write mode — never trusts it', () => {
    const html = '<div data-gf-id="999"><span data-gf-id="999">a</span></div>';
    const result = assignElementIds(html);
    expect(result).not.toContain('data-gf-id="999"');
    // Two elements, two DIFFERENT fresh ids — not both left at 999
    const ids = [...result.matchAll(/data-gf-id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['1', '2']);
  });

  it('preserveRootId mode: keeps the root id, reassigns every descendant from startAt', () => {
    const fragment = '<button data-gf-id="stale"><span>ok</span></button>';
    const result = assignElementIds(fragment, { preserveRootId: '7', startAt: 20 });
    expect(result).toContain('data-gf-id="7"');
    expect(result).toContain('data-gf-id="20"');
    expect(result).not.toContain('data-gf-id="stale"');
  });

  it('preserveRootId mode: strips an id a descendant already carries, never trusts it', () => {
    // Simulates the AI's returned fragment hallucinating/copying an id onto a child —
    // must be stripped and reassigned, not passed through, per the spec's round-3 fix (N5).
    const fragment = '<div data-gf-id="7"><span data-gf-id="3">already tagged</span></div>';
    const result = assignElementIds(fragment, { preserveRootId: '7', startAt: 50 });
    expect(result).toContain('data-gf-id="7"');
    expect(result).not.toContain('data-gf-id="3"');
    expect(result).toContain('data-gf-id="50"');
  });

  it('preserveRootId mode throws if startAt is omitted', () => {
    expect(() => assignElementIds('<div></div>', { preserveRootId: '1' })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/componentSanitize.test.ts`
Expected: FAIL with "assignElementIds is not a function" (or similar import error).

- [ ] **Step 4: Implement `assignElementIds`**

In `lib/services/componentSanitize.ts`, add near the bottom (after `sanitizeComponentCss`):

```typescript
import { parseDocument, DomUtils } from 'htmlparser2';
import render from 'dom-serializer';
import type { Element as DomElement } from 'domhandler';

function isElement(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'tag';
}

function walkElementsInDocumentOrder(root: DomElement): DomElement[] {
  const out: DomElement[] = [];
  function visit(node: DomElement) {
    out.push(node);
    for (const child of node.children) {
      if (isElement(child)) visit(child);
    }
  }
  visit(root);
  return out;
}

/**
 * Assigns permanent `data-gf-id` attributes to every element in an HTML fragment.
 *
 * Full-write mode (no `opts.preserveRootId`): strips any incoming `data-gf-id` from every
 * element and renumbers the whole fragment from 1, in document order. Used by the component
 * write paths (generate, manual edit, reset) — never trusts an id an AI response or hand-edit
 * happened to already carry.
 *
 * Patch mode (`opts.preserveRootId` set): the fragment's single root element keeps that exact
 * id; every other element in the fragment has any incoming `data-gf-id` stripped and gets a
 * fresh one starting at `opts.startAt` (required — the caller must pass
 * `max(existing data-gf-id in the full stored document) + 1`, so ids stay unique across the
 * whole document, not just within this fragment).
 */
export function assignElementIds(html: string, opts?: { preserveRootId?: string; startAt?: number }): string {
  if (opts?.preserveRootId !== undefined && opts.startAt === undefined) {
    throw new Error('assignElementIds: startAt is required when preserveRootId is set.');
  }

  const dom = parseDocument(html);
  const roots = dom.children.filter(isElement);

  if (opts?.preserveRootId !== undefined) {
    const [root, ...rest] = roots;
    if (!root || rest.length > 0) {
      throw new Error('assignElementIds: preserveRootId mode requires exactly one root element.');
    }
    root.attribs['data-gf-id'] = opts.preserveRootId;
    let counter = opts.startAt!;
    for (const el of walkElementsInDocumentOrder(root)) {
      if (el === root) continue;
      delete el.attribs['data-gf-id'];
      el.attribs['data-gf-id'] = String(counter);
      counter += 1;
    }
  } else {
    let counter = 1;
    for (const root of roots) {
      for (const el of walkElementsInDocumentOrder(root)) {
        delete el.attribs['data-gf-id'];
        el.attribs['data-gf-id'] = String(counter);
        counter += 1;
      }
    }
  }

  return render(dom);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/componentSanitize.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full sanitizer test suite to confirm no regression**

Run: `npx vitest run test/componentSanitize.test.ts`
Expected: PASS (all existing `sanitizeComponentHtml`/`sanitizeComponentCss` tests still green — `data-gf-id` being newly allowlisted doesn't change any existing test's expected output, since none of them use that attribute).

- [ ] **Step 7: Commit**

```bash
git add lib/services/componentSanitize.ts test/componentSanitize.test.ts
git commit -m "feat: add assignElementIds for stable element identification in component patching"
```

---

### Task 3: `componentElementTree.ts` — locate, hash, and splice helpers

**Files:**
- Create: `lib/services/componentElementTree.ts`
- Test: `test/componentElementTree.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `htmlparser2`/`dom-serializer` directly, same as Task 2).
- Produces:
  - `export function findElementByDataGfId(html: string, id: string): { found: true; outerHtml: string; classes: string[] } | { found: false; ambiguous: boolean }` — locates the element; `ambiguous: true` if more than one element carries that id.
  - `export function replaceElementByDataGfId(html: string, id: string, replacementOuterHtml: string): string` — throws if `id` isn't found exactly once (call `findElementByDataGfId` first to get a clean error).
  - `export function maxDataGfId(html: string): number` — `0` if no elements carry the attribute.
  - `export function hashDocument(rawBytes: string): string` — SHA-256 hex digest, used for the document-revision optimistic-concurrency check (Task 8).

This is the "real HTML-tree manipulation" the spec calls for (`sanitize-html`'s `transformTags` can rewrite a tag's own attributes but has no supported way to excise/replace an entire subtree).

- [ ] **Step 1: Write the failing tests**

Create `test/componentElementTree.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  findElementByDataGfId,
  replaceElementByDataGfId,
  maxDataGfId,
  hashDocument,
} from '@/lib/services/componentElementTree';

describe('findElementByDataGfId', () => {
  it('finds a single match', () => {
    const html = '<div><span data-gf-id="3">hi</span></div>';
    const result = findElementByDataGfId(html, '3');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.outerHtml).toContain('hi');
      expect(result.outerHtml).toContain('data-gf-id="3"');
    }
  });

  it('reports not found for a missing id', () => {
    const result = findElementByDataGfId('<div data-gf-id="1"></div>', '99');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.ambiguous).toBe(false);
  });

  it('reports ambiguous for a duplicate id — fails closed, does not pick the first match', () => {
    const html = '<div data-gf-id="5"></div><span data-gf-id="5"></span>';
    const result = findElementByDataGfId(html, '5');
    expect(result.found).toBe(false);
    if (!result.found) expect(result.ambiguous).toBe(true);
  });

  it('returns the classes already on the matched element', () => {
    const html = '<button data-gf-id="1" class="btn primary">Go</button>';
    const result = findElementByDataGfId(html, '1');
    expect(result.found).toBe(true);
    if (result.found) expect(result.classes).toEqual(['btn', 'primary']);
  });
});

describe('replaceElementByDataGfId', () => {
  it('replaces the matched element subtree in place, leaving siblings untouched', () => {
    const html = '<div><span data-gf-id="1">old</span><p data-gf-id="2">keep</p></div>';
    const result = replaceElementByDataGfId(html, '1', '<span data-gf-id="1" class="gf-1">new</span>');
    expect(result).toContain('new');
    expect(result).not.toContain('old');
    expect(result).toContain('keep');
  });

  it('throws if the id is not found', () => {
    expect(() => replaceElementByDataGfId('<div data-gf-id="1"></div>', '99', '<div></div>')).toThrow();
  });

  it('throws if the id is ambiguous', () => {
    const html = '<div data-gf-id="1"></div><span data-gf-id="1"></span>';
    expect(() => replaceElementByDataGfId(html, '1', '<div></div>')).toThrow();
  });
});

describe('maxDataGfId', () => {
  it('returns the highest id present', () => {
    const html = '<div data-gf-id="3"><span data-gf-id="10"></span><p data-gf-id="2"></p></div>';
    expect(maxDataGfId(html)).toBe(10);
  });

  it('returns 0 when no element carries the attribute', () => {
    expect(maxDataGfId('<div><span></span></div>')).toBe(0);
  });
});

describe('hashDocument', () => {
  it('is deterministic for identical input', () => {
    expect(hashDocument('same content')).toBe(hashDocument('same content'));
  });

  it('differs for different input', () => {
    expect(hashDocument('a')).not.toBe(hashDocument('b'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/componentElementTree.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `componentElementTree.ts`**

Create `lib/services/componentElementTree.ts`:

```typescript
import crypto from 'crypto';
import { parseDocument, DomUtils } from 'htmlparser2';
import render from 'dom-serializer';
import type { Element as DomElement } from 'domhandler';

function isElement(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'tag';
}

function findAllByDataGfId(html: string, id: string): DomElement[] {
  const dom = parseDocument(html);
  return DomUtils.findAll(
    (el) => isElement(el) && el.attribs['data-gf-id'] === id,
    dom.children,
  ) as DomElement[];
}

export function findElementByDataGfId(
  html: string,
  id: string,
): { found: true; outerHtml: string; classes: string[] } | { found: false; ambiguous: boolean } {
  const matches = findAllByDataGfId(html, id);
  if (matches.length === 0) return { found: false, ambiguous: false };
  if (matches.length > 1) return { found: false, ambiguous: true };
  const el = matches[0];
  const classAttr = el.attribs['class'] ?? '';
  return {
    found: true,
    outerHtml: render(el),
    classes: classAttr.split(/\s+/).filter(Boolean),
  };
}

export function replaceElementByDataGfId(html: string, id: string, replacementOuterHtml: string): string {
  const dom = parseDocument(html);
  const matches = DomUtils.findAll(
    (el) => isElement(el) && el.attribs['data-gf-id'] === id,
    dom.children,
  ) as DomElement[];
  if (matches.length === 0) throw new Error(`replaceElementByDataGfId: no element with data-gf-id="${id}" found.`);
  if (matches.length > 1) throw new Error(`replaceElementByDataGfId: data-gf-id="${id}" is ambiguous (${matches.length} matches).`);

  const target = matches[0];
  const replacementDom = parseDocument(replacementOuterHtml);
  const replacementRoots = replacementDom.children.filter(isElement);
  if (replacementRoots.length !== 1) {
    throw new Error('replaceElementByDataGfId: replacement must be exactly one root element.');
  }
  const replacement = replacementRoots[0];

  const parent = target.parent;
  if (!parent) throw new Error('replaceElementByDataGfId: matched element has no parent (cannot be a document root).');
  const siblings = parent.children;
  const index = siblings.indexOf(target);
  replacement.parent = parent;
  siblings[index] = replacement;

  return render(dom);
}

export function maxDataGfId(html: string): number {
  const dom = parseDocument(html);
  const matches = DomUtils.findAll(
    (el) => isElement(el) && typeof el.attribs['data-gf-id'] === 'string',
    dom.children,
  ) as DomElement[];
  let max = 0;
  for (const el of matches) {
    const n = Number(el.attribs['data-gf-id']);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export function hashDocument(rawBytes: string): string {
  return crypto.createHash('sha256').update(rawBytes, 'utf-8').digest('hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/componentElementTree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/services/componentElementTree.ts test/componentElementTree.test.ts
git commit -m "feat: add htmlparser2-based element locate/replace/hash helpers"
```

---

### Task 4: Wire `assignElementIds()` into the 4 component-write paths

**Files:**
- Modify: `lib/services/ComponentGenerator.ts`
- Modify: `app/api/jobs/[id]/component/route.ts`
- Modify: `app/api/jobs/[id]/component/reset/route.ts`
- Modify: `app/api/assets/[id]/component/route.ts`
- Test: `test/componentGenerator*.test.ts` (existing files — add assertions), `test/componentEditRoutes.test.ts` (new, if no existing route-level test file covers these; check first)

**Interfaces:**
- Consumes: `assignElementIds` from Task 2.
- Produces: nothing new — this task only wires an existing function into 4 existing call sites.

There are 4 write paths, not 3 as a first read of the spec's prose might suggest — `app/api/jobs/[id]/component/route.ts` (job-scoped manual edit) and `app/api/assets/[id]/component/route.ts` (asset-scoped manual edit) are two DIFFERENT routes. The asset-scoped route has a `trustAsEdited` branch that must be excluded — trusted content never gets ids, per the spec.

- [ ] **Step 1: Check for an existing test file covering these 4 routes**

Run: `ls test/ | grep -i "component.*route\|componentGenerator"`

If tests already exist for `ComponentGenerator.generate()`, `app/api/jobs/[id]/component/route.ts`, `app/api/jobs/[id]/component/reset/route.ts`, and `app/api/assets/[id]/component/route.ts`, add the assertions in Step 2 to those existing files instead of creating a new one — follow whatever pattern is already there for route-level tests (likely using Next.js route handler test helpers already in use elsewhere in `test/`).

- [ ] **Step 2: Write the failing assertions**

For each of the 4 write paths, add (to whichever test file houses that route/method, existing or new) an assertion of this shape — adjust the exact call/fixture setup to match that file's existing conventions:

```typescript
it('assigns data-gf-id to every element on write', async () => {
  // ... existing setup for this route/method ...
  const stored = await fsPromises.readFile(expectedFilePath, 'utf-8');
  expect(stored).toMatch(/data-gf-id="\d+"/);
});
```

For the asset-scoped route specifically, also add:

```typescript
it('does NOT assign data-gf-id when trustAsEdited is true', async () => {
  // ... PATCH with { html, css, trustAsEdited: true } ...
  const stored = await fsPromises.readFile(expectedFilePath, 'utf-8');
  expect(stored).not.toMatch(/data-gf-id="\d+"/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run` (the affected test files)
Expected: FAIL — ids aren't being assigned yet.

- [ ] **Step 4: Wire `assignElementIds` into `ComponentGenerator.ts`**

In `lib/services/ComponentGenerator.ts`, change:

```typescript
    const raw = z.object({ html: z.string(), css: z.string() }).parse(toolInput);
    const tokens: ComponentTokens = {
      html: sanitizeComponentHtml(raw.html),
      css: sanitizeComponentCss(raw.css),
    };
```

to:

```typescript
    const raw = z.object({ html: z.string(), css: z.string() }).parse(toolInput);
    const tokens: ComponentTokens = {
      html: assignElementIds(sanitizeComponentHtml(raw.html)),
      css: sanitizeComponentCss(raw.css),
    };
```

Add `assignElementIds` to the existing import from `componentSanitize`:

```typescript
import { sanitizeComponentHtml, sanitizeComponentCss, assignElementIds } from '@/lib/services/componentSanitize';
```

- [ ] **Step 5: Wire into `app/api/jobs/[id]/component/route.ts`**

Change:

```typescript
      tokens = {
        html: sanitizeComponentHtml(rawInput.html),
        css: sanitizeComponentCss(rawInput.css),
      };
```

to:

```typescript
      tokens = {
        html: assignElementIds(sanitizeComponentHtml(rawInput.html)),
        css: sanitizeComponentCss(rawInput.css),
      };
```

Add `assignElementIds` to its existing `componentSanitize` import.

- [ ] **Step 6: Wire into `app/api/jobs/[id]/component/reset/route.ts`**

Same pattern as Step 5 — locate the `sanitizeComponentHtml(parsed.html)` call and wrap it with `assignElementIds(...)`, adding the import.

- [ ] **Step 7: Wire into `app/api/assets/[id]/component/route.ts` — non-trusted branch only**

Change:

```typescript
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
```

to:

```typescript
    let tokens: ComponentTokens;
    if (trustAsEdited) {
      // Explicitly trusted, unsanitized paste-back of externally-edited code
      // - the whole point of this path (see the reverse-sync design spec). Never gets
      // data-gf-id: trusted content is never selectable for click-to-select patching.
      tokens = { html: input.html, css: input.css };
    } else {
      try {
        tokens = {
          html: assignElementIds(sanitizeComponentHtml(input.html)),
          css: sanitizeComponentCss(input.css),
        };
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 });
      }
    }
```

Add `assignElementIds` to its existing `componentSanitize` import.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — all 4 write-path tests green, plus the full existing suite unaffected (no other test asserts an exact HTML string equal to un-id'd output for these paths — if one does, update its expected value to include the now-present `data-gf-id` attributes rather than treating that as a real failure).

- [ ] **Step 9: Commit**

```bash
git add lib/services/ComponentGenerator.ts app/api/jobs/[id]/component/route.ts app/api/jobs/[id]/component/reset/route.ts app/api/assets/[id]/component/route.ts test/
git commit -m "feat: assign element ids on every non-trusted component write path"
```

---

### Task 5: Strip `data-gf-id` on every export/share path

**Files:**
- Modify: `lib/services/SiteExporter.ts`
- Modify: `app/api/assets/[id]/export/route.ts`
- Modify: `app/api/assets/[id]/share-to-drive/route.ts`
- Modify: `app/api/pages/[id]/render/route.ts`
- Test: existing test files for each (`test/siteExporter*.test.ts`, etc. — check what exists first)

**Interfaces:**
- Consumes: a new `export function stripElementIds(html: string): string` — add this to `lib/services/componentElementTree.ts` (Task 3's file) as part of this task, since it's the same htmlparser2-based tree-manipulation family.

This is the other half of the export-safety fix the spec's round-3 review found (N1): `data-gf-id` must never reach a user's exported site (it's a GameForge-internal handle), but `.gf-<n>` classes (Task 6+) must survive intact, since CSS patches depend on them.

- [ ] **Step 1: Write the failing test for `stripElementIds`**

Add to `test/componentElementTree.test.ts`:

```typescript
import { stripElementIds } from '@/lib/services/componentElementTree';

describe('stripElementIds', () => {
  it('removes data-gf-id but keeps every other attribute, including classes', () => {
    const html = '<button data-gf-id="3" class="btn gf-3">Go</button>';
    const result = stripElementIds(html);
    expect(result).not.toContain('data-gf-id');
    expect(result).toContain('class="btn gf-3"');
    expect(result).toContain('Go');
  });

  it('is a no-op on html with no data-gf-id attributes', () => {
    const html = '<div><span>hi</span></div>';
    expect(stripElementIds(html)).toBe(render(parseDocument(html)));
  });
});
```

(Add the `render`/`parseDocument` imports from `dom-serializer`/`htmlparser2` to the top of the test file for the second assertion's comparison baseline.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/componentElementTree.test.ts`
Expected: FAIL — `stripElementIds` not exported yet.

- [ ] **Step 3: Implement `stripElementIds`**

Add to `lib/services/componentElementTree.ts`:

```typescript
export function stripElementIds(html: string): string {
  const dom = parseDocument(html);
  const matches = DomUtils.findAll(
    (el) => isElement(el) && typeof el.attribs['data-gf-id'] === 'string',
    dom.children,
  ) as DomElement[];
  for (const el of matches) {
    delete el.attribs['data-gf-id'];
  }
  return render(dom);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/componentElementTree.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `SiteExporter.ts`**

Read `lib/services/SiteExporter.ts` around its `sanitizeComponentHtml`/`sanitizeComponentCss` calls (near line 533/554 per the design spec) first, to see the exact current variable names. Wrap the HTML side with `stripElementIds(...)`:

```typescript
      const html = stripElementIds(trusted ? tokens.html : sanitizeComponentHtml(tokens.html));
```

(Apply to whichever exact expression currently produces the exported HTML — read the surrounding ~20 lines before editing, since this file's exact structure around scoping/trust wasn't re-verified in this plan and may differ slightly from the spec's paraphrase.) Add `stripElementIds` to its import from `componentElementTree`.

- [ ] **Step 6: Wire into `app/api/assets/[id]/export/route.ts`**

Same pattern: wrap the HTML output with `stripElementIds(...)` before it's returned/written. Read the route first to find the exact expression (per the earlier grep, line 66: `html: trusted ? tokens.html : sanitizeComponentHtml(tokens.html),`).

- [ ] **Step 7: Wire into `app/api/assets/[id]/share-to-drive/route.ts`**

Same pattern (per the earlier grep, line 90).

- [ ] **Step 8: Wire into `app/api/pages/[id]/render/route.ts`**

Same pattern (per the earlier grep, line 49) — this route also sets the `COMPONENT_PREVIEW_CSP`-style header; leave that as-is for now (Task 7 centralizes it).

- [ ] **Step 9: Write export-survival regression tests**

For each modified file's existing test suite, add one assertion confirming a component with a `data-gf-id` attribute in storage comes out WITHOUT it in the exported/shared output, e.g. (adapt to each file's existing test fixture conventions):

```typescript
it('strips data-gf-id from exported/shared output', async () => {
  // ... write a component file to storage/components/ containing data-gf-id="1" ...
  // ... call the export/share path under test ...
  expect(result).not.toContain('data-gf-id');
});
```

- [ ] **Step 10: Run all affected tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add lib/services/componentElementTree.ts lib/services/SiteExporter.ts app/api/assets/[id]/export/route.ts app/api/assets/[id]/share-to-drive/route.ts app/api/pages/[id]/render/route.ts test/
git commit -m "feat: strip data-gf-id from every export/share path"
```

---

### Task 6: Serve-time `gf-rev` meta tag and shared CSP constant

**Files:**
- Modify: `app/api/components/[filename]/route.ts`
- Test: `test/componentFileRoute.test.ts` (existing file, confirmed by the earlier grep)

**Interfaces:**
- Consumes: `COMPONENT_PREVIEW_CSP` (Task 1), `hashDocument` (Task 3).
- Produces: the served document now contains `<meta name="gf-rev" content="<sha256 of the raw stored file bytes>">` in its `<head>`.

The revision hash must be computed over the RAW stored file (before re-sanitization/theme-CSS-append), per the spec's round-3 fix (N7) — the served document is not byte-identical to the stored file, so hashing the served output would never match a server-side hash of storage.

- [ ] **Step 1: Write the failing test**

Add to `test/componentFileRoute.test.ts`:

```typescript
import { hashDocument } from '@/lib/services/componentElementTree';
import { COMPONENT_PREVIEW_CSP } from '@/lib/services/componentSanitize';

it('embeds a gf-rev meta tag hashing the raw stored file, not the served output', async () => {
  // ... write a known component file to storage/components/<name> ...
  const rawStored = await fsPromises.readFile(filePath, 'utf-8');
  const res = await GET(/* request for that file */);
  const body = await res.text();
  const match = body.match(/<meta name="gf-rev" content="([a-f0-9]+)">/);
  expect(match).not.toBeNull();
  expect(match![1]).toBe(hashDocument(rawStored));
});

it('sends the shared CSP constant, not a re-typed literal', async () => {
  const res = await GET(/* request */);
  expect(res.headers.get('Content-Security-Policy')).toBe(COMPONENT_PREVIEW_CSP);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/componentFileRoute.test.ts`
Expected: FAIL — no meta tag yet, and the CSP header, while currently correct by coincidence, isn't sourced from the shared constant.

- [ ] **Step 3: Implement**

In `app/api/components/[filename]/route.ts`, add imports:

```typescript
import { COMPONENT_PREVIEW_CSP } from '@/lib/services/componentSanitize';
import { hashDocument } from '@/lib/services/componentElementTree';
```

After `data = await fsPromises.readFile(physicalPath, 'utf-8');` succeeds, compute the hash of the raw bytes (before any sanitization):

```typescript
  const revisionHash = hashDocument(data);
```

Where `safeDocument` is built via `combineComponentHtml`, the served document needs the meta tag injected into its `<head>`. Since `combineComponentHtml` (in `lib/services/componentDocument.ts`) doesn't currently take a "extra head content" parameter, inject it with a simple string replace on the assembled document rather than modifying `combineComponentHtml`'s signature (which is also used by the write paths, where no revision meta tag belongs):

```typescript
  safeDocument = safeDocument.replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8">\n<meta name="gf-rev" content="${revisionHash}">`,
  );
```

Replace the inline CSP header literal:

```typescript
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
```

with:

```typescript
      'Content-Security-Policy': COMPONENT_PREVIEW_CSP,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/componentFileRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/components/[filename]/route.ts test/componentFileRoute.test.ts
git commit -m "feat: embed document revision hash and use shared CSP constant in component preview route"
```

---

### Task 7: `ComponentGenerator.patchElement()`

**Files:**
- Modify: `lib/services/ComponentGenerator.ts`
- Test: existing `ComponentGenerator` test file(s) — check `test/` for the current naming convention (e.g. `componentGenerator*.test.ts`) and follow it.

**Interfaces:**
- Consumes: `callClaudeTool`/`callOllamaTool` (existing, same pattern `generate()` uses), `sanitizeComponentHtml`/`sanitizeComponentCss` (existing).
- Produces:
```typescript
export interface PatchedElement {
  html: string; // replacement outerHTML fragment, sanitized
  cssDeclarations: string | null; // raw declaration list (no selector), sanitized as `.x{...}` internally then unwrapped, or null if no style change requested
}

export interface ComponentGenerator {
  // ... existing generate() ...
  patchElement(elementOuterHtml: string, instruction: string, currentDeclarations: string | null, styleId: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<PatchedElement>;
}
```

`currentDeclarations` is the element's currently-effective CSS (its original stylesheet rule plus, if already patched, its existing `.gf-<n>` rule layered on top) — the caller (Task 8) is responsible for assembling this from the stored document; `patchElement()` just forwards it into the prompt as context.

- [ ] **Step 1: Write the failing test**

Add to the existing `ComponentGenerator` test file:

```typescript
describe('patchElement', () => {
  it('returns sanitized html and css declarations from the tool call', async () => {
    // Mock callClaudeTool (or whatever this test file's existing generate() tests mock)
    // to return { html: '<button class="btn">New</button>', cssDeclarations: 'color: blue;' }
    const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
    const result = await generator.patchElement(
      '<button class="btn">Old</button>',
      'make it say New',
      'color: red;',
      'style-1',
    );
    expect(result.html).toContain('New');
    expect(result.cssDeclarations).toBe('color: blue;');
  });

  it('sanitizes the returned html fragment', async () => {
    // Mock the tool call to return html containing a disallowed tag, e.g. '<script>x</script><button>ok</button>'
    // ...
    const result = await generator.patchElement(/* ... */);
    expect(result.html).not.toContain('script');
  });

  it('passes null cssDeclarations through when the AI makes no style change', async () => {
    // Mock the tool call to omit cssDeclarations / return null
    const result = await generator.patchElement(/* ... */);
    expect(result.cssDeclarations).toBeNull();
  });
});
```

Follow this test file's existing mocking convention for `callClaudeTool`/`callOllamaTool` exactly — read the existing `generate()` tests immediately above this new `describe` block before writing the mocks, since the exact mock shape (module-level `vi.mock` vs. dependency injection) needs to match established patterns in this file rather than being reinvented here.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run` (the ComponentGenerator test file)
Expected: FAIL — `patchElement` doesn't exist.

- [ ] **Step 3: Implement `patchElement()`**

In `lib/services/ComponentGenerator.ts`, add a new tool schema near `TOOL_INPUT_SCHEMA`:

```typescript
const PATCH_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    html: { type: 'string', description: 'The complete replacement outerHTML for this one element — the same tag or a different one, preserving its data-gf-id attribute and any other attributes not relevant to the requested change.' },
    cssDeclarations: {
      type: 'string',
      description: 'CSS declarations only (e.g. "color: blue; font-weight: bold;") — never a selector or rule braces, the caller wraps this itself. Omit entirely if the request does not require a style change. Must be the COMPLETE desired declaration set: this replaces any existing patch declarations for this element wholesale, it does not merge with them — if the element was already patched to be bold and this request only changes color, the response must still include font-weight: bold, not just the color change, or the earlier change is silently lost.',
    },
  },
  required: ['html'],
};
```

Add the `patchElement` method to the `ComponentGenerator` interface:

```typescript
export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent>;
  patchElement(elementOuterHtml: string, instruction: string, currentDeclarations: string | null, styleId: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<PatchedElement>;
}
```

Add the `PatchedElement` interface near `GeneratedComponent`:

```typescript
export interface PatchedElement {
  html: string;
  cssDeclarations: string | null;
}
```

Implement on `ClaudeApiComponentGenerator`, after `generate()`:

```typescript
  async patchElement(
    elementOuterHtml: string,
    instruction: string,
    currentDeclarations: string | null,
    styleId: string,
    signal?: AbortSignal,
    providerOverride?: OllamaProviderOverride,
  ): Promise<PatchedElement> {
    const style = await styleService.getById(styleId);
    const declarationsSection = currentDeclarations
      ? `\n\nIts current effective styling (already includes any prior patch to this element, layered over its base styling):\n${currentDeclarations}`
      : '\n\nIt has no element-specific styling currently applied beyond its base stylesheet rules.';
    const fullPrompt = `You are patching ONE element inside an existing website UI component. Change only what the instruction asks — do not restructure the element beyond what's needed, do not touch anything outside it. Style Bible parameters (JSON): ${style?.parameters ?? '{}'}

The element's current HTML:
${elementOuterHtml}${declarationsSection}

Instruction: ${instruction}

Respond by calling the emit_element_patch tool with the element's complete replacement html and, if a style change is requested, the COMPLETE desired css declaration list (not a diff — see the tool's own description).`;

    const toolInput = providerOverride
      ? await callOllamaTool({
          host: providerOverride.host,
          model: providerOverride.model,
          toolName: 'emit_element_patch',
          toolDescription: 'Emit a patched replacement for one HTML element, and optionally its complete CSS declaration list.',
          inputSchema: PATCH_TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: providerOverride.correctionRequested
            ? `${fullPrompt}\n\nYou did not call the emit_element_patch tool last time -- you must call it now with valid arguments matching its schema.`
            : fullPrompt }],
          signal,
          operationLabel: 'element patch',
          truncatedMessage: 'the element patch could not be generated',
        })
      : await callClaudeTool({
          provider: this.provider,
          apiKey: this.apiKey,
          toolName: 'emit_element_patch',
          toolDescription: 'Emit a patched replacement for one HTML element, and optionally its complete CSS declaration list.',
          inputSchema: PATCH_TOOL_INPUT_SCHEMA,
          messages: [{ role: 'user', content: fullPrompt }],
          signal,
          operationLabel: 'element patch',
          truncatedMessage: 'the element patch could not be generated',
        });

    const raw = z.object({ html: z.string(), cssDeclarations: z.string().optional() }).parse(toolInput);
    return {
      html: sanitizeComponentHtml(raw.html),
      cssDeclarations: raw.cssDeclarations ?? null,
    };
  }
```

Add the same method to `MockComponentGenerator` (the second `implements ComponentGenerator` class in this file, used when no real API key is configured) — check its existing `generate()` implementation for the established mock-output convention and mirror it minimally, e.g. returning the input html unchanged and `cssDeclarations: null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run` (the ComponentGenerator test file)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/services/ComponentGenerator.ts test/
git commit -m "feat: add ComponentGenerator.patchElement for scoped single-element AI patches"
```

---

### Task 8: `componentPatchService.ts` — the splice orchestration

**Files:**
- Create: `lib/services/componentPatchService.ts`
- Test: `test/componentPatchService.test.ts`

**Interfaces:**
- Consumes: `findElementByDataGfId`, `replaceElementByDataGfId`, `maxDataGfId`, `hashDocument` (Task 3), `assignElementIds` (Task 2), `sanitizeComponentHtml`/`sanitizeComponentCss` (existing), `ComponentGenerator.patchElement` (Task 7), `parseComponentHtml`/`combineComponentHtml` (existing), `assetService.update` (existing).
- Produces:
```typescript
export type PatchError =
  | { code: 'COMPONENT_NOT_FOUND' }
  | { code: 'ELEMENT_NOT_FOUND' }
  | { code: 'ELEMENT_CHANGED' }
  | { code: 'SANITIZE_REJECTED'; message: string }
  | { code: 'CONFLICT' }
  | { code: 'WRITE_FAILED'; message: string };

export interface PatchResult {
  ok: true;
  idMap: { rootId: string; newDescendantIds: string[] };
  newDocumentHash: string;
}

export async function applyElementPatch(params: {
  filename: string; // storage/components/<filename>, already validated by the caller
  assetId: string; // for assetService.update's history recording
  requestingUserId: string;
  isAdmin: boolean;
  dataGfId: string;
  documentHash: string; // the client-sent revision hash to verify against
  instruction: string;
  styleId: string;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<PatchResult | { ok: false; error: PatchError }>
```

This is one function, callable from both the job-scoped and asset-scoped patch endpoints (Tasks 9-10) — the two routes differ only in HOW they resolve `filename`/`assetId`/authorization before calling this, not in the splice logic itself.

- [ ] **Step 1: Write the failing tests**

Create `test/componentPatchService.test.ts` — set up a real temp `storage/components/` directory (following this codebase's established pattern of testing file-backed services against a real temp directory rather than mocking `fs`, per `setProjectRootForTests()`/`DatabaseConnection.resetForTests()` used elsewhere in this test suite):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import path from 'path';
import { applyElementPatch } from '@/lib/services/componentPatchService';
import { hashDocument } from '@/lib/services/componentElementTree';
// ... same setProjectRootForTests / DatabaseConnection.resetForTests / fixture setup
//     convention as the existing SiteExporter/componentSanitize tests use.

describe('applyElementPatch', () => {
  // ... beforeEach: reset test project root, write a fixture component file with a known
  //     data-gf-id="1" element and a known asset row, mock ComponentGenerator.patchElement
  //     to return a fixed { html, cssDeclarations } ...

  it('splices a successful patch into storage and returns the new document hash', async () => {
    const result = await applyElementPatch({ /* ... valid params, correct documentHash ... */ });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const stored = await fsPromises.readFile(/* fixture path */, 'utf-8');
      expect(stored).toContain('gf-1'); // the assigned class
      expect(hashDocument(stored)).not.toBe(result.newDocumentHash); // re-hash happens post-write in a real caller; this asserts the value changed vs. the original at minimum — adjust to whatever the exact pre/post semantics land on during implementation
    }
  });

  it('returns ELEMENT_CHANGED when the sent documentHash is stale (pre-AI-call check)', async () => {
    const result = await applyElementPatch({ /* ... documentHash: 'wrong-hash' ... */ });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ELEMENT_CHANGED');
    // Also assert the AI mock was NOT called — the cheap pre-check must short-circuit before it.
  });

  it('returns ELEMENT_NOT_FOUND for a missing dataGfId', async () => {
    const result = await applyElementPatch({ /* ... dataGfId: '999' ... */ });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ELEMENT_NOT_FOUND');
  });

  it('returns COMPONENT_NOT_FOUND when the file does not exist', async () => {
    const result = await applyElementPatch({ /* ... filename: 'does-not-exist.html' ... */ });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMPONENT_NOT_FOUND');
  });

  it('preserves the target data-gf-id and assigns fresh ids to any new descendants', async () => {
    // Mock patchElement to return html with a NEW nested element
    const result = await applyElementPatch({ /* ... */ });
    const stored = await fsPromises.readFile(/* fixture path */, 'utf-8');
    expect(stored).toContain('data-gf-id="1"'); // target unchanged
    // and a new descendant id, not colliding with any other id in the document
  });

  it('replaces (not accumulates) a second patch to the same element', async () => {
    // First call patches with color:blue, second call patches with color:red
    await applyElementPatch({ /* ... instruction 1 ... */ });
    const result2 = await applyElementPatch({ /* ... instruction 2, correct fresh documentHash ... */ });
    const stored = await fsPromises.readFile(/* fixture path */, 'utf-8');
    const ruleMatches = [...stored.matchAll(/\.gf-1\s*\{/g)];
    expect(ruleMatches.length).toBe(1); // exactly one rule for this element, not two
  });

  it('rejects a fragment containing a literal </body> before splicing (not just on round-trip failure)', async () => {
    // Mock patchElement to return html containing the literal string "</body>" somewhere
    // that would survive sanitizeComponentHtml (e.g. inside an allowed attribute value)
    const result = await applyElementPatch({ /* ... */ });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANITIZE_REJECTED');
  });

  it('updates the asset prompt with the patch instruction, does not set editedExternally', async () => {
    await applyElementPatch({ /* ... instruction: 'make it blue' ... */ });
    // ... fetch the asset row, assert prompt contains 'make it blue', editedExternally is unchanged (0/false)
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/componentPatchService.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `componentPatchService.ts`**

```typescript
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import type { OllamaProviderOverride } from '@/lib/services/ollamaToolCall';
import { parseComponentHtml, combineComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss, assignElementIds } from '@/lib/services/componentSanitize';
import {
  findElementByDataGfId,
  replaceElementByDataGfId,
  maxDataGfId,
  hashDocument,
} from '@/lib/services/componentElementTree';

export type PatchError =
  | { code: 'COMPONENT_NOT_FOUND' }
  | { code: 'ELEMENT_NOT_FOUND' }
  | { code: 'ELEMENT_CHANGED' }
  | { code: 'SANITIZE_REJECTED'; message: string }
  | { code: 'CONFLICT' }
  | { code: 'WRITE_FAILED'; message: string };

export interface PatchResult {
  ok: true;
  idMap: { rootId: string; newDescendantIds: string[] };
  newDocumentHash: string;
}

// One mutex per filename, in-process only — see the design spec's Concurrency section for why
// this is sufficient (single Node process; next dev / single-instance next start) and what
// breaks if that assumption ever changes (CONFLICT silently becomes last-writer-wins).
const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filename: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(filename) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(filename, prior.then(() => next));
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(filename) === undefined) return undefined as never; // unreachable, satisfies control flow
  }
}

const RAW_MARKER_PATTERN = /<\/(body|head|style)>/i;

export async function applyElementPatch(params: {
  filename: string;
  assetId: string;
  requestingUserId: string;
  isAdmin: boolean;
  dataGfId: string;
  documentHash: string;
  instruction: string;
  styleId: string;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<PatchResult | { ok: false; error: PatchError }> {
  const filePath = path.join(getProjectRoot(), 'storage', 'components', params.filename);

  async function readStored(): Promise<string | null> {
    try {
      return await fsPromises.readFile(filePath, 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  // Phase 1: cheap, unlocked pre-check — fail fast on a stale selection before spending an AI call.
  const preCheckDoc = await readStored();
  if (preCheckDoc === null) return { ok: false, error: { code: 'COMPONENT_NOT_FOUND' } };
  if (hashDocument(preCheckDoc) !== params.documentHash) {
    return { ok: false, error: { code: 'ELEMENT_CHANGED' } };
  }

  const preCheckTokens = parseComponentHtml(preCheckDoc);
  const located = findElementByDataGfId(preCheckTokens.html, params.dataGfId);
  if (!located.found) return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };

  const gfClass = `gf-${params.dataGfId}`;
  const currentDeclarations = extractDeclarationsForClass(preCheckTokens.css, gfClass);

  // AI call — deliberately outside the mutex; nothing here touches the file.
  let patched;
  try {
    patched = await getComponentGenerator().patchElement(
      located.outerHtml,
      params.instruction,
      currentDeclarations,
      params.styleId,
      params.signal,
      params.providerOverride,
    );
  } catch (e: any) {
    return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e.message } };
  }

  return withFileLock(params.filename, async () => {
    // Phase 2: locked re-check — the document may have changed during the AI call.
    const currentDoc = await readStored();
    if (currentDoc === null) return { ok: false, error: { code: 'COMPONENT_NOT_FOUND' } };
    if (hashDocument(currentDoc) !== params.documentHash) {
      return { ok: false, error: { code: 'ELEMENT_CHANGED' } };
    }

    const tokens = parseComponentHtml(currentDoc);
    const reLocated = findElementByDataGfId(tokens.html, params.dataGfId);
    if (!reLocated.found) return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };

    if (RAW_MARKER_PATTERN.test(patched.html)) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: 'Patch contains a disallowed marker sequence.' } };
    }

    let sanitizedHtml: string;
    try {
      sanitizedHtml = sanitizeComponentHtml(patched.html);
    } catch (e: any) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e.message } };
    }
    if (!sanitizedHtml.trim()) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: 'Patch sanitized to nothing.' } };
    }

    const startAt = maxDataGfId(tokens.html) + 1;
    const idAssignedFragment = assignElementIds(sanitizedHtml, { preserveRootId: params.dataGfId, startAt });

    // Ensure the fragment's root carries the gf-<id> class (added on first patch, reused after).
    const withClass = ensureClassOnRoot(idAssignedFragment, gfClass);

    let newCss = tokens.css;
    if (patched.cssDeclarations !== null) {
      let sanitizedRule: string;
      try {
        sanitizedRule = sanitizeComponentCss(`.${gfClass} { ${patched.cssDeclarations} }`);
      } catch (e: any) {
        return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e.message } };
      }
      newCss = replaceOrAppendRuleForClass(tokens.css, gfClass, sanitizedRule);
    }

    let newHtml: string;
    try {
      newHtml = replaceElementByDataGfId(tokens.html, params.dataGfId, withClass);
    } catch (e: any) {
      return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };
    }

    const combined = combineComponentHtml({ html: newHtml, css: newCss });

    // Round-trip assertion — postcondition backstop for the raw-marker check above.
    const roundTripped = parseComponentHtml(combined);
    if (roundTripped.html !== newHtml || roundTripped.css !== newCss) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: 'Patch failed document round-trip validation.' } };
    }

    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, combined);
    } catch (e: any) {
      return { ok: false, error: { code: 'WRITE_FAILED', message: e.message } };
    }

    const asset = await assetService.getById(params.assetId);
    const existingPrompt = asset?.prompt ?? '';
    await assetService.update(
      params.assetId,
      params.requestingUserId,
      { prompt: `${existingPrompt}\n\nPatch: ${params.instruction}` },
      params.isAdmin,
    );

    const newDescendantIds = [...idAssignedFragment.matchAll(/data-gf-id="(\d+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== params.dataGfId);

    return {
      ok: true,
      idMap: { rootId: params.dataGfId, newDescendantIds },
      newDocumentHash: hashDocument(combined),
    };
  });
}

// Extracts the raw declaration text inside `.gf-<n> { ... }` from a stylesheet, or null if no
// such rule exists yet. Simple string extraction (not a full postcss walk) is sufficient here
// since sanitizeComponentCss already guarantees the stored CSS is well-formed.
function extractDeclarationsForClass(css: string, className: string): string | null {
  const match = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
  return match ? match[1].trim() : null;
}

function replaceOrAppendRuleForClass(css: string, className: string, newRule: string): string {
  const pattern = new RegExp(`\\.${className}\\s*\\{[^}]*\\}`);
  if (pattern.test(css)) return css.replace(pattern, newRule);
  return `${css}\n${newRule}`;
}

function ensureClassOnRoot(html: string, className: string): string {
  // html is a single-root fragment (assignElementIds' preserveRootId mode already enforces this).
  const match = html.match(/^<([a-zA-Z0-9]+)([^>]*)>/);
  if (!match) return html;
  const [full, tag, attrs] = match;
  const classMatch = attrs.match(/class="([^"]*)"/);
  if (classMatch) {
    if (classMatch[1].split(/\s+/).includes(className)) return html; // already present
    const newAttrs = attrs.replace(/class="([^"]*)"/, `class="$1 ${className}"`);
    return html.replace(full, `<${tag}${newAttrs}>`);
  }
  return html.replace(full, `<${tag}${attrs} class="${className}">`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/componentPatchService.test.ts`
Expected: PASS. If the mutex helper's control flow (the `withFileLock` implementation above) doesn't type-check cleanly or the unreachable-branch workaround looks wrong under `tsc --noEmit`, simplify it to a straightforward async queue — the exact mutex mechanics are an implementation detail the spec left open, the requirement is just "serializes writes to the same filename, doesn't hold the lock across the AI call."

- [ ] **Step 5: Run `npx tsc --noEmit` and `npx eslint app lib worker.ts`**

Fix any type or lint errors before proceeding — this file has more moving parts than most in this plan.

- [ ] **Step 6: Commit**

```bash
git add lib/services/componentPatchService.ts test/componentPatchService.test.ts
git commit -m "feat: add componentPatchService orchestrating the element patch splice flow"
```

---

### Task 9: Job-scoped patch-element endpoint

**Files:**
- Create: `app/api/jobs/[id]/component/patch-element/route.ts`
- Test: `test/jobComponentPatchRoute.test.ts`

**Interfaces:**
- Consumes: `applyElementPatch` (Task 8).

Mirrors `app/api/jobs/[id]/component/route.ts`'s auth/ownership/status checks exactly. A job's asset is resolved via `assetService.getByImagePath(job.result_path)` — no new lookup method needed. This works because a job's `result_path` and its promoted asset's `image_path` are the same filename (confirmed against `app/api/components/[filename]/route.ts`, which already uses this exact `getByImagePath(filename)` pattern to resolve an asset from a component filename for its own trust check). If the component hasn't been promoted to an asset yet, `getByImagePath` returns `null` — `applyElementPatch`'s history-recording step needs a real `assetId` to write to, so this route returns 400 in that case rather than guessing one.

- [ ] **Step 1: Write the failing test**

```typescript
// test/jobComponentPatchRoute.test.ts
// Follow the exact setup/mocking conventions of the existing
// test file for app/api/jobs/[id]/component/route.ts (auth mocking, job fixture creation).

it('returns 401 when not logged in', async () => { /* ... */ });
it('returns 403 when the requesting user is not the job creator or an admin', async () => { /* ... */ });
it('returns 404 for an unknown job', async () => { /* ... */ });
it('calls applyElementPatch with the resolved asset id and returns its result', async () => {
  // mock applyElementPatch, assert the route returns { success: true, ... } shaped output
});
it('maps a PatchError to the correct HTTP status', async () => {
  // e.g. ELEMENT_CHANGED -> 409, ELEMENT_NOT_FOUND -> 404, SANITIZE_REJECTED -> 400
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jobComponentPatchRoute.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import { applyElementPatch, type PatchError } from '@/lib/services/componentPatchService';

export const dynamic = 'force-dynamic';

const PatchElementSchema = z.object({
  dataGfId: z.string().min(1),
  documentHash: z.string().min(1),
  instruction: z.string().min(1),
});

function statusForError(error: PatchError): number {
  switch (error.code) {
    case 'COMPONENT_NOT_FOUND': return 404;
    case 'ELEMENT_NOT_FOUND': return 404;
    case 'ELEMENT_CHANGED': return 409;
    case 'CONFLICT': return 409;
    case 'SANITIZE_REJECTED': return 400;
    case 'WRITE_FAILED': return 500;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can edit this job.' }, { status: 403 });
    }
    if (job.status !== 'complete' || job.output_kind !== 'component' || !job.result_path) {
      return NextResponse.json({ success: false, error: 'Job has no editable component' }, { status: 400 });
    }
    if (job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    // A job's result_path and its promoted asset's image_path are the same filename — this is
    // the identical pattern app/api/components/[filename]/route.ts already uses to resolve an
    // asset's trust flag from a component filename, reused here instead of adding a new lookup.
    const asset = await assetService.getByImagePath(job.result_path);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'This component has not been promoted to an asset yet' }, { status: 400 });
    }

    const input = PatchElementSchema.parse(await req.json());

    const result = await applyElementPatch({
      filename: job.result_path,
      assetId: asset.id,
      requestingUserId: user.id,
      isAdmin: !!user.is_admin,
      dataGfId: input.dataGfId,
      documentHash: input.documentHash,
      instruction: input.instruction,
      styleId: job.style_id,
    });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error.code }, { status: statusForError(result.error) });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Unexpected error in job component patch-element route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jobComponentPatchRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/jobs/[id]/component/patch-element/route.ts test/jobComponentPatchRoute.test.ts
git commit -m "feat: add job-scoped element patch endpoint"
```

---

### Task 10: Asset-scoped patch-element endpoint

**Files:**
- Create: `app/api/assets/[id]/component/patch-element/route.ts`
- Test: `test/assetComponentPatchRoute.test.ts`

**Interfaces:**
- Consumes: `applyElementPatch` (Task 8).

Mirrors `app/api/assets/[id]/component/route.ts`'s auth/ownership/`is_deleted`/`output_kind` checks. Simpler than Task 9 — the asset id is already the route param, no job-to-asset resolution needed. Must additionally reject when the target asset has `edited_externally` set (trusted assets have no `data-gf-id` attributes at all — `applyElementPatch` would already return `ELEMENT_NOT_FOUND` for any id on such a file, but rejecting earlier with a clearer message is better UX, matching the spec's "detected client-side" intent as a server-side backstop).

- [ ] **Step 1: Write the failing test**

```typescript
// test/assetComponentPatchRoute.test.ts — mirror test/assetComponentEditRoute.test.ts's (or
// whatever the existing test file for app/api/assets/[id]/component/route.ts is named) setup.

it('returns 401 when not logged in', async () => { /* ... */ });
it('returns 404 for a deleted or non-component asset', async () => { /* ... */ });
it('returns 403 when the requesting user is not the asset creator or an admin', async () => { /* ... */ });
it('returns 400 with a clear message for an edited_externally asset', async () => { /* ... */ });
it('calls applyElementPatch and returns its result', async () => { /* ... */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assetComponentPatchRoute.test.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { assetService } from '@/lib/services/AssetService';
import { applyElementPatch, type PatchError } from '@/lib/services/componentPatchService';

export const dynamic = 'force-dynamic';

const PatchElementSchema = z.object({
  dataGfId: z.string().min(1),
  documentHash: z.string().min(1),
  instruction: z.string().min(1),
});

function statusForError(error: PatchError): number {
  switch (error.code) {
    case 'COMPONENT_NOT_FOUND': return 404;
    case 'ELEMENT_NOT_FOUND': return 404;
    case 'ELEMENT_CHANGED': return 409;
    case 'CONFLICT': return 409;
    case 'SANITIZE_REJECTED': return 400;
    case 'WRITE_FAILED': return 500;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    if (asset.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can edit this asset.' }, { status: 403 });
    }
    if (asset.edited_externally === 1) {
      return NextResponse.json({ success: false, error: 'Hand-edited components cannot be patched — use full regeneration instead.' }, { status: 400 });
    }
    if (!asset.image_path || asset.image_path.includes('/') || asset.image_path.includes('\\') || asset.image_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 500 });
    }

    const input = PatchElementSchema.parse(await req.json());

    const result = await applyElementPatch({
      filename: asset.image_path,
      assetId: id,
      requestingUserId: user.id,
      isAdmin: !!user.is_admin,
      dataGfId: input.dataGfId,
      documentHash: input.documentHash,
      instruction: input.instruction,
      styleId: asset.style_id,
    });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error.code }, { status: statusForError(result.error) });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Unexpected error in asset component patch-element route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assetComponentPatchRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/assets/[id]/component/patch-element/route.ts test/assetComponentPatchRoute.test.ts
git commit -m "feat: add asset-scoped element patch endpoint"
```

---

### Task 11: `inspectFrame.ts` — the narrow frame-DOM-read module

**Files:**
- Create: `lib/preview/inspectFrame.ts`
- Test: `test/inspectFrame.test.tsx` (or `.test.ts` with jsdom — check this project's existing convention for testing browser-DOM-touching code; if none exists, use `@testing-library/dom`-style direct DOM assertions against a real jsdom `iframe`)

**Interfaces:**
- Produces:
```typescript
export interface FrameElementInfo {
  tagName: string;
  classes: string[];
  id: string | null; // this is the DOM `id` attribute the element may carry, NOT data-gf-id
  dataGfId: string | null;
  rect: DOMRect;
}

export function getElementAt(frame: HTMLIFrameElement, clientX: number, clientY: number): FrameElementInfo | null;
export function getRevisionHash(frame: HTMLIFrameElement): string | null; // reads the gf-rev meta tag
export function preventFrameAnchorNavigation(frame: HTMLIFrameElement): () => void; // returns a cleanup fn; re-call on every frame 'load'
export function injectHighlight(frame: HTMLIFrameElement, rect: DOMRect): void;
export function removeHighlight(frame: HTMLIFrameElement): void;
```

**This is the single security-critical boundary the whole design leans on** — no function in this module may return a node, `outerHTML`, or `innerHTML`. Every call site outside this file must go through one of these functions, never `frame.contentDocument` directly.

- [ ] **Step 1: Write the failing tests**

Create `test/inspectFrame.test.ts` (adjust the jsdom/DOM test setup to match whatever convention this codebase already uses for component tests — check an existing `.test.tsx` file under `test/` for the exact test-environment config first):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getElementAt,
  getRevisionHash,
  preventFrameAnchorNavigation,
  injectHighlight,
  removeHighlight,
} from '@/lib/preview/inspectFrame';

describe('inspectFrame', () => {
  let iframe: HTMLIFrameElement;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><head><meta name="gf-rev" content="abc123def"></head>
      <body><button class="btn primary" data-gf-id="1">Go</button></body></html>
    `);
    iframe.contentDocument!.close();
  });

  it('getElementAt returns only the narrow shape — never a node reference', () => {
    const btn = iframe.contentDocument!.querySelector('button')!;
    const rect = btn.getBoundingClientRect();
    const info = getElementAt(iframe, rect.left + 1, rect.top + 1);
    expect(info).not.toBeNull();
    expect(info!.tagName).toBe('button');
    expect(info!.classes).toEqual(['btn', 'primary']);
    expect(info!.dataGfId).toBe('1');
    expect(Object.keys(info!).sort()).toEqual(['classes', 'dataGfId', 'id', 'rect', 'tagName']);
  });

  it('getRevisionHash reads the gf-rev meta tag', () => {
    expect(getRevisionHash(iframe)).toBe('abc123def');
  });

  it('getRevisionHash returns null if the meta tag is absent', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write('<html><head></head><body></body></html>');
    iframe.contentDocument!.close();
    expect(getRevisionHash(iframe)).toBeNull();
  });

  it('preventFrameAnchorNavigation prevents default on anchor clicks', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write('<html><body><a href="https://example.com">link</a></body></html>');
    iframe.contentDocument!.close();
    const cleanup = preventFrameAnchorNavigation(iframe);
    const a = iframe.contentDocument!.querySelector('a')!;
    const event = new iframe.contentWindow!.MouseEvent('click', { bubbles: true, cancelable: true });
    const wasDefaultPrevented = !a.dispatchEvent(event);
    expect(wasDefaultPrevented).toBe(true);
    cleanup();
  });

  it('injectHighlight adds a non-interactive, reset-styled element into the frame', () => {
    injectHighlight(iframe, new DOMRect(10, 20, 30, 40));
    const highlight = iframe.contentDocument!.querySelector('[data-gf-highlight]');
    expect(highlight).not.toBeNull();
    const style = (highlight as HTMLElement).style;
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('fixed');
  });

  it('removeHighlight removes it', () => {
    injectHighlight(iframe, new DOMRect(0, 0, 10, 10));
    removeHighlight(iframe);
    expect(iframe.contentDocument!.querySelector('[data-gf-highlight]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspectFrame.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `inspectFrame.ts`**

```typescript
export interface FrameElementInfo {
  tagName: string;
  classes: string[];
  id: string | null;
  dataGfId: string | null;
  rect: DOMRect;
}

/**
 * The ONLY module in this codebase allowed to read `iframe.contentDocument` directly for the
 * click-to-select feature. Every export here returns a narrow, copied value — never a node,
 * never outerHTML/innerHTML. This boundary is load-bearing for the security reasoning behind
 * relaxing the preview sandbox to allow-same-origin; see
 * docs/superpowers/specs/2026-09-14-element-specific-patching-design.md.
 */
export function getElementAt(frame: HTMLIFrameElement, clientX: number, clientY: number): FrameElementInfo | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const el = doc.elementFromPoint(clientX, clientY);
  if (!el || !(el instanceof doc.defaultView!.HTMLElement)) return null;
  const rect = el.getBoundingClientRect();
  return {
    tagName: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    id: el.id || null,
    dataGfId: el.getAttribute('data-gf-id'),
    rect,
  };
}

export function getRevisionHash(frame: HTMLIFrameElement): string | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const meta = doc.querySelector('meta[name="gf-rev"]');
  return meta?.getAttribute('content') ?? null;
}

export function preventFrameAnchorNavigation(frame: HTMLIFrameElement): () => void {
  const doc = frame.contentDocument;
  if (!doc) return () => {};
  function handler(e: Event) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('a')) e.preventDefault();
  }
  doc.addEventListener('click', handler, true);
  return () => doc.removeEventListener('click', handler, true);
}

export function injectHighlight(frame: HTMLIFrameElement, rect: DOMRect): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  removeHighlight(frame);
  const el = doc.createElement('div');
  el.setAttribute('data-gf-highlight', '');
  // Order matters: `all: initial` resets every property, INCLUDING pointer-events and position —
  // it must come first in this same declaration, with the properties this element actually
  // needs applied after it, or the reset silently wins and the highlight becomes interactive.
  el.style.cssText = `
    all: initial;
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: 2147483647;
    pointer-events: none;
    outline: 2px solid #4d90fe;
    outline-offset: -1px;
    box-sizing: border-box;
  `;
  doc.body.appendChild(el);
}

export function removeHighlight(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.querySelector('[data-gf-highlight]')?.remove();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspectFrame.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/preview/inspectFrame.ts test/inspectFrame.test.ts
git commit -m "feat: add inspectFrame, the single narrow module allowed to read preview iframe DOM"
```

---

### Task 12: `ElementPatchPanel.tsx`

Created before `PreviewFrame.tsx`'s own changes (Task 13) deliberately — Task 13 renders this component internally, so it needs to already exist. Building leaf-first avoids Task 13 depending on code that doesn't exist yet.

**Files:**
- Create: `app/components/ElementPatchPanel.tsx`
- Test: `test/elementPatchPanel.test.tsx`

**Interfaces:**
- Consumes: `FrameElementInfo` (Task 11).
- Produces:
```typescript
interface ElementPatchPanelProps {
  patchEndpoint: string; // e.g. `/api/jobs/${jobId}/component/patch-element` or the asset-scoped equivalent
  selection: (FrameElementInfo & { documentHash: string | null }) | null;
  onPatched: () => void; // caller reloads the preview iframe (cache-busting its src)
}
```

Disables Apply (with an inline message) when `selection.dataGfId` is null — the "hand-edited content, unselectable" case from the spec. Shows structured error messages per the `PatchError` codes.

- [ ] **Step 1: Write the failing tests**

```typescript
it('renders nothing when selection is null', () => { /* ... */ });
it('shows the selected element tag/class', () => {
  render(<ElementPatchPanel patchEndpoint="/x" selection={{ tagName: 'button', classes: ['btn'], id: null, dataGfId: '1', rect: new DOMRect(), documentHash: 'h' }} onPatched={() => {}} />);
  expect(screen.getByText(/button/)).toBeInTheDocument();
});
it('disables Apply and shows a message when dataGfId is null', () => {
  render(<ElementPatchPanel patchEndpoint="/x" selection={{ tagName: 'div', classes: [], id: null, dataGfId: null, rect: new DOMRect(), documentHash: 'h' }} onPatched={() => {}} />);
  expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  expect(screen.getByText(/hand-edited/i)).toBeInTheDocument();
});
it('calls the patch endpoint with an AbortSignal and calls onPatched on success', async () => {
  // mock fetch, type into the instruction field, click Apply, assert fetch called with
  // { filename omitted here since it's baked into patchEndpoint }/{ dataGfId, documentHash, instruction }
  // and an AbortSignal, assert onPatched fires
});
it('shows a distinct message per structured error code', async () => {
  // mock fetch to return { success: false, error: 'ELEMENT_CHANGED' }, assert the shown
  // message differs from the one shown for e.g. 'SANITIZE_REJECTED'
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/elementPatchPanel.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement**

```typescript
'use client';

import { useRef, useState } from 'react';
import type { FrameElementInfo } from '@/lib/preview/inspectFrame';

interface ElementPatchPanelProps {
  patchEndpoint: string;
  selection: (FrameElementInfo & { documentHash: string | null }) | null;
  onPatched: () => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  COMPONENT_NOT_FOUND: 'This component no longer exists.',
  ELEMENT_NOT_FOUND: 'This element could not be found — it may have changed. Try re-selecting it.',
  ELEMENT_CHANGED: 'The component changed since you selected this element. Please re-select it.',
  SANITIZE_REJECTED: 'The AI\'s response could not be applied safely. Try rephrasing your instruction.',
  CONFLICT: 'Another edit is in progress. Please try again in a moment.',
  WRITE_FAILED: 'Could not save the change. Please try again.',
};

export function ElementPatchPanel({ patchEndpoint, selection, onPatched }: ElementPatchPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (!selection) return null;

  const unselectable = selection.dataGfId === null;

  async function handleApply() {
    if (!selection || unselectable || !instruction.trim()) return;
    setSubmitting(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const res = await fetch(patchEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataGfId: selection.dataGfId,
          documentHash: selection.documentHash,
          instruction,
        }),
        signal: abortRef.current.signal,
      });
      const body = await res.json();
      if (!body.success) {
        setError(ERROR_MESSAGES[body.error] ?? 'Something went wrong applying this patch.');
        return;
      }
      setInstruction('');
      onPatched();
    } catch (e: any) {
      if (e.name !== 'AbortError') setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="element-patch-panel">
      <div className="element-patch-panel-target">
        Selected: <code>{selection.tagName}</code>
        {selection.classes.length ? <code>.{selection.classes.join('.')}</code> : null}
      </div>
      {unselectable ? (
        <div className="element-patch-panel-disabled">
          Hand-edited content — use full regeneration to change this.
        </div>
      ) : (
        <>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Describe the change..."
            disabled={submitting}
          />
          {error ? <div className="element-patch-panel-error">{error}</div> : null}
          <div className="element-patch-panel-actions">
            <button type="button" onClick={handleApply} disabled={submitting || !instruction.trim()}>
              {submitting ? 'Applying…' : 'Apply'}
            </button>
            {submitting ? (
              <button type="button" onClick={handleCancel}>Cancel</button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/elementPatchPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/components/ElementPatchPanel.tsx test/elementPatchPanel.test.tsx
git commit -m "feat: add ElementPatchPanel for the click-to-select instruction/apply UI"
```

---

### Task 13: `PreviewFrame.tsx` — closed-union sandbox, `kind` prop, select-mode toggle, owns the patch panel

**Files:**
- Modify: `app/components/PreviewFrame.tsx`
- Test: existing `PreviewFrame` test file if one exists (check `test/` — if none, create `test/previewFrame.test.tsx` following whatever React-component-testing convention this codebase already uses elsewhere, e.g. for `JobCard`/`AssetCard`)

**Interfaces:**
- Consumes: `inspectFrame.ts` (Task 11), `ElementPatchPanel` (Task 12).
- Produces: `PreviewFrameProps` gains `kind?: 'component'` and `patchEndpoint?: string`. `PreviewFrame` renders `ElementPatchPanel` itself when a selection exists — it's the only component that knows the current selection state, iframe ref, and reload mechanics, so owning the panel's render (while the panel's own file still owns its own form/error UI) keeps every call site simple: pass `kind="component"` and `patchEndpoint`, nothing more. `patchEndpoint` is optional so select-mode highlighting can be used without an Apply UI (e.g. a future read-only context) — omitting it just means the panel never renders even if a selection exists.

**Security-critical test in this task:** the rendered `sandbox` attribute must be asserted directly against the DOM output, not against source text — a source-level grep for `allow-scripts` would pass even if a future change built the sandbox string some other way.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/previewFrame.test.tsx (adjust import/render helpers to match this codebase's existing
// React Testing Library or equivalent setup — check package.json devDependencies for what's
// actually installed before assuming a specific library).

it('renders sandbox="" for non-component previews', () => {
  render(<PreviewFrame title="t" width={100} height={100} src="/api/themes/x" />);
  const iframe = screen.getByTitle('t') as HTMLIFrameElement;
  expect(iframe.getAttribute('sandbox')).toBe('');
});

it('renders sandbox="allow-same-origin" for component previews', () => {
  render(<PreviewFrame title="t" width={100} height={100} src="/api/components/x" kind="component" />);
  const iframe = screen.getByTitle('t') as HTMLIFrameElement;
  expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
});

it('never renders a sandbox value containing allow-scripts', () => {
  render(<PreviewFrame title="t" width={100} height={100} src="/api/components/x" kind="component" />);
  const iframe = screen.getByTitle('t') as HTMLIFrameElement;
  expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
});

it('shows the select-mode toggle only when fullscreen and kind is component', () => {
  // ... render, simulate fullscreen (document.fullscreenElement mock), assert toggle button presence
  // ... render a non-component kind fullscreen, assert toggle is absent
});

it('renders ElementPatchPanel once an element is selected, with the given patchEndpoint', () => {
  // ... enter select mode, simulate a click inside the iframe resolving to an element,
  // assert an ElementPatchPanel-shaped UI (e.g. its Apply button) is now present
});

it('does not render a panel when patchEndpoint is omitted, even with a selection', () => {
  // ... same selection simulation, no patchEndpoint prop, assert no Apply button appears
});
```

Also add (in `test/previewFrame.test.tsx` or a separate app-wide test, whichever this codebase's convention favors for cross-component invariants):

```typescript
it('is the only component in the app rendering an iframe sandbox attribute', () => {
  // Grep app/ for "sandbox=" outside PreviewFrame.tsx — implement as an actual grep-based test
  // (fs.readdirSync + regex over app/**/*.tsx, excluding PreviewFrame.tsx itself) rather than a
  // hardcoded file list, so a future new iframe usage can't silently bypass this module.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/previewFrame.test.tsx`
Expected: FAIL — `kind`/`patchEndpoint` props don't exist yet, sandbox is hardcoded to `""`.

- [ ] **Step 3: Implement**

In `app/components/PreviewFrame.tsx`:

```typescript
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getElementAt,
  getRevisionHash,
  preventFrameAnchorNavigation,
  injectHighlight,
  removeHighlight,
  type FrameElementInfo,
} from '@/lib/preview/inspectFrame';
import { ElementPatchPanel } from '@/app/components/ElementPatchPanel';

interface PreviewFrameProps {
  title: string;
  width: number | string;
  height: number;
  scale?: number;
  srcDoc?: string;
  src?: string;
  border?: boolean;
  /** Component previews only: enables the sandbox relaxation and select-mode toggle. */
  kind?: 'component';
  /** Enables the Apply UI once an element is selected. Omit for highlight-only select mode. */
  patchEndpoint?: string;
}

const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];

// The sandbox attribute is a closed union resolved here, never a free-form string a call site
// assembles — allow-scripts must NEVER be added to either branch. See the design spec's
// security reasoning: sandbox="allow-same-origin" is safe ONLY without allow-scripts, and the
// route's CSP (COMPONENT_PREVIEW_CSP) is a required invariant of this relaxation.
function resolveSandbox(kind: PreviewFrameProps['kind']): '' | 'allow-same-origin' {
  return kind === 'component' ? 'allow-same-origin' : '';
}

export function PreviewFrame({ title, width, height, scale, srcDoc, src, border, kind, patchEndpoint }: PreviewFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<(FrameElementInfo & { documentHash: string | null }) | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    function handleFullscreenChange() {
      const active = document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(active);
      if (!active) {
        setBreakpoint('desktop');
        setSelectMode(false);
        setSelection(null);
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const attachFrameGuards = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame || kind !== 'component') return;
    return preventFrameAnchorNavigation(frame);
  }, [kind]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !selectMode) return;
    let cleanupAnchor = attachFrameGuards();
    function handleLoad() {
      cleanupAnchor?.();
      cleanupAnchor = attachFrameGuards();
    }
    frame.addEventListener('load', handleLoad);
    function handleMouseMove(e: MouseEvent) {
      const info = getElementAt(frame!, e.clientX, e.clientY);
      if (info) injectHighlight(frame!, info.rect);
      else removeHighlight(frame!);
    }
    function handleClick(e: MouseEvent) {
      const info = getElementAt(frame!, e.clientX, e.clientY);
      const documentHash = getRevisionHash(frame!);
      setSelection(info ? { ...info, documentHash } : null);
    }
    frame.contentWindow?.addEventListener('mousemove', handleMouseMove);
    frame.contentWindow?.addEventListener('click', handleClick);
    return () => {
      cleanupAnchor?.();
      frame.removeEventListener('load', handleLoad);
      frame.contentWindow?.removeEventListener('mousemove', handleMouseMove);
      frame.contentWindow?.removeEventListener('click', handleClick);
      removeHighlight(frame);
    };
  }, [selectMode, attachFrameGuards]);

  function handleFullscreenClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    wrapperRef.current?.requestFullscreen();
  }

  function handleBreakpointClick(e: React.MouseEvent, bp: Breakpoint) {
    e.preventDefault();
    e.stopPropagation();
    setBreakpoint(bp);
  }

  function handleSelectModeToggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSelectMode((v) => !v);
    setSelection(null);
  }

  function handlePatched() {
    setSelection(null);
    setReloadKey((k) => k + 1);
  }

  const wrapperSizeStyle =
    scale && typeof width === 'number' ? { width: width * scale, height: height * scale } : undefined;

  // Cache-busts the iframe after a successful patch, same query-param pattern
  // edit-component/page.tsx and edit/page.tsx already use (their own `previewVersion` state) —
  // this component's reload is scoped to component-kind patches specifically, so it appends its
  // own key rather than depending on a parent-supplied version.
  const effectiveSrc = kind === 'component' && src ? `${src}&patchV=${reloadKey}` : src;

  return (
    <div
      ref={wrapperRef}
      className="preview-frame-wrapper"
      data-breakpoint={breakpoint}
      style={{
        ...wrapperSizeStyle,
        ...(border ? { border: '1px solid var(--border)', borderRadius: 'var(--radius)' } : undefined),
      }}
    >
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        src={effectiveSrc}
        title={title}
        sandbox={resolveSandbox(kind)}
        style={{
          width,
          height,
          border: 'none',
          display: 'block',
          transform: scale ? `scale(${scale})` : undefined,
          transformOrigin: scale ? 'top left' : undefined,
        }}
      />
      {isFullscreen ? (
        <div className="preview-frame-breakpoint-toolbar">
          {BREAKPOINTS.map((bp) => (
            <button
              key={bp}
              type="button"
              className="preview-frame-breakpoint-btn"
              data-active={breakpoint === bp ? 'true' : 'false'}
              onClick={(e) => handleBreakpointClick(e, bp)}
            >
              {bp[0].toUpperCase() + bp.slice(1)}
            </button>
          ))}
          {kind === 'component' ? (
            <button
              type="button"
              className="preview-frame-breakpoint-btn"
              data-active={selectMode ? 'true' : 'false'}
              onClick={handleSelectModeToggle}
            >
              Select
            </button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="preview-frame-fullscreen-btn"
          title="View fullscreen"
          aria-label="View fullscreen"
          onClick={handleFullscreenClick}
        >
          ⛶
        </button>
      )}
      {kind === 'component' && patchEndpoint && selection ? (
        <ElementPatchPanel patchEndpoint={patchEndpoint} selection={selection} onPatched={handlePatched} />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/previewFrame.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/components/PreviewFrame.tsx test/previewFrame.test.tsx
git commit -m "feat: sandbox=allow-same-origin, select-mode toggle, and patch panel wiring in PreviewFrame"
```

---

### Task 14: Wire `PreviewFrame` into the 4 component-preview call sites

**Files:**
- Modify: `app/dashboard/jobs/[id]/edit-component/page.tsx`
- Modify: `app/dashboard/assets/[id]/page.tsx`
- Modify: `app/components/JobCard.tsx`
- Modify: `app/components/AssetCard.tsx`
- Test: existing test files for these 4, if any (check first) — add integration-level assertions that `kind="component"` is passed.

**Interfaces:**
- Consumes: `PreviewFrame`'s `kind`/`patchEndpoint` props (Task 13).

Every call site needs only two new props — `kind="component"` and `patchEndpoint` — since `PreviewFrame` (Task 13) already owns the selection state, highlight overlay, and patch panel internally. `JobCard.tsx`/`AssetCard.tsx` render thumbnails, not fullscreen views by default, but select mode is fullscreen-only (already gated on `isFullscreen` inside `PreviewFrame`) and each card's `PreviewFrame` instance owns its own fullscreen state, so a user who fullscreens FROM a card thumbnail still gets the full select-mode + patch-panel experience with no extra wiring needed at these two call sites either.

- [ ] **Step 1: Write the failing tests**

For whichever of the 4 files already have test coverage, add an assertion that the rendered `PreviewFrame` receives `kind="component"` and the expected `patchEndpoint` value (adjust to this codebase's existing shallow-render/prop-assertion convention for these files — check an existing test for one of them first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL (or: no assertion yet if no test file exists for a given call site — in that case skip to Step 3 for that file, there is no red state to observe).

- [ ] **Step 3: Wire the 4 call sites**

In `app/dashboard/jobs/[id]/edit-component/page.tsx`, change:

```typescript
        <PreviewFrame
          src={`/api/components/${job.result_path}?styleId=${job.style_id}&v=${previewVersion}`}
          title={`Component preview: ${job.prompt}`}
          width={480}
          height={340}
          border
        />
```

to:

```typescript
        <PreviewFrame
          src={`/api/components/${job.result_path}?styleId=${job.style_id}&v=${previewVersion}`}
          title={`Component preview: ${job.prompt}`}
          width={480}
          height={340}
          border
          kind="component"
          patchEndpoint={`/api/jobs/${job.id}/component/patch-element`}
        />
```

In `app/dashboard/assets/[id]/page.tsx`, the component-preview branch:

```typescript
            <PreviewFrame
              src={`/api/components/${asset.image_path}?styleId=${asset.style_id}`}
              title={`Component preview: ${asset.prompt}`}
              width={480}
              height={320}
              border
              kind="component"
              patchEndpoint={`/api/assets/${asset.id}/component/patch-element`}
            />
```

In `app/components/JobCard.tsx`, the component branch:

```typescript
          <PreviewFrame
            src={`/api/components/${job.result_path}?styleId=${job.style_id}`}
            title={`Component preview: ${job.prompt}`}
            width={260}
            height={180}
            scale={0.28}
            kind="component"
            patchEndpoint={`/api/jobs/${job.id}/component/patch-element`}
          />
```

In `app/components/AssetCard.tsx`, the component branch:

```typescript
          <PreviewFrame
            src={`/api/components/${asset.image_path}?styleId=${asset.style_id}`}
            title={`Component preview: ${asset.prompt}`}
            width={320}
            height={320}
            scale={0.5}
            kind="component"
            patchEndpoint={`/api/assets/${asset.id}/component/patch-element`}
          />
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. Fix any test that asserted the OLD `PreviewFrame` prop shape (`onElementSelected`) rather than the revised one.

- [ ] **Step 5: Run lint and typecheck**

Run: `npx eslint app lib worker.ts && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/components/PreviewFrame.tsx app/dashboard/jobs/[id]/edit-component/page.tsx app/dashboard/assets/[id]/page.tsx app/components/JobCard.tsx app/components/AssetCard.tsx test/
git commit -m "feat: wire click-to-select patching into all 4 component-preview call sites"
```

---

### Task 15: CSS for the select-mode toggle and patch panel

**Files:**
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: nothing new — pure styling for classes already referenced in Tasks 12-13 (`.element-patch-panel`, `.element-patch-panel-target`, `.element-patch-panel-disabled`, `.element-patch-panel-error`, `.element-patch-panel-actions`).

- [ ] **Step 1: Add styles**

Append to `app/globals.css`, after the existing `.preview-frame-breakpoint-btn[data-active='true']` block:

```css
.element-patch-panel {
  position: absolute;
  bottom: 4px;
  left: 4px;
  right: 4px;
  z-index: 2;
  background: rgba(10, 10, 10, 0.9);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.element-patch-panel-target {
  font-size: 11px;
  color: var(--ink);
}

.element-patch-panel textarea {
  width: 100%;
  min-height: 48px;
  font-size: 12px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--ink);
  resize: vertical;
}

.element-patch-panel-disabled {
  font-size: 12px;
  color: var(--ink);
  opacity: 0.7;
}

.element-patch-panel-error {
  font-size: 11px;
  color: #ff6b6b;
}

.element-patch-panel-actions {
  display: flex;
  gap: 6px;
}

.element-patch-panel-actions button {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 11px;
  cursor: pointer;
}

.element-patch-panel-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 2: Verify visually**

Run the dev server (`npm run dev`), open a component preview, enter fullscreen, toggle select mode, hover/click an element, confirm the panel renders legibly and the highlight overlay tracks the hovered element without visually breaking under the breakpoint toolbar's mobile/tablet width constraints.

- [ ] **Step 3: Commit**

```bash
git add app/globals.css
git commit -m "feat: style the click-to-select panel and highlight overlay"
```

---

### Task 16: Full-suite verification and manual browser test

**Files:** none (verification-only task).

- [ ] **Step 1: Run the complete verification suite**

```bash
npm run lint
npx tsc --noEmit
npx vitest run
```

Expected: all three clean, matching CI's three required gates exactly.

- [ ] **Step 2: Manual browser verification (this feature cannot be fully trusted from tests alone — it's real DOM/iframe interaction)**

Using Playwright MCP or a real browser:
1. Open a completed component job's edit page, enter fullscreen, toggle Select mode.
2. Hover over different elements — confirm the highlight overlay tracks the correct element and doesn't block clicks to it.
3. Click an element, type an instruction (e.g. "make this blue"), click Apply — confirm the preview reloads showing the change.
4. Apply a second patch to the SAME element (e.g. "make it bold too") — confirm the FIRST change (blue) is still present alongside the new one (bold), not lost.
5. Export the component (via whatever the existing export/share flow is) and confirm the patched styling survives in the exported output, while no `data-gf-id` attribute appears anywhere in it.
6. Try select mode on a hand-edited (`edited_externally`) asset if one exists in test data — confirm elements show as unselectable rather than allowing a wasted Apply attempt.
7. Open browser devtools, confirm no console errors from the highlight overlay injection or anchor-click prevention.

- [ ] **Step 3: Report any manual-test findings**

If any of the above surfaces a real bug, fix it as its own properly-scoped follow-up commit within this same plan (do not silently patch around it) — this task's job is to catch what the automated suite structurally can't.
