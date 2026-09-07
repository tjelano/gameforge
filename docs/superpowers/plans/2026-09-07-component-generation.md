# Full Component-Level Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user generate a real HTML+CSS website component (button, card, nav bar, ...) styled to a Style Bible, review/edit/promote it through the existing jobs pipeline, exactly like themes and images already work.

**Architecture:** A third `output_kind` value (`'component'`) flows through the entire existing jobs/assets pipeline. Part A hardens three shared dispatch points that currently assume exactly two output kinds via binary ternaries rather than exhaustive switches (`worker.ts`, `storageDirFor`, `cleanupOrphanedIn`) — this must land before anything in Part B, since the generator/routes/UI all assume these already handle `'component'` correctly. Part B adds the actual feature: a sanitization module (the real security boundary, since arbitrary HTML/CSS has no narrow regex allowlist to validate against the way theme tokens do), a `ComponentGenerator` mirroring `ThemeGenerator`'s existing shape, two new API route pairs, and UI wiring that deliberately re-applies every fix this session's own review chain found for the theme editor, rather than rediscovering them.

**Tech Stack:** Next.js API routes (existing pattern), Vitest (existing pattern: temp SQLite via `setProjectRootForTests`, real temp files), `sanitize-html` (new dependency — a deliberate, justified exception to this codebase's "no utility libraries" rule, since hand-rolled HTML sanitization is exactly the kind of thing that reliably goes wrong; the same reasoning that already accepts `zod` as a dependency).

**Spec:** `docs/superpowers/specs/2026-09-07-component-generation-design.md`

## Global Constraints

- Output format is plain HTML + CSS only — never React/JSX.
- Generated CSS references the Style Bible's theme variables (`var(--color-accent)`, etc.) — never bakes in concrete values.
- No multi-candidate generation or dedup-steering for components (item 4's OKLab math is color-specific, doesn't generalize).
- CSS sanitization uses real parsing (`postcss`): rejects any at-rule outright, and allows CSS functions only via an explicit safe allowlist (`postcss-value-parser`), not a `url(` blocklist — plus raw-string checks for `</style`, `<body`, `</body`.
- Sanitization runs on both generation and every edit-save — never generation-only.
- Editing is only available for a component job in `complete` status — not yet promoted, not yet discarded (matches item 5's theme-editor scope boundary).
- `GET /api/components/[filename]` sets a `Content-Security-Policy: default-src 'none'` response header — the stored file itself never has this baked in, since it's meant to be copied into the user's own real website.
- Part A's three hardening tasks (Tasks 1-3) must land before any Part B task that depends on them (Tasks 4+).

---

## Context for the implementer

**The exact current binary dispatch points Part A hardens** (read directly, current as of this planning session):

`worker.ts:76-80`:
```typescript
const result = job.output_kind === 'theme'
  ? await getThemeGenerator().generate(job.prompt, job.style_id)
  : sheetOptions
    ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
    : await getImageGenerator().generate(job.prompt, job.style_id);
```

`lib/services/shared/assetSafety.ts:19-21`:
```typescript
export function storageDirFor(outputKind: 'image' | 'theme'): string {
  return outputKind === 'theme' ? 'themes' : 'images';
}
```
Used by `deleteFileIfSafe`/`deleteFileIfSafeSync` in the same file, and by `GitService.ts:139` (`stageFilesForCommit()`).

`lib/services/AssetService.ts:114,164,169` (the exact current signatures):
```typescript
private async cleanupOrphanedIn(subdir: 'images' | 'themes'): Promise<number> { /* ... */ }
async cleanupOrphanedImages(): Promise<number> { return this.cleanupOrphanedIn('images'); }
async cleanupOrphanedThemes(): Promise<number> { return this.cleanupOrphanedIn('themes'); }
```

`lib/services/GitService.ts` has TWO call sites calling both cleanup wrappers as a pair (`pull()` at lines 181-185, `push()` at lines 218-222), plus `ensureDirectoriesExist()` at lines 29-35 which only creates `storage/images` and `storage/themes`.

**The exact pattern to mirror for the new generator** (`lib/services/ClaudeApiThemeGenerator.ts`, read directly — this is the complete template): a class taking `(apiKey: string, provider: ClaudeApiProvider)` in its constructor, a `generate()` method that builds a prompt, does a direct `fetch()` to `provider.requestUrl` with `tool_choice: {type:'tool', name:'emit_theme'}` forcing a single tool call, checks `res.ok`/`data.stop_reason === 'max_tokens'`, finds the `tool_use` block, validates its `input` via a Zod schema, writes the result to a file under `storage/<kind>/`, returns `{path: filename, prompt}`. `lib/services/claudeApiProviders.ts`'s `ClaudeApiProvider` interface (`{name, requestUrl, model, buildAuthHeaders(apiKey)}`) and its two exported profiles (`ANTHROPIC_PROVIDER`, `CHEAPERINFERENCE_PROVIDER`) are already fully generic across generator types — reuse them directly, no changes needed.

**The exact, already-hardened pattern to mirror for the edit/reset routes** (`app/api/jobs/[id]/theme/route.ts` and `app/api/jobs/[id]/theme/reset/route.ts`, read directly — both went through a real review cycle this session that found and fixed 6 bugs across the pair; this plan requires applying every one from the start): job-not-found → 404; `status !== 'complete'` → 409 (on BOTH routes); `output_kind !== 'theme'` → 400 (on BOTH routes — the component version checks `!== 'component'`); path-traversal guard on `result_path`; `options.originalTokens === undefined` gates a one-time capture-then-`UPDATE` (options AND `updated_at` together); every subsequent edit does its own separate `UPDATE jobs SET updated_at = ?` so an actively-edited job never silently ages out of `JobService.getActive()`'s 5-minute window; every fs operation wrapped in its own try/catch with `console.error` logging before returning a response.

**The exact, already-hardened pattern to mirror for the edit page** (`app/dashboard/jobs/[id]/edit/page.tsx`, read directly): a load effect with an `ignore` flag re-checked after EVERY async step (not just the first — this session's own pre-push-review caught a bug where only the first step was guarded), errors rendered via `error && !tokens` BEFORE the `!job || !tokens` loading fallback (not after — an earlier version of this exact page made this mistake), a `debounceRef` cleared both when arming a new timer AND at the top of the reset handler, and a `previewVersion` counter bumped on every successful PATCH/reset response, appended as a `?v=${previewVersion}` query param to the preview URL to force the iframe to actually reload (a bare `srcDoc`/`src` string that never changes across edits will not visually update otherwise).

**`sanitize-html`'s real, verified API** (confirmed via research during planning, not guessed): default export function, `import sanitizeHtml from 'sanitize-html';`, signature `sanitizeHtml(dirty: string, options?: {allowedTags?: string[], allowedAttributes?: Record<string, string[]>, disallowedTagsMode?: string}): string`. The package itself ships no TypeScript types — `@types/sanitize-html` is a separate, required dev dependency.

**Existing `Job`/`Asset` schema fields relevant here** (`lib/database/schema.ts`, current): `JobSchema`/`AssetSchema` both already have an `output_kind: OutputKindSchema.default('image')` field; `OutputKindSchema = z.enum(['image', 'theme'])` is what Task 1 extends. `options: z.string()` on `JobSchema` is the existing free-form JSON blob column, already used by item 5's `originalTokens` key — this plan adds a sibling key, `originalComponent`, never both on the same job.

---

### Task 1: Extend `OutputKindSchema` to include `'component'`

**Files:**
- Modify: `lib/database/schema.ts`
- Modify: `app/api/generate/route.ts`
- Test: `test/outputKindWiring.test.ts` (this file already exists from an earlier feature — read it first, add new test cases to it rather than creating a duplicate file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `OutputKindSchema` now accepting `'component'` — every later task in this plan relies on this.

- [ ] **Step 1: Read the existing test file to match its established pattern**

Read `test/outputKindWiring.test.ts` in full before writing new cases — match its existing style exactly (it already has cases for `'image'`/`'theme'`).

- [ ] **Step 2: Write the failing tests**

Add to `test/outputKindWiring.test.ts`:
```typescript
it('OutputKindSchema accepts "component"', () => {
  expect(OutputKindSchema.parse('component')).toBe('component');
});

it('rejects an unrecognized output_kind value', () => {
  expect(() => OutputKindSchema.parse('bogus')).toThrow();
});
```
(Add the necessary import for `OutputKindSchema` from `@/lib/database/schema` at the top of the file if not already present — check first.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- outputKindWiring.test.ts`
Expected: FAIL — `'component'` not in the current enum

- [ ] **Step 4: Update the schema**

In `lib/database/schema.ts`, find:
```typescript
export const OutputKindSchema = z.enum(['image', 'theme']);
```
Replace with:
```typescript
export const OutputKindSchema = z.enum(['image', 'theme', 'component']);
```

- [ ] **Step 5: Extend the generate route's schema**

In `app/api/generate/route.ts`, find the `GenerateSchema`'s `outputKind` field:
```typescript
  outputKind: z.enum(['image', 'theme']).optional(),
```
Replace with:
```typescript
  outputKind: z.enum(['image', 'theme', 'component']).optional(),
```
(If the exact current line differs from this — e.g. it already imports `OutputKindSchema` directly instead of a separate literal enum — use whichever the file actually does; the requirement is just that `'component'` becomes a valid `outputKind` value in this route's own validation, whatever the current mechanism looks like.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- outputKindWiring.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS (all prior tests, no regressions)

- [ ] **Step 8: Commit**

```bash
git add lib/database/schema.ts app/api/generate/route.ts test/outputKindWiring.test.ts
git commit -m "feat: add 'component' as a third output_kind"
```

---

### Task 2: Make `storageDirFor` an exhaustive, safe 3-way mapping

**Files:**
- Modify: `lib/services/shared/assetSafety.ts`
- Test: `test/assetSafetyOutputKind.test.ts` (this file already exists — read it first, add cases to it)

**Interfaces:**
- Consumes: Task 1's widened `OutputKindSchema` conceptually (the type union below matches it), though this task can be written as a standalone literal type union without importing the schema.
- Produces: `storageDirFor(outputKind: 'image' | 'theme' | 'component'): string` returning `'images' | 'themes' | 'components'` — Task 9 (JobCard/AssetCard) and the existing `deleteFileIfSafe`/`GitService.stageFilesForCommit()` all rely on this being correct for `'component'`.

- [ ] **Step 1: Read the existing test file to match its established pattern**

Read `test/assetSafetyOutputKind.test.ts` in full first.

- [ ] **Step 2: Write the failing tests**

Add to `test/assetSafetyOutputKind.test.ts`:
```typescript
it('storageDirFor resolves "component" to "components"', () => {
  expect(storageDirFor('component')).toBe('components');
});

it('storageDirFor still resolves "image" and "theme" correctly', () => {
  expect(storageDirFor('image')).toBe('images');
  expect(storageDirFor('theme')).toBe('themes');
});
```
(Match the existing import style for `storageDirFor` already in that file.)

- [ ] **Step 3: Run tests to verify the new case fails**

Run: `npm test -- assetSafetyOutputKind.test.ts`
Expected: the "component" case FAILS (returns `'images'`, the current else-fallback's wrong answer); the image/theme case already passes

- [ ] **Step 4: Fix the implementation**

In `lib/services/shared/assetSafety.ts`, replace:
```typescript
export function storageDirFor(outputKind: 'image' | 'theme'): string {
  return outputKind === 'theme' ? 'themes' : 'images';
}
```
With an exhaustive mapping that can't silently absorb an unrecognized value:
```typescript
export function storageDirFor(outputKind: 'image' | 'theme' | 'component'): string {
  switch (outputKind) {
    case 'image':
      return 'images';
    case 'theme':
      return 'themes';
    case 'component':
      return 'components';
  }
}
```
(TypeScript's exhaustiveness checking on a `switch` over a literal union means adding a future fourth `output_kind` value without updating this function becomes a compile error, not a silent wrong answer — this is the actual fix for the class of bug found during brainstorming, not just adding one more case to the same style of code that already got it wrong once.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- assetSafetyOutputKind.test.ts`
Expected: PASS (both cases)

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — this function is called by `deleteFileIfSafe`/`deleteFileIfSafeSync` (used when discarding/deleting jobs) and `GitService.ts`'s `stageFilesForCommit()`; confirm none of those existing tests broke.

- [ ] **Step 7: Commit**

```bash
git add lib/services/shared/assetSafety.ts test/assetSafetyOutputKind.test.ts
git commit -m "fix: make storageDirFor an exhaustive switch, not an else-fallback"
```

---

### Task 3: Add `cleanupOrphanedComponents()` and wire it into `GitService`

**Files:**
- Modify: `lib/services/AssetService.ts`
- Modify: `lib/services/GitService.ts`
- Test: `test/cleanupOrphanedThemes.test.ts` (this file already exists and tests the shared `cleanupOrphanedIn` logic via its theme-specific wrapper — read it first, add a components-specific describe block to it rather than creating a new file, since the underlying logic under test is the same shared private method)

**Interfaces:**
- Consumes: Task 2's `storageDirFor` conceptually (same directory-naming convention, `'components'`), though this task's own code doesn't call `storageDirFor` directly — `cleanupOrphanedIn`'s `subdir` parameter is passed the literal string `'components'` directly, matching how `'images'`/`'themes'` are already passed as literals today.
- Produces: `assetService.cleanupOrphanedComponents(): Promise<number>` — Task 9's discard flow and `GitService`'s two sync paths rely on this existing.

- [ ] **Step 1: Read the existing test file to match its established pattern**

Read `test/cleanupOrphanedThemes.test.ts` in full — it already sets up a temp `storage/themes/` directory with a mix of referenced and orphaned files and asserts only the orphaned ones get removed. Mirror this exact setup for a `storage/components/` case.

- [ ] **Step 2: Write the failing test**

Add a new `describe('cleanupOrphanedComponents', ...)` block to `test/cleanupOrphanedThemes.test.ts` (or extract shared setup into a helper if the existing file's structure makes that cleaner — match whatever the file already does), following the exact same shape as the existing theme case but writing files into `storage/components/` and calling `assetService.cleanupOrphanedComponents()`:
```typescript
describe('cleanupOrphanedComponents', () => {
  it('removes an orphaned component file but keeps one referenced by an active job', async () => {
    const componentsDir = path.join(tempRoot, 'storage', 'components');
    await fsPromises.mkdir(componentsDir, { recursive: true });
    await fsPromises.writeFile(path.join(componentsDir, 'orphan.html'), '<html></html>');
    await fsPromises.writeFile(path.join(componentsDir, 'kept.html'), '<html></html>');

    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'component', prompt: 'x', outputKind: 'component' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`UPDATE jobs SET status = 'complete', result_path = 'kept.html' WHERE style_id = ?`).run(style.id);

    const removed = await assetService.cleanupOrphanedComponents();

    expect(removed).toBe(1);
    await expect(fsPromises.access(path.join(componentsDir, 'orphan.html'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(componentsDir, 'kept.html'))).resolves.toBeUndefined();
  });
});
```
(Adjust imports/setup to match whatever `tempRoot`/`styleService`/`jobService`/`DatabaseConnection` setup the existing file already has in its `beforeEach` — don't duplicate a second temp-dir setup if one already exists in scope.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- cleanupOrphanedThemes.test.ts`
Expected: FAIL — `assetService.cleanupOrphanedComponents is not a function`

- [ ] **Step 4: Add the wrapper method**

In `lib/services/AssetService.ts`, widen the shared private method's type and add the new public wrapper, right after the existing `cleanupOrphanedThemes()`:
```typescript
  private async cleanupOrphanedIn(subdir: 'images' | 'themes' | 'components'): Promise<number> {
```
(Only the type signature changes — the method body already works generically off the `subdir` string parameter, no other changes needed inside it.)
```typescript
  /** Removes physical files in storage/components/ that are no longer needed. See cleanupOrphanedIn(). */
  async cleanupOrphanedComponents(): Promise<number> {
    return this.cleanupOrphanedIn('components');
  }
```

- [ ] **Step 5: Wire it into `GitService`'s two sync paths and directory setup**

In `lib/services/GitService.ts`, update `ensureDirectoriesExist()`:
```typescript
  private async ensureDirectoriesExist(): Promise<void> {
    for (const dir of DATA_DIRS) {
      await fsPromises.mkdir(path.join(getProjectRoot(), dir), { recursive: true });
    }
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'images'), { recursive: true });
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'themes'), { recursive: true });
    await fsPromises.mkdir(path.join(getProjectRoot(), 'storage', 'components'), { recursive: true });
  }
```
In `pull()` (around line 181-185), replace:
```typescript
      const removedImages = await assetService.cleanupOrphanedImages();
      const removedThemes = await assetService.cleanupOrphanedThemes();
      if (removedImages > 0 || removedThemes > 0) {
        console.log(`🧹 Removed ${removedImages} orphaned images and ${removedThemes} orphaned themes.`);
      }
```
With:
```typescript
      const removedImages = await assetService.cleanupOrphanedImages();
      const removedThemes = await assetService.cleanupOrphanedThemes();
      const removedComponents = await assetService.cleanupOrphanedComponents();
      if (removedImages > 0 || removedThemes > 0 || removedComponents > 0) {
        console.log(`🧹 Removed ${removedImages} orphaned images, ${removedThemes} orphaned themes, and ${removedComponents} orphaned components.`);
      }
```
Apply the identical change to `push()`'s copy of this same block (around line 218-222).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- cleanupOrphanedThemes.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — confirm the existing `GitService` push/pull tests (which assert on the exact console.log wording in some cases — check `test/gitServiceThemes.test.ts` and `test/push.test.ts`) still pass with the updated log message.

- [ ] **Step 8: Commit**

```bash
git add lib/services/AssetService.ts lib/services/GitService.ts test/cleanupOrphanedThemes.test.ts
git commit -m "feat: add cleanupOrphanedComponents and wire it into git sync"
```

---

### Task 4: Component sanitization module

**Files:**
- Create: `lib/services/componentSanitize.ts`
- Test: `test/componentSanitize.test.ts`

**Interfaces:**
- Consumes: the `sanitize-html` npm package (new dependency, installed in Step 1 below).
- Produces: `sanitizeComponentHtml(html: string): string` and `sanitizeComponentCss(css: string): string` (throws on invalid input) — Task 5 (generator) and Task 8 (edit/reset routes) both call these.

- [ ] **Step 1: Install the new dependency**

```bash
npm install sanitize-html
npm install -D @types/sanitize-html
```
Confirm both installed successfully by checking `package.json` picked up both entries.

- [ ] **Step 2: Write the failing tests**

```typescript
// test/componentSanitize.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';

describe('sanitizeComponentHtml', () => {
  it('strips a <script> tag entirely', () => {
    const dirty = '<div>Hello<script>alert(1)</script></div>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');
  });

  it('strips an onclick attribute but keeps the element', () => {
    const dirty = '<button onclick="alert(1)">Click me</button>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('<button');
    expect(clean).toContain('Click me');
  });

  it('strips a javascript: href', () => {
    const dirty = '<a href="javascript:alert(1)">link</a>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('javascript:');
  });

  it('passes a realistic, legitimate component through with its structure intact', () => {
    const clean = '<button class="btn-primary">Buy now</button>';
    const result = sanitizeComponentHtml(clean);
    expect(result).toContain('<button');
    expect(result).toContain('class="btn-primary"');
    expect(result).toContain('Buy now');
  });
});

describe('sanitizeComponentCss', () => {
  it('rejects CSS containing url( in a background property', () => {
    expect(() => sanitizeComponentCss('.btn { background: url(https://evil.example/track.gif); }')).toThrow();
  });

  it('rejects CSS containing an @import with url(', () => {
    expect(() => sanitizeComponentCss("@import url('https://evil.example/style.css');")).toThrow();
  });

  it('rejects CSS with mixed-case URL(', () => {
    expect(() => sanitizeComponentCss('.btn { background: URL(https://evil.example/x.png); }')).toThrow();
  });

  it('passes through legitimate CSS with no url() references unchanged', () => {
    const css = '.btn { background: var(--color-accent); color: var(--color-bg); padding: calc(var(--space-unit) * 2); border-radius: var(--radius-base); }';
    expect(sanitizeComponentCss(css)).toBe(css);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- componentSanitize.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/componentSanitize'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/componentSanitize.ts
import sanitizeHtml from 'sanitize-html';

// A deliberately narrow allowlist for real website UI pieces (buttons,
// cards, nav bars, forms) — see docs/superpowers/specs/2026-09-07-
// component-generation-design.md's security note for why sanitization,
// not the sandboxed preview, is this feature's actual safety guarantee:
// the generated HTML+CSS is meant to be copied directly into the user's
// own real website, not just displayed inside GameForge.
const ALLOWED_TAGS = [
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'button', 'img',
  'nav', 'header', 'footer', 'section', 'article',
  'form', 'label', 'input', 'textarea', 'select', 'option',
  'strong', 'em', 'b', 'i', 'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'id'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt'],
  button: ['type', 'disabled'],
  input: ['type', 'name', 'placeholder', 'value', 'required'],
  textarea: ['name', 'placeholder', 'rows', 'cols'],
  select: ['name'],
  option: ['value'],
};

export function sanitizeComponentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    disallowedTagsMode: 'discard',
  });
}

export function sanitizeComponentCss(css: string): string {
  if (/url\(/i.test(css)) {
    throw new Error('Component CSS cannot reference external resources (url(...) is not supported).');
  }
  return css;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- componentSanitize.test.ts`
Expected: PASS (8 tests). If `sanitizeHtml`'s actual default behavior differs from what a test expects (e.g. it strips more/less than assumed), adjust the test to reflect the REAL observed output of the installed package version — don't weaken a security-relevant assertion (e.g. never relax the `<script>`/`onclick`/`javascript:` tests to pass by accepting unsafe output) to make it pass; only adjust incidental formatting expectations if needed.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/services/componentSanitize.ts test/componentSanitize.test.ts
git commit -m "feat: add HTML/CSS sanitization for generated components"
```

---

### Task 5: `ComponentGenerator` — serialization, real Claude API implementation, mock

**Files:**
- Create: `lib/services/ComponentGenerator.ts`
- Test: `test/componentGenerator.test.ts`

**Interfaces:**
- Consumes: `sanitizeComponentHtml`/`sanitizeComponentCss` (Task 4), `ClaudeApiProvider`/`ANTHROPIC_PROVIDER`/`CHEAPERINFERENCE_PROVIDER` (existing, `lib/services/claudeApiProviders.ts`).
- Produces: `ComponentTokens` type (`{html: string; css: string}`), `combineComponentHtml(tokens: ComponentTokens): string`, `parseComponentHtml(document: string): ComponentTokens`, `ComponentGenerator` interface, `ClaudeApiComponentGenerator` class, `MockComponentGenerator` class, `getComponentGenerator(): ComponentGenerator` — Task 6 (worker.ts) and Task 8 (edit/reset routes) all consume these.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/componentGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { combineComponentHtml, parseComponentHtml, MockComponentGenerator } from '@/lib/services/ComponentGenerator';

describe('combineComponentHtml / parseComponentHtml round-trip', () => {
  it('recovers the original html and css after combining and re-parsing', () => {
    const original = {
      html: '<button class="btn-primary">Buy now</button>',
      css: '.btn-primary { background: var(--color-accent); }',
    };
    const combined = combineComponentHtml(original);
    expect(combined).toContain('<!DOCTYPE html>');
    expect(combined).toContain('<style>');
    const parsed = parseComponentHtml(combined);
    expect(parsed.html).toBe(original.html);
    expect(parsed.css).toBe(original.css);
  });
});

describe('MockComponentGenerator', () => {
  it('writes a real file under storage/components/ and returns its filename', async () => {
    const generator = new MockComponentGenerator();
    const result = await generator.generate('a primary button', 'style-1');
    expect(result.path).toMatch(/\.html$/);
    expect(result.prompt).toBe('a primary button');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- componentGenerator.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/ComponentGenerator'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/ComponentGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { styleService } from '@/lib/services/StyleService';
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER } from '@/lib/services/claudeApiProviders';

export interface ComponentTokens {
  html: string;
  css: string;
}

export interface GeneratedComponent {
  path: string; // filename only, under storage/components/
  prompt: string;
}

export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string): Promise<GeneratedComponent>;
}

const STYLE_OPEN = '<style>';
const STYLE_CLOSE = '</style>';
const BODY_OPEN = '<body>';
const BODY_CLOSE = '</body>';

export function combineComponentHtml(tokens: ComponentTokens): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${STYLE_OPEN}
${tokens.css}
${STYLE_CLOSE}
</head>
${BODY_OPEN}
${tokens.html}
${BODY_CLOSE}
</html>
`;
}

export function parseComponentHtml(document: string): ComponentTokens {
  const styleStart = document.indexOf(STYLE_OPEN);
  const styleEnd = document.indexOf(STYLE_CLOSE);
  const bodyStart = document.indexOf(BODY_OPEN);
  const bodyEnd = document.indexOf(BODY_CLOSE);
  if (styleStart === -1 || styleEnd === -1 || bodyStart === -1 || bodyEnd === -1) {
    throw new Error('Component document is missing a <style> or <body> section.');
  }
  return {
    css: document.slice(styleStart + STYLE_OPEN.length, styleEnd).trim(),
    html: document.slice(bodyStart + BODY_OPEN.length, bodyEnd).trim(),
  };
}

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    html: { type: 'string', description: 'The component\'s HTML markup only (no <html>/<head>/<body> wrapper) — just the element(s) that make up this one component.' },
    css: { type: 'string', description: 'CSS rules styling the component, referencing the Style Bible\'s theme variables (var(--color-accent), var(--color-bg), var(--color-fg), var(--color-border), var(--font-heading), var(--font-body), var(--space-unit), var(--radius-base)) rather than hardcoded values. Never use url(...) — no external resource references are supported.' },
  },
  required: ['html', 'css'],
};

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60_000;

function buildComponentPrompt(styleParameters: string, jobPrompt: string, componentType?: string): string {
  const typeHint = componentType ? `Component type: ${componentType}.\n\n` : '';
  return `You are generating a single, reusable website UI component as plain HTML and CSS (no React, no JavaScript). ${typeHint}Style Bible parameters (JSON): ${styleParameters}

Description: ${jobPrompt}

Respond by calling the emit_component tool with the component's html and css.`;
}

/** Real Claude Messages API implementation — mirrors ClaudeApiThemeGenerator's exact pattern (direct fetch, forced tool_choice, no SDK dependency). */
export class ClaudeApiComponentGenerator implements ComponentGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string, componentType?: string): Promise<GeneratedComponent> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildComponentPrompt(style?.parameters ?? '{}', prompt, componentType);

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
        messages: [{ role: 'user', content: fullPrompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic component generation failed via ${this.provider.name} (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    if (data.stop_reason === 'max_tokens') {
      throw new Error(`Anthropic response (via ${this.provider.name}) was truncated (stop_reason: max_tokens) before completing the tool call — the component could not be generated.`);
    }
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error(`Anthropic response (via ${this.provider.name}) contained no tool_use block for emit_component.`);
    }

    const raw = toolUse.input as ComponentTokens;
    const tokens: ComponentTokens = {
      html: sanitizeComponentHtml(raw.html),
      css: sanitizeComponentCss(raw.css),
    };

    const filename = `component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`;
    const componentsDir = path.join(getProjectRoot(), 'storage', 'components');
    try {
      await fsPromises.mkdir(componentsDir, { recursive: true });
      await fsPromises.writeFile(path.join(componentsDir, filename), combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write component file ${filename}:`, e);
      throw e;
    }

    return { path: filename, prompt };
  }
}

export class MockComponentGenerator implements ComponentGenerator {
  async generate(prompt: string, _styleId: string): Promise<GeneratedComponent> {
    const tokens: ComponentTokens = {
      html: '<button class="btn-primary">Buy now</button>',
      css: '.btn-primary { background: var(--color-accent); color: var(--color-bg); padding: calc(var(--space-unit) * 1.5) calc(var(--space-unit) * 3); border: none; border-radius: var(--radius-base); font-family: var(--font-body); }',
    };
    const filename = `mock-component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`;
    const componentsDir = path.join(getProjectRoot(), 'storage', 'components');
    try {
      await fsPromises.mkdir(componentsDir, { recursive: true });
      await fsPromises.writeFile(path.join(componentsDir, filename), combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write mock component file ${filename}:`, e);
      throw e;
    }
    return { path: filename, prompt };
  }
}

// Lazy, mock-vs-real singleton — same reasoning as getThemeGenerator()/
// getImageGenerator(): ESM import hoisting would otherwise evaluate
// process.env before worker.ts's own env-loading flag has landed values
// in process.env when run as a bare `tsx worker.ts` process.
let cachedComponentGenerator: ComponentGenerator | undefined;

export function getComponentGenerator(): ComponentGenerator {
  if (!cachedComponentGenerator) {
    const providerName = process.env.THEME_API_PROVIDER;
    if (!providerName || providerName === 'anthropic') {
      cachedComponentGenerator = process.env.ANTHROPIC_API_KEY
        ? new ClaudeApiComponentGenerator(process.env.ANTHROPIC_API_KEY, ANTHROPIC_PROVIDER)
        : new MockComponentGenerator();
    } else if (providerName === 'cheaperinference') {
      const apiKey = process.env.CHEAPERINFERENCE_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "cheaperinference" but CHEAPERINFERENCE_API_KEY is not configured.');
      }
      cachedComponentGenerator = new ClaudeApiComponentGenerator(apiKey, CHEAPERINFERENCE_PROVIDER);
    } else {
      throw new Error(`Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic" or "cheaperinference".`);
    }
  }
  return cachedComponentGenerator;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- componentGenerator.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/services/ComponentGenerator.ts test/componentGenerator.test.ts
git commit -m "feat: add ComponentGenerator with real and mock implementations"
```

---

### Task 6: Wire `worker.ts`'s job dispatch to route component jobs

**Files:**
- Modify: `worker.ts`
- Test: `test/workerThemeRouting.test.ts` (this file already exists and tests the theme-routing branch — read it first, add a component case to it)

**Interfaces:**
- Consumes: `getComponentGenerator()` (Task 5).
- Produces: nothing consumed by later tasks by import — this is an internal dispatch change.

- [ ] **Step 1: Read the existing test file to match its established pattern**

Read `test/workerThemeRouting.test.ts` in full first — it already mocks/stubs the generator getters and asserts `processJob()` calls the right one based on `output_kind`.

- [ ] **Step 2: Write the failing test**

Add a case to `test/workerThemeRouting.test.ts` mirroring its existing theme-routing test, but for `output_kind: 'component'`, asserting `processJob()` calls the component generator (not the image generator) and the job ends up `'complete'` with a `result_path` set.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- workerThemeRouting.test.ts`
Expected: FAIL — a component job currently falls through to the image generator branch

- [ ] **Step 4: Fix the dispatch**

In `worker.ts`, add the import:
```typescript
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
```
Replace the dispatch:
```typescript
    const result = job.output_kind === 'theme'
      ? await getThemeGenerator().generate(job.prompt, job.style_id)
      : sheetOptions
        ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
        : await getImageGenerator().generate(job.prompt, job.style_id);
```
With:
```typescript
    const result = job.output_kind === 'theme'
      ? await getThemeGenerator().generate(job.prompt, job.style_id)
      : job.output_kind === 'component'
        ? await getComponentGenerator().generate(job.prompt, job.style_id)
        : sheetOptions
          ? await getImageGenerator().generateUiAsset(job.prompt, sheetOptions.pieces, sheetOptions.imageSize, sheetOptions.colorPalette)
          : await getImageGenerator().generate(job.prompt, job.style_id);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- workerThemeRouting.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker.ts test/workerThemeRouting.test.ts
git commit -m "feat: route component jobs to ComponentGenerator in the worker"
```

---

### Task 7: `GET /api/components/[filename]` serving route

**Files:**
- Create: `app/api/components/[filename]/route.ts`
- Test: `test/componentFileRoute.test.ts`

**Interfaces:**
- Consumes: nothing new (pure file-serving, mirrors `app/api/themes/[filename]/route.ts`).
- Produces: nothing consumed by later tasks by import — Task 9 and Task 10 only reference this route's URL.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/componentFileRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { GET } from '@/app/api/components/[filename]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-componentroute-'));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/components/[filename]', () => {
  it('serves a stored component file as text/html with a restrictive CSP header', async () => {
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'test.html'), '<!DOCTYPE html><html><body>hi</body></html>');
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'test.html' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('hi');
  });

  it('rejects a path-traversal filename', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: '../../etc/passwd' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent file', async () => {
    const res = await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ filename: 'nope.html' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- componentFileRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/components/[filename]/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/components/[filename]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;

  // Same guard as app/api/themes/[filename]/route.ts and
  // app/api/images/[filename]/route.ts — filenames come from the
  // database, never user-typed paths, but this is a public route, so
  // reject anything that isn't a bare filename.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
  }

  const physicalPath = path.join(getProjectRoot(), 'storage', 'components', filename);

  try {
    const data = await fsPromises.readFile(physicalPath, 'utf-8');
    return new NextResponse(data, {
      headers: {
        'Content-Type': 'text/html',
        // Defense-in-depth for GameForge's own preview rendering only —
        // this header is never baked into the stored file itself, since
        // the file is meant to be copied into the user's own real
        // website. See the design spec's security note.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
      },
    });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Component not found' }, { status: 404 });
    }
    console.error(`Failed to read component ${filename}:`, e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- componentFileRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/components/\[filename\]/route.ts test/componentFileRoute.test.ts
git commit -m "feat: add component file-serving route with restrictive CSP"
```

---

### Task 8: `PATCH /api/jobs/[id]/component` and `POST /api/jobs/[id]/component/reset`

**Files:**
- Create: `app/api/jobs/[id]/component/route.ts`
- Create: `app/api/jobs/[id]/component/reset/route.ts`
- Test: `test/jobComponentEditRoute.test.ts`
- Test: `test/jobComponentResetRoute.test.ts`

**Interfaces:**
- Consumes: `jobService.getById` (existing), `sanitizeComponentHtml`/`sanitizeComponentCss` (Task 4), `combineComponentHtml`/`parseComponentHtml` (Task 5), `getProjectRoot` (existing), `DatabaseConnection` (existing).
- Produces: nothing consumed by later tasks by import — Task 10 only references these routes' URLs.

- [ ] **Step 1: Write the failing tests for the edit route**

```typescript
// test/jobComponentEditRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { combineComponentHtml, parseComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';
import { PATCH } from '@/app/api/jobs/[id]/component/route';

let tempRoot: string;

const ORIGINAL: ComponentTokens = {
  html: '<button class="btn-primary">Buy now</button>',
  css: '.btn-primary { background: var(--color-accent); }',
};
const EDITED: ComponentTokens = {
  html: '<button class="btn-primary">Buy today</button>',
  css: '.btn-primary { background: var(--color-accent); color: var(--color-bg); }',
};

async function makeCompleteComponentJob(): Promise<{ jobId: string; filename: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `component-${crypto.randomUUID()}.html`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), combineComponentHtml(ORIGINAL));
  const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'component', prompt: 'x', outputKind: 'component' });
  DatabaseConnection.getInstance()
    .prepare("UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?")
    .run(filename, job.id);
  return { jobId: job.id, filename };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobcomponentedit-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
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

function patchRequest(tokens: ComponentTokens): NextRequest {
  return new NextRequest('http://localhost/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
  });
}

describe('PATCH /api/jobs/[id]/component', () => {
  it('persists a valid edit and returns the sanitized tokens', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual(EDITED);
    const document = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(parseComponentHtml(document)).toEqual(EDITED);
  });

  it('captures the original tokens into jobs.options.originalComponent on the first edit only', async () => {
    const { jobId } = await makeCompleteComponentJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    const jobAfterFirst = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterFirst!.options).originalComponent).toEqual(ORIGINAL);

    const SECOND_EDIT = { ...EDITED, html: '<button class="btn-primary">Buy tomorrow</button>' };
    await PATCH(patchRequest(SECOND_EDIT), { params: Promise.resolve({ id: jobId }) });
    const jobAfterSecond = await jobService.getById(jobId);
    expect(JSON.parse(jobAfterSecond!.options).originalComponent).toEqual(ORIGINAL);
  });

  it('rejects CSS containing url( with 400 and does not touch the file', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    const invalid = { ...EDITED, css: '.btn { background: url(https://evil.example/x.png); }' };
    const res = await PATCH(patchRequest(invalid), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(400);
    const document = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(parseComponentHtml(document)).toEqual(ORIGINAL);
  });

  it('sanitizes a <script> tag out of the html rather than rejecting the whole request', async () => {
    const { jobId } = await makeCompleteComponentJob();
    const withScript = { ...EDITED, html: '<button>ok</button><script>alert(1)</script>' };
    const res = await PATCH(patchRequest(withScript), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.html).not.toContain('<script');
  });

  it('rejects with 409 when the job is not in complete status', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'component', prompt: 'x', outputKind: 'component' });
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(409);
  });

  it('rejects with 400 when the job is not a component job', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'x', outputKind: 'image' });
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'complete', result_path = 'x.png' WHERE id = ?").run(job.id);
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: job.id }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- jobComponentEditRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/jobs/[id]/component/route'`

- [ ] **Step 3: Write the edit route**

```typescript
// app/api/jobs/[id]/component/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { combineComponentHtml, parseComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';

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
    if (job.output_kind !== 'component') {
      return NextResponse.json({ success: false, error: 'Only component jobs can be edited with this route' }, { status: 400 });
    }
    if (!job.result_path) {
      return NextResponse.json({ success: false, error: 'Job has no result file' }, { status: 500 });
    }
    if (job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const rawInput = (await req.json()) as ComponentTokens;
    let tokens: ComponentTokens;
    try {
      tokens = {
        html: sanitizeComponentHtml(rawInput.html),
        css: sanitizeComponentCss(rawInput.css),
      };
    } catch (e: any) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 });
    }

    const filePath = path.join(getProjectRoot(), 'storage', 'components', job.result_path);

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }

    if (options.originalComponent === undefined) {
      let currentDocument: string;
      try {
        currentDocument = await fsPromises.readFile(filePath, 'utf-8');
      } catch (e) {
        console.error(`Failed to read component file for original capture (job ${id}):`, e);
        return NextResponse.json({ success: false, error: 'Could not read the component file' }, { status: 500 });
      }
      const currentTokens = parseComponentHtml(currentDocument);
      options = { ...options, originalComponent: currentTokens };
      DatabaseConnection.getInstance()
        .prepare('UPDATE jobs SET options = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(options), Date.now(), id);
    } else {
      DatabaseConnection.getInstance()
        .prepare('UPDATE jobs SET updated_at = ? WHERE id = ?')
        .run(Date.now(), id);
    }

    try {
      await fsPromises.writeFile(filePath, combineComponentHtml(tokens));
    } catch (e) {
      console.error(`Failed to write component file on edit (job ${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the component file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: tokens });
  } catch (error: any) {
    console.error('Unexpected error in component edit route:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Write the failing tests for the reset route**

```typescript
// test/jobComponentResetRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { combineComponentHtml, parseComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';
import { PATCH } from '@/app/api/jobs/[id]/component/route';
import { POST } from '@/app/api/jobs/[id]/component/reset/route';

let tempRoot: string;

const ORIGINAL: ComponentTokens = {
  html: '<button class="btn-primary">Buy now</button>',
  css: '.btn-primary { background: var(--color-accent); }',
};
const EDITED: ComponentTokens = { ...ORIGINAL, html: '<button class="btn-primary">Buy today</button>' };

async function makeCompleteComponentJob(): Promise<{ jobId: string; filename: string }> {
  const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
  const filename = `component-${crypto.randomUUID()}.html`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), combineComponentHtml(ORIGINAL));
  const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'component', prompt: 'x', outputKind: 'component' });
  DatabaseConnection.getInstance()
    .prepare("UPDATE jobs SET status = 'complete', result_path = ? WHERE id = ?")
    .run(filename, job.id);
  return { jobId: job.id, filename };
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobcomponentreset-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
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

function patchRequest(tokens: ComponentTokens): NextRequest {
  return new NextRequest('http://localhost/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
  });
}

describe('POST /api/jobs/[id]/component/reset', () => {
  it('restores the file to the original tokens after an edit', async () => {
    const { jobId, filename } = await makeCompleteComponentJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });

    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual(ORIGINAL);

    const document = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', filename), 'utf-8');
    expect(parseComponentHtml(document)).toEqual(ORIGINAL);
  });

  it('returns 404 when the job has never been edited', async () => {
    const { jobId } = await makeCompleteComponentJob();
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(404);
  });

  it('rejects with 409 when the job has been promoted', async () => {
    const { jobId } = await makeCompleteComponentJob();
    await PATCH(patchRequest(EDITED), { params: Promise.resolve({ id: jobId }) });
    DatabaseConnection.getInstance().prepare("UPDATE jobs SET status = 'promoted' WHERE id = ?").run(jobId);
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(409);
  });

  it('returns 404 for a nonexistent job', async () => {
    const res = await POST(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });
});
```
(The 409-on-promoted test above directly exercises the exact fix this session's final review found missing on the theme reset route — do not skip it.)

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test -- jobComponentEditRoute.test.ts jobComponentResetRoute.test.ts`
Expected: edit route tests FAIL (module not found is now resolved from Step 3, so these should be closer to passing — verify); reset route tests FAIL — `Cannot find module '@/app/api/jobs/[id]/component/reset/route'`

- [ ] **Step 6: Write the reset route**

```typescript
// app/api/jobs/[id]/component/reset/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { jobService } from '@/lib/services/JobService';
import { combineComponentHtml, type ComponentTokens } from '@/lib/services/ComponentGenerator';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await jobService.getById(id);
    if (!job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    }
    if (job.status !== 'complete') {
      return NextResponse.json({ success: false, error: 'Only a completed job can be reset' }, { status: 409 });
    }
    if (job.output_kind !== 'component') {
      return NextResponse.json({ success: false, error: 'Only component jobs can be reset with this route' }, { status: 400 });
    }

    let options: Record<string, unknown>;
    try {
      options = JSON.parse(job.options);
    } catch {
      options = {};
    }
    if (options.originalComponent === undefined) {
      return NextResponse.json({ success: false, error: 'This job has never been edited' }, { status: 404 });
    }
    if (!job.result_path || job.result_path.includes('/') || job.result_path.includes('\\') || job.result_path.includes('..')) {
      return NextResponse.json({ success: false, error: 'Invalid result path' }, { status: 400 });
    }

    const originalTokens = options.originalComponent as ComponentTokens;
    const filePath = path.join(getProjectRoot(), 'storage', 'components', job.result_path);
    try {
      await fsPromises.writeFile(filePath, combineComponentHtml(originalTokens));
    } catch (e) {
      console.error(`Failed to write component file on reset (job ${id}):`, e);
      return NextResponse.json({ success: false, error: 'Could not write the component file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: originalTokens });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- jobComponentEditRoute.test.ts jobComponentResetRoute.test.ts`
Expected: PASS (7 + 4 tests)

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add app/api/jobs/\[id\]/component/route.ts app/api/jobs/\[id\]/component/reset/route.ts test/jobComponentEditRoute.test.ts test/jobComponentResetRoute.test.ts
git commit -m "feat: add component edit and reset routes"
```

---

### Task 9: `JobCard.tsx` and `AssetCard.tsx` — component preview branch

**Files:**
- Modify: `app/components/JobCard.tsx`
- Modify: `app/components/AssetCard.tsx`

**Interfaces:**
- Consumes: `GET /api/components/[filename]` (Task 7, referenced by URL only).
- Produces: nothing consumed by later tasks — the edit-component page (Task 10) links to this card's new "Edit" affordance conceptually, but there's no code-level dependency (it's just a URL both files reference independently).

No automated test for this task — this codebase has no component-testing infrastructure (confirmed and already established convention from items 4 and 5's own final UI tasks). Verify manually per Step 3.

- [ ] **Step 1: Update `JobCard.tsx`**

In `app/components/JobCard.tsx`, find the preview rendering block:
```tsx
        {job.output_kind === 'theme' && job.result_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}`)}
            title={`Theme preview: ${job.prompt}`}
            sandbox=""
            style={{ width: 260, height: 180, border: 'none', transform: 'scale(0.28)', transformOrigin: 'top left' }}
          />
        ) : job.result_path ? (
```
Insert a new branch between the theme case and the image fallback:
```tsx
        {job.output_kind === 'theme' && job.result_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${job.result_path}`)}
            title={`Theme preview: ${job.prompt}`}
            sandbox=""
            style={{ width: 260, height: 180, border: 'none', transform: 'scale(0.28)', transformOrigin: 'top left' }}
          />
        ) : job.output_kind === 'component' && job.result_path ? (
          <iframe
            src={`/api/components/${job.result_path}`}
            title={`Component preview: ${job.prompt}`}
            sandbox=""
            style={{ width: 260, height: 180, border: 'none', transform: 'scale(0.28)', transformOrigin: 'top left' }}
          />
        ) : job.result_path ? (
```
Then find the "Edit" link condition added for themes (from the live-tweaking feature):
```tsx
            {job.output_kind === 'theme' && job.status === 'complete' && (
              <Link href={`/dashboard/jobs/${job.id}/edit`} className="btn">
                Edit
              </Link>
            )}
```
Add a sibling condition right after it (a separate `Link`, not a merged condition — the two point at different routes):
```tsx
            {job.output_kind === 'component' && job.status === 'complete' && (
              <Link href={`/dashboard/jobs/${job.id}/edit-component`} className="btn">
                Edit
              </Link>
            )}
```

- [ ] **Step 2: Update `AssetCard.tsx`**

In `app/components/AssetCard.tsx`, find:
```tsx
        {asset.output_kind === 'theme' && asset.image_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 320, height: 320, border: 'none', transform: 'scale(0.5)', transformOrigin: 'top left' }}
          />
        ) : asset.image_path ? (
```
Insert the same kind of new branch:
```tsx
        {asset.output_kind === 'theme' && asset.image_path ? (
          <iframe
            srcDoc={buildThemePreviewHtml(`/api/themes/${asset.image_path}`)}
            title={`Theme preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 320, height: 320, border: 'none', transform: 'scale(0.5)', transformOrigin: 'top left' }}
          />
        ) : asset.output_kind === 'component' && asset.image_path ? (
          <iframe
            src={`/api/components/${asset.image_path}`}
            title={`Component preview: ${asset.prompt}`}
            sandbox=""
            style={{ width: 320, height: 320, border: 'none', transform: 'scale(0.5)', transformOrigin: 'top left' }}
          />
        ) : asset.image_path ? (
```

- [ ] **Step 3: Manually verify**

1. Run `npm run dev` (background it) and `npm run dev:worker`.
2. Create a Style Bible if needed, queue a component generation (once Task 11's form exists — if Task 11 isn't done yet, queue it directly via a `fetch` to `/api/generate` with `outputKind: 'component'` from the browser devtools console, or via curl, to unblock this verification).
3. Confirm the job card shows a real iframe rendering the mock button (not a broken image icon).
4. Confirm the "Edit" link appears once the job completes.
5. Promote it, confirm `/dashboard/assets` shows the same correct iframe rendering for the promoted asset.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS (no regressions — this task has no new automated tests)

- [ ] **Step 5: Commit**

```bash
git add app/components/JobCard.tsx app/components/AssetCard.tsx
git commit -m "feat: add component preview rendering to JobCard and AssetCard"
```

---

### Task 10: Component edit page

**Files:**
- Create: `app/dashboard/jobs/[id]/edit-component/page.tsx`

**Interfaces:**
- Consumes: `GET /api/jobs/[id]` (existing, URL only), `GET /api/components/[filename]` (Task 7, URL only), `PATCH /api/jobs/[id]/component` and `POST /api/jobs/[id]/component/reset` (Task 8, URL only), `ComponentTokens` type (Task 5, for typing local state).
- Produces: nothing consumed by later tasks — this is the second-to-last task.

No automated test — same established no-component-testing-infra convention as Task 9. Verify manually per Step 2.

- [ ] **Step 1: Create the edit page**

```typescript
// app/dashboard/jobs/[id]/edit-component/page.tsx
'use client';

import { useEffect, useRef, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import type { Job } from '@/lib/database/schema';
import type { ComponentTokens } from '@/lib/services/ComponentGenerator';

const DEBOUNCE_MS = 400;

export default function EditComponentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [tokens, setTokens] = useState<ComponentTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const res = await fetch(`/api/jobs/${id}`);
      const body = await res.json();
      if (ignore) return;
      if (!body.success) {
        setError(body.error ?? 'Could not load this job.');
        return;
      }
      setJob(body.data);
      try {
        const document = await (await fetch(`/api/components/${body.data.result_path}`)).text();
        if (ignore) return;
        const { parseComponentHtml } = await import('@/lib/services/ComponentGenerator');
        setTokens(parseComponentHtml(document));
      } catch {
        if (!ignore) setError('Could not read this component\'s current values.');
      }
    })();
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function handleFieldChange(key: keyof ComponentTokens, value: string) {
    if (!tokens) return;
    const next = { ...tokens, [key]: value };
    setTokens(next);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => savePatch(next), DEBOUNCE_MS);
  }

  async function savePatch(next: ComponentTokens) {
    try {
      const res = await fetch(`/api/jobs/${id}/component`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not save that change.');
      } else {
        setTokens(body.data);
        setPreviewVersion(v => v + 1);
      }
    } catch {
      setError('Could not reach the server.');
    }
  }

  async function handleReset() {
    if (resetting) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setResetting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}/component/reset`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not reset this component.');
      } else {
        setTokens(body.data);
        setPreviewVersion(v => v + 1);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setResetting(false);
    }
  }

  if (error && !tokens) {
    return <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>;
  }
  if (!job || !tokens) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Edit component</h1>
      <p className="page-subtitle">
        Changes save automatically. Use Reset to original if a tweak doesn&apos;t work out.
      </p>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <iframe
          src={`/api/components/${job.result_path}?v=${previewVersion}`}
          title={`Component preview: ${job.prompt}`}
          sandbox=""
          style={{ width: 480, height: 340, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />

        <div className="card" style={{ flex: 1, minWidth: 280 }}>
          <div className="field">
            <label htmlFor="html">HTML</label>
            <textarea
              id="html"
              value={tokens.html}
              onChange={e => handleFieldChange('html', e.target.value)}
              rows={8}
            />
          </div>
          <div className="field">
            <label htmlFor="css">CSS</label>
            <textarea
              id="css"
              value={tokens.css}
              onChange={e => handleFieldChange('css', e.target.value)}
              rows={8}
            />
          </div>

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
(The `await import('@/lib/services/ComponentGenerator')` inside the load effect is used for `parseComponentHtml` specifically — check whether `ComponentGenerator.ts` (Task 5) has any Node-only imports that would break Turbopack's client bundling the same way `ThemeGenerator.ts` did during the live-tweaking feature. `combineComponentHtml`/`parseComponentHtml` are pure string functions with no Node-only imports of their own, but `ComponentGenerator.ts` as a WHOLE file also exports `ClaudeApiComponentGenerator`, which imports `getProjectRoot`/`fsPromises` — genuinely Node-only. If importing `parseComponentHtml` statically from `@/lib/services/ComponentGenerator` at the top of this client page causes the same bundling crash the theme editor hit, apply the SAME fix that feature's own review found: extract `ComponentTokens`/`combineComponentHtml`/`parseComponentHtml` into a separate, dependency-free file — e.g. `lib/services/componentDocument.ts` — with `ComponentGenerator.ts` re-exporting from it, mirroring `themeTokens.ts`'s exact role for `ThemeGenerator.ts`. Verify this by actually loading the page in a browser (Step 2 below), not by reasoning about it — this exact bug was only found by real browser testing last time.)

- [ ] **Step 2: Manually verify the golden path**

1. Run `npm run dev` (background it) and `npm run dev:worker`.
2. Generate a component (mock generator is fine).
3. Confirm the edit page loads with the live preview and both HTML/CSS textareas pre-filled with the mock button's markup.
4. **If the page 500s on load**, this is the exact Node-in-client-bundle bug found during the live-tweaking feature — apply the module-split fix described in Step 1's note above, then re-verify.
5. Edit the CSS (e.g. change the background color reference), wait ~1 second, confirm no error, confirm the preview updates live (not just after a refresh).
6. Refresh the page, confirm the edit persisted.
7. Click "Reset to original", confirm both textareas and the preview snap back.
8. Try submitting CSS containing `url(...)` — confirm a clear error appears and the file is untouched.
9. Go back to `/dashboard/jobs`, promote the job, confirm the promoted asset reflects the edited (not original) values.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/jobs/\[id\]/edit-component/page.tsx
git commit -m "feat: add component editing page with live preview"
```

(If Step 1's note required extracting a separate `componentDocument.ts` file, include that file and `ComponentGenerator.ts`'s updated re-export in this same commit, and update the commit message to mention it — the same way the live-tweaking feature's equivalent fix was committed alongside its own edit page.)

---

### Task 11: Component generation form

**Files:**
- Create: `app/dashboard/components/page.tsx`

**Interfaces:**
- Consumes: `StyleBiblePicker` (existing, `app/components/StyleBiblePicker.tsx`), `useStyles`/`usePolling`/`useJobStore` hooks (existing, same as `app/dashboard/themes/page.tsx`), `getClientId` (existing), `JobCard` (existing, now with the Task 9 component branch), `POST /api/generate` (existing, URL only, now accepting `outputKind: 'component'` per Task 1).
- Produces: nothing consumed by later tasks — this is the final task.

No automated test — this page is a thin form wrapper with no logic beyond what `app/dashboard/themes/page.tsx` (its direct template) already has covered by manual verification precedent. Verify manually per Step 2.

- [ ] **Step 1: Create the page**

Mirror `app/dashboard/themes/page.tsx`'s exact structure (read it directly first), replacing the candidate-count selector with a component-type dropdown and filtering the job list by `output_kind === 'component'` instead of `'theme'`:

```typescript
// app/dashboard/components/page.tsx
'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { usePolling } from '@/lib/hooks/usePolling';
import { useJobStore } from '@/lib/store/useJobStore';
import { getClientId } from '@/lib/utils/clientId';
import { JobCard } from '@/app/components/JobCard';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

const COMPONENT_TYPES = ['Button', 'Card', 'Nav Bar', 'Form', 'Other'] as const;

export default function ComponentsPage() {
  const { styles, loading: stylesLoading } = useStyles();
  const jobs = useJobStore(s => s.jobs).filter(j => j.output_kind === 'component');
  const refreshActive = useJobStore(s => s.refreshActive);
  usePolling(refreshActive, 2000);

  const [styleId, setStyleId] = useState('');
  const [componentType, setComponentType] = useState<typeof COMPONENT_TYPES[number]>('Button');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeStyleId = styleId || styles[0]?.id || '';

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
          createdBy: getClientId(),
          assetType: 'component',
          prompt: `${componentType}: ${prompt.trim()}`,
          outputKind: 'component',
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Generation failed to queue.');
      } else {
        setPrompt('');
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
      <h1 className="page-title">Components</h1>
      <p className="page-subtitle">
        Generate a real HTML+CSS website component (button, card, nav bar) styled to a Style Bible. Same
        review-and-promote flow as themes and images.
      </p>

      {!stylesLoading && styles.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 32 }}>
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before generating a component.
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 32, maxWidth: 480 }}>
          <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />

          <div className="field">
            <label htmlFor="componentType">Component type</label>
            <select
              id="componentType"
              value={componentType}
              onChange={e => setComponentType(e.target.value as typeof COMPONENT_TYPES[number])}
            >
              {COMPONENT_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="prompt">Description</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="a primary call-to-action button, rounded corners"
            />
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
(Check whether this codebase has a shared nav/sidebar component that lists dashboard pages — e.g. `app/dashboard/layout.tsx` — and add a link to `/dashboard/components` there if such a list exists, matching how `/dashboard/themes` is presumably already linked. If no such central nav list exists, skip this — don't invent navigation infrastructure this codebase doesn't already have.)

- [ ] **Step 2: Manually verify the golden path**

1. Run `npm run dev` (background it) and `npm run dev:worker`.
2. Navigate to `/dashboard/components`, confirm the form renders with a Style Bible picker, component-type dropdown, and prompt field.
3. Submit a generation, confirm a job card appears and completes (mock generator).
4. Confirm the completed card shows the real component preview (from Task 9) and an Edit link (to Task 10's page).
5. Confirm `/dashboard/jobs` also shows this same job (the shared jobs list, not filtered to this page).

- [ ] **Step 3: Run the full test suite one final time**

Run: `npm test`
Expected: PASS (all tasks' tests, no regressions)

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/components/page.tsx
git commit -m "feat: add component generation form"
```
