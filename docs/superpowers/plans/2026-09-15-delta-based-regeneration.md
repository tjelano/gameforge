# Delta-Based Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Regenerate with changes" cheaper and faster by having the AI emit a batch of targeted, id-anchored element patches instead of the entire HTML+CSS document, whenever the requested change only touches existing elements' style or content, with an automatic full-regenerate fallback whenever it doesn't.

**Architecture:** `ComponentGenerator.generate()` forks its tool schema (`emit_component_delta` instead of `emit_component`) and return shape (`ComponentDeltaResult`, a discriminated union) only when `basedOnContent` is present, and never writes to disk on that path. A new `resolveComponentRegeneration()` in `componentPatchService.ts` owns that write: it resolves the AI's response (patches or full), runs a shared pure `applyPatchBuffer()` helper (also refactored into `applyElementPatch()`'s own existing single-patch path) to splice patches, retries once on a bad id, falls back to a forced full regenerate on anything else that goes wrong, re-verifies the based-on asset hasn't moved, and writes the result to a freshly allocated filename. `worker.ts`'s `case 'component':` branch calls it only when based-on content was actually read.

**Tech Stack:** TypeScript, Zod (`.strict()` discriminated unions), Vitest, existing `htmlparser2`/`dom-serializer` DOM helpers already used by `componentElementTree.ts`/`componentSanitize.ts`.

**Spec:** `docs/superpowers/specs/2026-09-15-delta-based-regeneration-design.md` (read this too — it has the full reasoning, the rejected alternatives, and the review history this plan's decisions came out of).

## Global Constraints

- No lock anywhere in this feature. The file `resolveComponentRegeneration()` writes is always freshly allocated (`component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`) — nothing else can be concurrently writing it, matching the same no-lock guarantee `generate()`'s own existing writes already rely on.
- `generate()`'s behavior when `basedOnContent` is `undefined` (first-generate) is completely unchanged — same tool, same return shape, same internal write. Every change in this plan is additive to the `basedOnContent`-present branch only, except the one shared refactor in Task 2.
- Patches-mode batch caps: count cap `20`, byte cap `50%` of the based-on document's own total size (`sourceTokens.html.length + sourceTokens.css.length`). Both pinned constants, not tunable via params in this pass.
- A response that fails `.strict()` Zod validation is a `ZodError` thrown from `generate()`, not swallowed — callers distinguish it from other thrown errors via `instanceof ZodError` to route to the fallback rather than a hard failure.
- `applyElementPatch()`'s existing behavior (from the caller's point of view — inputs, outputs, error codes, message text) must not change at all in Task 2's refactor. It is a pure internal dedup; the existing test suite for it must pass unchanged with zero edits to those tests.

---

### Task 1: `ComponentGenerator.generate()` — delta tool schema, `correction`/`forceFull` params

**Files:**
- Modify: `lib/services/ComponentGenerator.ts`
- Test: `test/componentGeneratorDelta.test.ts` (create)

**Interfaces:**
- Produces: `export type ComponentDeltaResult = { mode: 'patches'; patches: Array<{ dataGfId: string; html: string; cssDeclarations: string | null }> } | { mode: 'full'; html: string; css: string };` — Task 3 consumes this type directly.
- Produces: `ComponentGenerator.generate()`'s widened signature — `generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride, correction?: string, forceFull?: boolean): Promise<GeneratedComponent | ComponentDeltaResult>` — Task 3 calls this with `basedOnContent` always defined, so it always receives back a `ComponentDeltaResult` in practice (asserted via `as ComponentDeltaResult` at each call site in Task 3, since the runtime shape is already guaranteed by this task's own Zod validation).
- Consumes: nothing from other tasks — this task is self-contained.

- [ ] **Step 1: Add the delta type, JSON-schema, and Zod schema to `ComponentGenerator.ts`**

Add near the top of the file, after the existing `PATCH_TOOL_INPUT_SCHEMA` constant:

```ts
export type ComponentDeltaResult =
  | { mode: 'patches'; patches: Array<{ dataGfId: string; html: string; cssDeclarations: string | null }> }
  | { mode: 'full'; html: string; css: string };

const DELTA_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    mode: {
      type: 'string',
      enum: ['patches', 'full'],
      description: 'Use "patches" when the instruction only changes existing elements\' style or content. Use "full" when it requires adding, removing, or reordering elements.',
    },
    patches: {
      type: 'array',
      description: 'Required when mode is "patches". A list of targeted edits, each replacing one existing element (identified by its data-gf-id) with new content.',
      items: {
        type: 'object',
        properties: {
          dataGfId: { type: 'string', description: 'The data-gf-id of the existing element this patch replaces.' },
          html: { type: 'string', description: 'The complete replacement outerHTML for this one element.' },
          cssDeclarations: { type: 'string', description: 'CSS declarations only (e.g. "color: blue;"), no selector or braces. Omit if this patch does not change styling.' },
        },
        required: ['dataGfId', 'html'],
      },
    },
    html: { type: 'string', description: 'Required when mode is "full". The component\'s complete replacement HTML markup.' },
    css: { type: 'string', description: 'Required when mode is "full". The component\'s complete replacement CSS.' },
  },
  required: ['mode'],
};

const DeltaPatchSchema = z.object({
  dataGfId: z.string(),
  html: z.string(),
  cssDeclarations: z.string().nullish(),
}).strict();

const ComponentDeltaResultSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('patches'), patches: z.array(DeltaPatchSchema) }).strict(),
  z.object({ mode: z.literal('full'), html: z.string(), css: z.string() }).strict(),
]);
```

- [ ] **Step 2: Widen the `ComponentGenerator` interface**

Change:

```ts
export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent>;
  patchElement(elementOuterHtml: string, instruction: string, currentDeclarations: string | null, styleId: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<PatchedElement>;
}
```

To:

```ts
export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride, correction?: string, forceFull?: boolean): Promise<GeneratedComponent | ComponentDeltaResult>;
  patchElement(elementOuterHtml: string, instruction: string, currentDeclarations: string | null, styleId: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<PatchedElement>;
}
```

- [ ] **Step 3: Rewrite `ClaudeApiComponentGenerator.generate()`**

Replace the entire existing method body with:

```ts
  async generate(
    prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload,
    basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride,
    correction?: string, forceFull?: boolean,
  ): Promise<GeneratedComponent | ComponentDeltaResult> {
    const style = await styleService.getById(styleId);
    const basePrompt = buildComponentPrompt(style?.parameters ?? '{}', prompt, componentType, basedOnContent);

    if (basedOnContent === undefined) {
      // First-generate: completely unchanged from before this task, just using `basePrompt` in
      // place of the old local `fullPrompt` name (no behavior change).
      const fullPrompt = basePrompt;
      const content: string | Array<Record<string, unknown>> = referenceImage
        ? [
            { type: 'image', source: { type: 'base64', media_type: referenceImage.mediaType, data: referenceImage.base64 } },
            { type: 'text', text: fullPrompt },
          ]
        : fullPrompt;

      const toolInput = providerOverride
        ? await callOllamaTool({
            host: providerOverride.host,
            model: providerOverride.model,
            toolName: 'emit_component',
            toolDescription: 'Emit a single website UI component as HTML and CSS.',
            inputSchema: TOOL_INPUT_SCHEMA,
            messages: [{ role: 'user', content: providerOverride.correctionRequested
              ? `${fullPrompt}\n\nYou did not call the emit_component tool last time -- you must call it now with valid arguments matching its schema.`
              : content }],
            signal,
            operationLabel: 'component generation',
            truncatedMessage: 'the component could not be generated',
          })
        : await callClaudeTool({
            provider: this.provider,
            apiKey: this.apiKey,
            toolName: 'emit_component',
            toolDescription: 'Emit a single website UI component as HTML and CSS.',
            inputSchema: TOOL_INPUT_SCHEMA,
            messages: [{ role: 'user', content }],
            signal,
            operationLabel: 'component generation',
            truncatedMessage: 'the component could not be generated',
          });

      const raw = z.object({ html: z.string(), css: z.string() }).parse(toolInput);
      const tokens: ComponentTokens = {
        html: assignElementIds(sanitizeComponentHtml(raw.html)),
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

    // Regenerate-with-changes (basedOnContent present): never writes to disk on this path,
    // regardless of the resulting mode -- resolveComponentRegeneration() (Task 3) owns every write.
    const fullPrompt = correction ? `${basePrompt}\n\n${correction}` : basePrompt;
    const useFullTool = forceFull === true;
    const toolName = useFullTool ? 'emit_component' : 'emit_component_delta';
    const toolDescription = useFullTool
      ? 'Emit a single website UI component as HTML and CSS.'
      : 'Emit either a list of targeted element patches, or a full replacement component, as HTML and CSS.';
    const inputSchema = useFullTool ? TOOL_INPUT_SCHEMA : DELTA_TOOL_INPUT_SCHEMA;

    const content: string | Array<Record<string, unknown>> = referenceImage
      ? [
          { type: 'image', source: { type: 'base64', media_type: referenceImage.mediaType, data: referenceImage.base64 } },
          { type: 'text', text: fullPrompt },
        ]
      : fullPrompt;

    const toolInput = providerOverride
      ? await callOllamaTool({
          host: providerOverride.host,
          model: providerOverride.model,
          toolName,
          toolDescription,
          inputSchema,
          messages: [{ role: 'user', content: providerOverride.correctionRequested
            ? `${fullPrompt}\n\nYou did not call the ${toolName} tool last time -- you must call it now with valid arguments matching its schema.`
            : content }],
          signal,
          operationLabel: 'component generation',
          truncatedMessage: 'the component could not be generated',
        })
      : await callClaudeTool({
          provider: this.provider,
          apiKey: this.apiKey,
          toolName,
          toolDescription,
          inputSchema,
          messages: [{ role: 'user', content }],
          signal,
          operationLabel: 'component generation',
          truncatedMessage: 'the component could not be generated',
        });

    if (useFullTool) {
      const raw = z.object({ html: z.string(), css: z.string() }).strict().parse(toolInput);
      return { mode: 'full', html: raw.html, css: raw.css };
    }
    return ComponentDeltaResultSchema.parse(toolInput);
  }
```

- [ ] **Step 4: Update `MockComponentGenerator.generate()`'s signature to match**

Replace its method signature and body with:

```ts
  async generate(
    prompt: string, _styleId: string, _componentType?: string, _referenceImage?: ReferenceImagePayload,
    basedOnContent?: string, _signal?: AbortSignal, _providerOverride?: OllamaProviderOverride,
    _correction?: string, _forceFull?: boolean,
  ): Promise<GeneratedComponent | ComponentDeltaResult> {
    if (_providerOverride) {
      throw new Error('Ollama was requested but no real generator is configured (ANTHROPIC_API_KEY unset), so the mock generator is active.');
    }
    const tokens: ComponentTokens = {
      html: '<button class="btn-primary">Buy now</button>',
      css: '.btn-primary { background: var(--color-accent); color: var(--color-bg); padding: calc(var(--space-unit) * 1.5) calc(var(--space-unit) * 3); border: none; border-radius: var(--radius-base); font-family: var(--font-body); }',
    };
    if (basedOnContent !== undefined) {
      return { mode: 'full', html: tokens.html, css: tokens.css };
    }
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
```

- [ ] **Step 5: Write the test file**

Create `test/componentGeneratorDelta.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { ClaudeApiComponentGenerator } from '@/lib/services/ComponentGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';
import * as claudeToolCallModule from '@/lib/services/claudeToolCall';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-cgdelta-'));
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
  vi.restoreAllMocks();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('ClaudeApiComponentGenerator.generate() delta path', () => {
  it('uses emit_component when basedOnContent is absent (first-generate, unchanged)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await gen.generate('a button', style.id);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component' }));
  });

  it('uses emit_component_delta when basedOnContent is present', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    const result = await gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>');

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component_delta' }));
    expect(result).toEqual({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
  });

  it('uses emit_component (not emit_component_delta) when forceFull is true, even with basedOnContent present', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    const result = await gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>', undefined, undefined, undefined, true);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component' }));
    expect(result).toEqual({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
  });

  it('appends the correction text to the prompt when provided', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const spy = vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>', undefined, undefined, 'Fix the missing id.');

    const call = spy.mock.calls[0][0] as any;
    expect(call.messages[0].content).toContain('Fix the missing id.');
  });

  it('rejects a response carrying fields from both discriminated-union arms', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ mode: 'full', html: '<button>Buy</button>', css: '.x{color:red}', patches: [] });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await expect(gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>')).rejects.toThrow();
  });

  it('rejects a response missing mode entirely', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    vi.spyOn(claudeToolCallModule, 'callClaudeTool').mockResolvedValue({ html: '<button>Buy</button>', css: '.x{color:red}' });
    const gen = new ClaudeApiComponentGenerator('key', ANTHROPIC_PROVIDER);

    await expect(gen.generate('make it blue', style.id, undefined, undefined, '<html>based on this</html>')).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/componentGeneratorDelta.test.ts`
Expected: PASS (6 tests). Then run: `npx tsc --noEmit` (the interface widening must not break any other caller — there is only one, `worker.ts`, which Task 4 updates; until then `worker.ts`'s existing call still type-checks because `GeneratedComponent | ComponentDeltaResult`'s `GeneratedComponent` arm still has `.path`).

- [ ] **Step 7: Commit**

```bash
git add lib/services/ComponentGenerator.ts test/componentGeneratorDelta.test.ts
git commit -m "feat: add emit_component_delta tool schema and correction/forceFull params to generate()"
```

---

### Task 2: Extract `applyPatchBuffer()`, refactor `applyElementPatch()` to use it

**Files:**
- Modify: `lib/services/componentPatchService.ts`
- Modify: `test/componentPatchService.test.ts` (add a new `describe('applyPatchBuffer', ...)` block; existing tests must pass unchanged)

**Interfaces:**
- Consumes: nothing new from Task 1 (this task only touches `componentPatchService.ts`'s existing single-patch logic).
- Produces: `export type PatchInput = { dataGfId: string; html: string; cssDeclarations: string | null };` and `export function applyPatchBuffer(tokens: ComponentTokens, patches: PatchInput[]): ApplyPatchBufferResult` where `export type ApplyPatchBufferResult = { ok: true; tokens: ComponentTokens; appliedIds: string[]; newDescendantIds: string[] } | { ok: false; reason: 'vanished'; dataGfId: string } | { ok: false; reason: 'sanitize-rejected'; message: string };` — Task 3 calls this directly.

- [ ] **Step 1: Add `PatchInput`, `ApplyPatchBufferResult`, and `applyPatchBuffer()` to `componentPatchService.ts`**

Add this after the `PatchResult` interface and before `withFileLock`:

```ts
export type PatchInput = { dataGfId: string; html: string; cssDeclarations: string | null };

export type ApplyPatchBufferResult =
  | { ok: true; tokens: ComponentTokens; appliedIds: string[]; newDescendantIds: string[] }
  | { ok: false; reason: 'vanished'; dataGfId: string }
  | { ok: false; reason: 'sanitize-rejected'; message: string };

/**
 * Applies a batch of id-anchored patches to `tokens` in memory, mirroring applyElementPatch's own
 * per-patch sequence (sanitize, assign fresh descendant ids, ensure the gf-<id> class, merge CSS,
 * splice) generalized to N patches applied in order. Every `dataGfId` in `patches` must already be
 * confirmed present in `tokens` by the caller BEFORE calling this (see resolveComponentRegeneration's
 * own upfront resolution step) -- a `dataGfId` that can't be found here always means an EARLIER
 * patch in this same call already removed it (a "mid-batch vanish"), not that it never existed,
 * since the caller has already ruled that out. Pure: no disk, no AI, no clock/randomness -- calling
 * it twice with the same inputs always produces the same result.
 */
export function applyPatchBuffer(tokens: ComponentTokens, patches: PatchInput[]): ApplyPatchBufferResult {
  let html = tokens.html;
  let css = tokens.css;
  const appliedIds: string[] = [];
  const newDescendantIds: string[] = [];

  for (const patch of patches) {
    const located = findElementByDataGfId(html, patch.dataGfId);
    if (!located.found) {
      return { ok: false, reason: 'vanished', dataGfId: patch.dataGfId };
    }

    if (RAW_MARKER_PATTERN.test(patch.html)) {
      return { ok: false, reason: 'sanitize-rejected', message: 'Patch contains a disallowed marker sequence.' };
    }

    let sanitizedHtml: string;
    try {
      sanitizedHtml = sanitizeComponentHtml(patch.html);
    } catch (e: any) {
      return { ok: false, reason: 'sanitize-rejected', message: e.message };
    }
    if (!sanitizedHtml.trim()) {
      return { ok: false, reason: 'sanitize-rejected', message: 'Patch sanitized to nothing.' };
    }

    // Seeded from max(existing data-gf-id) across the CURRENT buffer, recomputed before each patch
    // -- reusing a pre-batch max across multiple patches that each introduce new descendants would
    // silently produce colliding ids between patches.
    const startAt = maxDataGfId(html) + 1;
    let idAssignedFragment: string;
    try {
      idAssignedFragment = assignElementIds(sanitizedHtml, { preserveRootId: patch.dataGfId, startAt });
    } catch (e: any) {
      return { ok: false, reason: 'sanitize-rejected', message: e?.message ?? 'Patch fragment must be exactly one root element.' };
    }

    const gfClass = `gf-${patch.dataGfId}`;
    const withClass = ensureClassOnRoot(idAssignedFragment, gfClass);

    if (patch.cssDeclarations !== null) {
      let sanitizedRule: string;
      try {
        sanitizedRule = sanitizeComponentCss(`.${gfClass} { ${patch.cssDeclarations} }`);
      } catch (e: any) {
        return { ok: false, reason: 'sanitize-rejected', message: e.message };
      }
      css = replaceOrAppendRuleForClass(css, gfClass, sanitizedRule);
    }

    try {
      html = replaceElementByDataGfId(html, patch.dataGfId, withClass);
    } catch (e: any) {
      // findElementByDataGfId already confirmed this id exists and is unambiguous immediately
      // above, with nothing in between that could change `html` -- unreachable in practice, but
      // every path through this loop must return a typed result, never let an exception escape.
      return { ok: false, reason: 'sanitize-rejected', message: e?.message ?? 'Failed to apply patch.' };
    }

    appliedIds.push(patch.dataGfId);
    const thisPatchDescendantIds = [...idAssignedFragment.matchAll(/data-gf-id="(\d+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== patch.dataGfId);
    newDescendantIds.push(...thisPatchDescendantIds);
  }

  return { ok: true, tokens: { html, css }, appliedIds, newDescendantIds };
}
```

- [ ] **Step 2: Refactor `applyElementPatch()`'s locked phase to call `applyPatchBuffer()`**

Inside the `withFileLock(params.filename, async () => { ... })` callback, find this block (it runs right after `reLocated` is checked):

```ts
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

    // Seeded from max(existing data-gf-id) across the WHOLE freshly-read document, not just the
    // patch fragment — ids must stay unique document-wide, not just within this one patch.
    const startAt = maxDataGfId(tokens.html) + 1;
    let idAssignedFragment: string;
    try {
      idAssignedFragment = assignElementIds(sanitizedHtml, { preserveRootId: params.dataGfId, startAt });
    } catch (e: any) {
      // Thrown when the sanitized fragment isn't exactly one root element (assignElementIds'
      // preserveRootId mode requires it) — the brief's reference code didn't guard this call, but
      // an uncaught throw here would violate "every error path returns a PatchError."
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e?.message ?? 'Patch fragment must be exactly one root element.' } };
    }

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
```

Replace that entire block with:

```ts
    const bufferResult = applyPatchBuffer(tokens, [{ dataGfId: params.dataGfId, html: patched.html, cssDeclarations: patched.cssDeclarations }]);
    if (!bufferResult.ok) {
      if (bufferResult.reason === 'vanished') {
        // reLocated.found (checked immediately above) already confirmed this exact id exists,
        // with nothing in between that could remove it -- unreachable in practice, but every
        // outcome applyPatchBuffer can report must still be handled with a real PatchError.
        return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };
      }
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: bufferResult.message } };
    }
    const { html: newHtml, css: newCss } = bufferResult.tokens;
```

Then, further down in the same function, find:

```ts
    const newDescendantIds = [...idAssignedFragment.matchAll(/data-gf-id="(\d+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== params.dataGfId);

    return {
      ok: true,
      idMap: { rootId: params.dataGfId, newDescendantIds },
      newDocumentHash: hashDocument(combined),
    };
```

Replace it with:

```ts
    return {
      ok: true,
      idMap: { rootId: params.dataGfId, newDescendantIds: bufferResult.newDescendantIds },
      newDocumentHash: hashDocument(combined),
    };
```

Everything else in `applyElementPatch()` (the trust guard, `readVerifiedTokens`, the round-trip assertion, the write, the prompt-history recording) stays exactly as it is — untouched.

- [ ] **Step 3: Run the existing test suite to confirm zero regressions**

Run: `npx vitest run test/componentPatchService.test.ts`
Expected: every existing test in this file still PASSes, unmodified — this refactor must be behavior-preserving.

- [ ] **Step 4: Add `applyPatchBuffer` to the test file's import, and add a new `describe` block for it**

In `test/componentPatchService.test.ts`, change the import line:

```ts
import { applyElementPatch } from '@/lib/services/componentPatchService';
```

to:

```ts
import { applyElementPatch, applyPatchBuffer } from '@/lib/services/componentPatchService';
```

Then add this new block anywhere at the top level of the file (alongside the existing `describe('applyElementPatch', ...)`):

```ts
describe('applyPatchBuffer', () => {
  it('applies two patches to two different elements in one pass', () => {
    const tokens = {
      html: '<div><button data-gf-id="1">Buy</button><span data-gf-id="2">Free shipping</span></div>',
      css: '',
    };
    const result = applyPatchBuffer(tokens, [
      { dataGfId: '1', html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null },
      { dataGfId: '2', html: '<span data-gf-id="2">Ships free</span>', cssDeclarations: null },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.html).toContain('Buy now');
      expect(result.tokens.html).toContain('Ships free');
      expect(result.appliedIds).toEqual(['1', '2']);
    }
  });

  it('assigns distinct new descendant ids across two patches that each introduce new elements', () => {
    const tokens = { html: '<div><button data-gf-id="1">Buy</button><span data-gf-id="2">Free shipping</span></div>', css: '' };
    const result = applyPatchBuffer(tokens, [
      { dataGfId: '1', html: '<button data-gf-id="1">Buy<i>!</i></button>', cssDeclarations: null },
      { dataGfId: '2', html: '<span data-gf-id="2">Ships<i>!</i></span>', cssDeclarations: null },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newDescendantIds.length).toBe(2);
      expect(new Set(result.newDescendantIds).size).toBe(2);
    }
  });

  it('reports a mid-batch vanish when an earlier patch removes a later patch\'s target', () => {
    const tokens = { html: '<div><div data-gf-id="1"><span data-gf-id="2">inner</span></div></div>', css: '' };
    const result = applyPatchBuffer(tokens, [
      { dataGfId: '1', html: '<div data-gf-id="1">replaced, no more inner span</div>', cssDeclarations: null },
      { dataGfId: '2', html: '<span data-gf-id="2">this target is now gone</span>', cssDeclarations: null },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'vanished') {
      expect(result.dataGfId).toBe('2');
    } else {
      expect.fail('expected a vanished result');
    }
  });

  it('rejects a sanitize failure on any one patch as a whole-batch failure', () => {
    const tokens = { html: '<div><button data-gf-id="1">Buy</button></div>', css: '' };
    const result = applyPatchBuffer(tokens, [
      { dataGfId: '1', html: '<button data-gf-id="1">Buy</button></style><script>bad</script>', cssDeclarations: null },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sanitize-rejected');
  });

  it('rejects a patch whose html has more than one top-level element', () => {
    const tokens = { html: '<div><button data-gf-id="1">Buy</button></div>', css: '' };
    const result = applyPatchBuffer(tokens, [
      { dataGfId: '1', html: '<button data-gf-id="1">Buy</button><span>extra root</span>', cssDeclarations: null },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sanitize-rejected');
  });

  it('documents last-writer-wins: a later patch to an ancestor silently discards an earlier patch to its descendant', () => {
    const tokens = { html: '<div><div data-gf-id="5"><span data-gf-id="7">inner</span></div></div>', css: '' };
    const result = applyPatchBuffer(tokens, [
      { dataGfId: '7', html: '<span data-gf-id="7">patched inner</span>', cssDeclarations: null },
      { dataGfId: '5', html: '<div data-gf-id="5">replaced whole subtree, no span at all</div>', cssDeclarations: null },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.html).not.toContain('patched inner');
      expect(result.tokens.html).toContain('replaced whole subtree');
    }
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/componentPatchService.test.ts`
Expected: PASS — all pre-existing tests unchanged, plus the 6 new `applyPatchBuffer` tests.

- [ ] **Step 6: Commit**

```bash
git add lib/services/componentPatchService.ts test/componentPatchService.test.ts
git commit -m "refactor: extract applyPatchBuffer from applyElementPatch's per-patch logic"
```

---

### Task 3: `resolveComponentRegeneration()`

**Files:**
- Modify: `lib/services/componentPatchService.ts`
- Test: `test/componentRegenerationService.test.ts` (create)

**Interfaces:**
- Consumes: `ComponentDeltaResult` type and `generate()`'s widened signature from Task 1; `applyPatchBuffer`/`PatchInput`/`ApplyPatchBufferResult` from Task 2.
- Produces: `export type RegenerationResult = { ok: true; filename: string } | { ok: false; message: string };` and `export async function resolveComponentRegeneration(params: { basedOnAssetId: string; basedOnContent: string; instruction: string; styleId: string; componentType?: string; referenceImage?: ReferenceImagePayload; signal?: AbortSignal; providerOverride?: OllamaProviderOverride; }): Promise<RegenerationResult>` — Task 4 calls this directly.

- [ ] **Step 1: Add imports needed for this task**

At the top of `componentPatchService.ts`, add (verified against the file's current import block — it does not yet import `crypto`, `ZodError`, the DOM helpers, or `ReferenceImagePayload`):

```ts
import crypto from 'crypto';
import { ZodError } from 'zod';
import { parseDocument, DomUtils } from 'htmlparser2';
import type { Element as DomElement } from 'domhandler';
import type { ComponentDeltaResult } from '@/lib/services/ComponentGenerator';
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';
```

(`parseComponentHtml`/`combineComponentHtml`, `getComponentGenerator`, `fsPromises`, `path`, and `ComponentTokens` are already imported in this file — no changes needed for those.)

- [ ] **Step 2: Add the id→tag/class map helper**

Add this near the bottom of the file, after `ensureClassOnRoot`:

```ts
function isElementNode(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'tag';
}

/**
 * Builds a map of every data-gf-id in `html` to its tag name and classes, for the one-shot
 * corrective retry's prompt (an id integer alone gives the model nothing to anchor a correction
 * to -- it needs both halves).
 */
function buildIdTagClassMap(html: string): Record<string, { tag: string; classes: string[] }> {
  const dom = parseDocument(html);
  const elements = DomUtils.findAll(
    (el) => isElementNode(el) && typeof el.attribs['data-gf-id'] === 'string',
    dom.children,
  ) as DomElement[];
  const map: Record<string, { tag: string; classes: string[] }> = {};
  for (const el of elements) {
    const id = el.attribs['data-gf-id'];
    map[id] = { tag: el.name, classes: (el.attribs['class'] ?? '').split(/\s+/).filter(Boolean) };
  }
  return map;
}

function buildCorrectionMessage(reason: 'unresolved-id' | 'mid-batch-vanish', offendingId: string, validIdMap: Record<string, { tag: string; classes: string[] }>): string {
  const explanation = reason === 'unresolved-id'
    ? `The element with data-gf-id="${offendingId}" does not exist in the current document.`
    : `Your patch for data-gf-id="${offendingId}" is invalid because an earlier patch in your own response removed that element before this one could be applied.`;
  return `${explanation} Here is every valid data-gf-id in the current document, with its tag and classes, to help you target correctly: ${JSON.stringify(validIdMap)}. Please resend a corrected response.`;
}
```

- [ ] **Step 3: Add `resolveComponentRegeneration()` and its caps/types**

Add this at the bottom of `componentPatchService.ts`:

```ts
export type RegenerationResult =
  | { ok: true; filename: string }
  | { ok: false; message: string };

const PATCHES_COUNT_CAP = 20;
const PATCHES_BYTE_CAP_FRACTION = 0.5;

interface RegenerationLogEntry {
  basedOnAssetId: string;
  outcome: 'applied' | 'failed';
  failureStage?: 'final-read' | 'staleness' | 'sanitize-full' | 'ai-call';
  sourceUntrusted: boolean;
  originalMode?: 'patches' | 'full';
  appliedMode?: 'patches' | 'full';
  retryFired: boolean;
  initialRejectReason?: 'unresolved-id' | 'mid-batch-vanish';
  retryOutcome?: 'resolved' | 'still-failed';
  fallbackUsed: boolean;
  fallbackReason?: 'retry-failed' | 'sanitize-rejected' | 'cap-exceeded' | 'duplicate-id'
                 | 'empty-batch' | 'payload-too-large' | 'malformed-response' | 'unparseable-source';
  filename?: string;
  durationMs: number;
}

export async function resolveComponentRegeneration(params: {
  basedOnAssetId: string;
  basedOnContent: string;
  instruction: string;
  styleId: string;
  componentType?: string;
  referenceImage?: ReferenceImagePayload;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<RegenerationResult> {
  const startedAt = Date.now();
  const log: RegenerationLogEntry = {
    basedOnAssetId: params.basedOnAssetId,
    outcome: 'failed',
    sourceUntrusted: false,
    retryFired: false,
    fallbackUsed: false,
    durationMs: 0,
  };
  function finish(result: RegenerationResult): RegenerationResult {
    log.durationMs = Date.now() - startedAt;
    if (result.ok) { log.outcome = 'applied'; log.filename = result.filename; }
    console.log('resolveComponentRegeneration:', JSON.stringify(log));
    return result;
  }

  // Step 1: the snapshot to re-verify against at the end.
  const basedOnContentHash = hashDocument(params.basedOnContent);

  // Step 2: trust flag + the path source for the final recheck (step 10).
  const sourceAsset = await assetService.getById(params.basedOnAssetId);
  if (!sourceAsset || !sourceAsset.image_path
      || sourceAsset.image_path.includes('/') || sourceAsset.image_path.includes('\\') || sourceAsset.image_path.includes('..')
      || sourceAsset.output_kind !== 'component') {
    log.failureStage = 'final-read';
    return finish({ ok: false, message: 'The component this was based on could not be re-read.' });
  }
  const sourceFilePath = path.join(getProjectRoot(), 'storage', 'components', sourceAsset.image_path);
  const sourceUntrusted = sourceAsset.edited_externally === 1;
  log.sourceUntrusted = sourceUntrusted;

  async function callGenerateDelta(opts: { forceFull: boolean; correction?: string }): Promise<ComponentDeltaResult> {
    const result = await getComponentGenerator().generate(
      params.instruction, params.styleId, params.componentType, params.referenceImage,
      params.basedOnContent, params.signal, params.providerOverride, opts.correction, opts.forceFull,
    );
    return result as ComponentDeltaResult;
  }

  async function runFallback(reason: NonNullable<RegenerationLogEntry['fallbackReason']>): Promise<RegenerationResult> {
    log.fallbackUsed = true;
    log.fallbackReason = reason;
    let fallbackResult: ComponentDeltaResult;
    try {
      fallbackResult = await callGenerateDelta({ forceFull: true });
    } catch (e) {
      log.failureStage = 'ai-call';
      return finish({ ok: false, message: e instanceof Error ? e.message : 'Component regeneration failed.' });
    }
    return finalize(fallbackResult, true);
  }

  async function retryOnce(reason: 'unresolved-id' | 'mid-batch-vanish', offendingId: string, sourceTokens: ComponentTokens): Promise<RegenerationResult> {
    log.retryFired = true;
    log.initialRejectReason = reason;
    const validIdMap = buildIdTagClassMap(sourceTokens.html);
    const correction = buildCorrectionMessage(reason, offendingId, validIdMap);

    let retryResult: ComponentDeltaResult;
    try {
      retryResult = await callGenerateDelta({ forceFull: false, correction });
    } catch (e) {
      if (e instanceof ZodError) return runFallback('malformed-response');
      log.failureStage = 'ai-call';
      return finish({ ok: false, message: e instanceof Error ? e.message : 'Component regeneration failed.' });
    }
    return finalize(retryResult, true);
  }

  // Steps 4-9: resolve `result` into a final {html, css}, or route to a retry/fallback/failure.
  // `alreadyRetried` is true only on the recursive call made from `retryOnce` -- it caps the retry
  // at exactly one attempt (a second unresolved-id/vanish here goes straight to fallback).
  async function finalize(result: ComponentDeltaResult, alreadyRetried: boolean): Promise<RegenerationResult> {
    let finalTokens: ComponentTokens;

    if (result.mode === 'full') {
      if (alreadyRetried) log.retryOutcome = 'resolved';
      let html: string, css: string;
      try {
        html = assignElementIds(sanitizeComponentHtml(result.html));
        css = sanitizeComponentCss(result.css);
      } catch (e: any) {
        log.failureStage = 'sanitize-full';
        return finish({ ok: false, message: e?.message ?? 'Generated component failed validation.' });
      }
      finalTokens = { html, css };
    } else {
      let sourceTokens: ComponentTokens;
      try {
        sourceTokens = parseComponentHtml(params.basedOnContent);
      } catch {
        return runFallback('unparseable-source');
      }

      const patches = result.patches;
      if (patches.length === 0) return runFallback('empty-batch');
      if (patches.length > PATCHES_COUNT_CAP) return runFallback('cap-exceeded');
      const seenIds = new Set<string>();
      for (const p of patches) {
        if (seenIds.has(p.dataGfId)) return runFallback('duplicate-id');
        seenIds.add(p.dataGfId);
      }
      const totalBytes = patches.reduce((sum, p) => sum + p.html.length + (p.cssDeclarations?.length ?? 0), 0);
      if (totalBytes > (sourceTokens.html.length + sourceTokens.css.length) * PATCHES_BYTE_CAP_FRACTION) {
        return runFallback('payload-too-large');
      }

      const unresolved = patches.find((p) => !findElementByDataGfId(sourceTokens.html, p.dataGfId).found);
      if (unresolved) {
        if (alreadyRetried) { log.retryOutcome = 'still-failed'; return runFallback('retry-failed'); }
        return retryOnce('unresolved-id', unresolved.dataGfId, sourceTokens);
      }

      const patchInputs: PatchInput[] = patches.map((p) => ({ dataGfId: p.dataGfId, html: p.html, cssDeclarations: p.cssDeclarations ?? null }));
      const bufferResult = applyPatchBuffer(sourceTokens, patchInputs);
      if (!bufferResult.ok) {
        if (bufferResult.reason === 'sanitize-rejected') return runFallback('sanitize-rejected');
        if (alreadyRetried) { log.retryOutcome = 'still-failed'; return runFallback('retry-failed'); }
        return retryOnce('mid-batch-vanish', bufferResult.dataGfId, sourceTokens);
      }
      if (alreadyRetried) log.retryOutcome = 'resolved';
      finalTokens = bufferResult.tokens;
    }

    log.appliedMode = result.mode;

    // Step 10: the one point-in-time recheck this design performs.
    let latest: string;
    try {
      latest = await fsPromises.readFile(sourceFilePath, 'utf-8');
    } catch {
      log.failureStage = 'final-read';
      return finish({ ok: false, message: 'The component this was based on could not be re-read.' });
    }
    if (hashDocument(latest) !== basedOnContentHash) {
      log.failureStage = 'staleness';
      return finish({ ok: false, message: 'Component changed while regenerating — please try again.' });
    }
    const recheckAsset = await assetService.getById(params.basedOnAssetId);
    if ((recheckAsset?.edited_externally === 1) !== sourceUntrusted) {
      log.failureStage = 'staleness';
      return finish({ ok: false, message: 'Component changed while regenerating — please try again.' });
    }

    // Step 11: write once, no lock -- this filename cannot collide with anything else on disk.
    const filename = `component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`;
    const componentsDir = path.join(getProjectRoot(), 'storage', 'components');
    try {
      await fsPromises.mkdir(componentsDir, { recursive: true });
      await fsPromises.writeFile(path.join(componentsDir, filename), combineComponentHtml(finalTokens));
    } catch (e: any) {
      return finish({ ok: false, message: e?.message ?? 'Failed to write the regenerated component.' });
    }

    return finish({ ok: true, filename });
  }

  // Step 3: choose whether patches mode is even attempted.
  let aiResult: ComponentDeltaResult;
  try {
    aiResult = await callGenerateDelta({ forceFull: sourceUntrusted });
  } catch (e) {
    if (e instanceof ZodError) return runFallback('malformed-response');
    log.failureStage = 'ai-call';
    return finish({ ok: false, message: e instanceof Error ? e.message : 'Component regeneration failed.' });
  }
  // Set only here, not generically inside finalize() -- a malformed initial response never
  // reaches this line at all (it throws above, before aiResult is ever assigned), so a
  // subsequent successful fallback correctly leaves originalMode absent rather than reporting
  // the fallback's own mode as if it had been the original response's.
  log.originalMode = aiResult.mode;

  return finalize(aiResult, false);
}
```

Note: `crypto` and `fsPromises` are already imported in this file's `applyElementPatch()` section — confirm they're at module scope (they already are: `import fsPromises from 'fs/promises';` at the top; add `import crypto from 'crypto';` if it isn't already imported — check the existing import block first, since `ComponentGenerator.ts` imports it but `componentPatchService.ts` may not yet).

- [ ] **Step 4: Write the test file**

Create `test/componentRegenerationService.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { combineComponentHtml } from '@/lib/services/componentDocument';
import { resolveComponentRegeneration } from '@/lib/services/componentPatchService';
import type { ComponentDeltaResult } from '@/lib/services/ComponentGenerator';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-regenservice-'));
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
  vi.restoreAllMocks();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

async function mockGenerate(impl: ComponentDeltaResult | ((...args: any[]) => Promise<ComponentDeltaResult>)) {
  const generate = typeof impl === 'function' ? vi.fn(impl) : vi.fn().mockResolvedValue(impl);
  vi.spyOn(await import('@/lib/services/ComponentGenerator'), 'getComponentGenerator').mockReturnValue({
    generate,
    patchElement: vi.fn(),
  } as any);
  return generate;
}

async function seedSourceAsset(filename = 'source.html', editedExternally = false) {
  const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
  const document = combineComponentHtml({
    html: '<div><button data-gf-id="1" class="btn">Buy now</button><span data-gf-id="2">Free shipping</span></div>',
    css: '.btn { color: blue; }',
  });
  const filePath = path.join(tempRoot, 'storage', 'components', filename);
  await fsPromises.writeFile(filePath, document);
  const asset = await assetService.create({
    styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button',
    imagePath: filename, outputKind: 'component',
  });
  if (editedExternally) {
    await assetService.update(asset.id, 'user-1', { editedExternally: true }, false);
  }
  return { filePath, document, assetId: asset.id, styleId: style.id };
}

async function seedNestedSourceAsset(filename = 'nested-source.html') {
  const style = await styleService.create({ name: `style-${randomUUID()}`, createdBy: 'user-1', parameters: '{}' });
  const document = combineComponentHtml({
    html: '<div data-gf-id="1"><span data-gf-id="2">inner</span></div>',
    css: '',
  });
  const filePath = path.join(tempRoot, 'storage', 'components', filename);
  await fsPromises.writeFile(filePath, document);
  const asset = await assetService.create({
    styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a nested pair',
    imagePath: filename, outputKind: 'component',
  });
  return { filePath, document, assetId: asset.id, styleId: style.id };
}

function baseParams(source: Awaited<ReturnType<typeof seedSourceAsset>>, overrides: Partial<Parameters<typeof resolveComponentRegeneration>[0]> = {}) {
  return {
    basedOnAssetId: source.assetId,
    basedOnContent: source.document,
    instruction: 'make it blue',
    styleId: source.styleId,
    ...overrides,
  };
}

describe('resolveComponentRegeneration', () => {
  it('writes a full-mode result to a newly allocated file', async () => {
    const source = await seedSourceAsset();
    await mockGenerate({ mode: 'full', html: '<button data-gf-id="1">New</button>', css: '.x{color:red}' });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).not.toBe('source.html');
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('New');
    }
  });

  it('writes a successful multi-element patches-mode result with one write, not N', async () => {
    const source = await seedSourceAsset();
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    await mockGenerate({
      mode: 'patches',
      patches: [
        { dataGfId: '1', html: '<button data-gf-id="1">Buy now</button>', cssDeclarations: null },
        { dataGfId: '2', html: '<span data-gf-id="2">Ships free</span>', cssDeclarations: null },
      ],
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    if (result.ok) {
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('Buy now');
      expect(written).toContain('Ships free');
    }
  });

  it('retries once on an unresolved id, naming the offending id and a valid-id map, then succeeds', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const correction = args[7];
      if (!correction) {
        return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">bad</button>', cssDeclarations: null }] };
      }
      expect(correction).toContain('999');
      expect(correction).toContain('"1"');
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<button data-gf-id="1">Fixed</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('retries once on a mid-batch vanish (not just an unresolved id), and the retry can rescue it', async () => {
    // Needs an ancestor-descendant pair (id "1" contains id "2"), unlike seedSourceAsset's siblings
    // -- a vanish only happens when an earlier patch's replacement no longer contains a later
    // patch's target, which requires that nesting.
    const nested = await seedNestedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const correction = args[7];
      if (!correction) {
        return { mode: 'patches', patches: [
          { dataGfId: '1', html: '<div data-gf-id="1">no more inner span</div>', cssDeclarations: null },
          { dataGfId: '2', html: '<span data-gf-id="2">now vanished</span>', cssDeclarations: null },
        ] };
      }
      expect(correction).toContain('2');
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<div data-gf-id="1">fixed, no vanish</div>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(nested));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('accepts a retry that comes back mode:full as a normal success, not a further fallback', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const correction = args[7];
      if (!correction) {
        return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">bad</button>', cssDeclarations: null }] };
      }
      return { mode: 'full', html: '<button data-gf-id="1">Full rewrite instead</button>', css: '' };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2); // initial + retry, no third (fallback) call
    if (result.ok) {
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('Full rewrite instead');
    }
  });

  it('falls back to forceFull when the retry still fails, recording retry-failed', async () => {
    const source = await seedSourceAsset();
    await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '999', html: '<button data-gf-id="999">still bad</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const written = await fsPromises.readFile(path.join(tempRoot, 'storage', 'components', result.filename), 'utf-8');
      expect(written).toContain('Fallback');
    }
  });

  it('falls straight to fallback on a sanitize failure in patches mode, skipping the retry', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<button data-gf-id="1">Buy</button></style><script>bad</script>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2); // original attempt + fallback, no retry
  });

  it('falls back on an empty patch list without a retry', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back on a duplicate dataGfId without a retry', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [
        { dataGfId: '1', html: '<button data-gf-id="1">A</button>', cssDeclarations: null },
        { dataGfId: '1', html: '<button data-gf-id="1">B</button>', cssDeclarations: null },
      ] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when the patch batch exceeds the count cap', async () => {
    const source = await seedSourceAsset();
    const bigBatch = Array.from({ length: 21 }, (_, i) => ({ dataGfId: '1', html: '<button data-gf-id="1">x</button>', cssDeclarations: null }));
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: bigBatch };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when the patch batch exceeds the byte cap', async () => {
    const source = await seedSourceAsset();
    const hugeHtml = `<button data-gf-id="1">${'x'.repeat(5000)}</button>`;
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '1', html: hugeHtml, cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('falls back when basedOnContent does not parse in patches mode', async () => {
    const source = await seedSourceAsset();
    const generate = await mockGenerate(async (...args: any[]) => {
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      return { mode: 'patches', patches: [{ dataGfId: '1', html: '<button data-gf-id="1">x</button>', cssDeclarations: null }] };
    });

    const result = await resolveComponentRegeneration(baseParams(source, { basedOnContent: 'not a real component document' }));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('routes a malformed tool response (thrown ZodError) to the fallback, not a hard failure', async () => {
    const source = await seedSourceAsset();
    const { ZodError, z } = await import('zod');
    let call = 0;
    const generate = await mockGenerate(async (...args: any[]) => {
      call += 1;
      const forceFull = args[8];
      if (forceFull) return { mode: 'full', html: '<button data-gf-id="1">Fallback</button>', css: '' };
      // Simulate generate() throwing a ZodError on the first call.
      throw new ZodError([{ code: 'custom', path: ['mode'], message: 'invalid' } as any]);
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('never attempts patches mode when the based-on asset is edited_externally, for a style-sounding instruction', async () => {
    const source = await seedSourceAsset('source.html', true);
    const generate = await mockGenerate({ mode: 'full', html: '<button data-gf-id="1">Full</button>', css: '' });

    const result = await resolveComponentRegeneration(baseParams(source, { instruction: 'just make the button a bit bluer' }));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0];
    expect(call[8]).toBe(true); // forceFull
  });

  it('never attempts patches mode when the based-on asset is edited_externally, even for a plain instruction with no style/structure signal either way', async () => {
    const source = await seedSourceAsset('source.html', true);
    const generate = await mockGenerate({ mode: 'full', html: '<button data-gf-id="1">Full</button>', css: '' });

    const result = await resolveComponentRegeneration(baseParams(source, { instruction: 'update this component' }));

    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0];
    expect(call[8]).toBe(true); // forceFull -- trust overrides regardless of what the instruction sounds like
  });

  it('fails with a sanitize message on a bad mode:full response, not a fallback', async () => {
    const source = await seedSourceAsset();
    await mockGenerate({ mode: 'full', html: '<script>bad</script>', css: '@import "evil";' });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
  });

  it('fails closed with the staleness message when the based-on file changes during the AI call', async () => {
    const source = await seedSourceAsset();
    await mockGenerate(async () => {
      await fsPromises.writeFile(source.filePath, combineComponentHtml({ html: '<button data-gf-id="1">Changed underneath</button>', css: '' }));
      return { mode: 'full', html: '<button data-gf-id="1">New</button>', css: '' };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('changed while regenerating');
    const filesAfter = await fsPromises.readdir(path.join(tempRoot, 'storage', 'components'));
    expect(filesAfter).toEqual(['source.html']); // no new file written
  });

  it('fails closed with the staleness message when edited_externally flips during the AI call, even if bytes are unchanged', async () => {
    const source = await seedSourceAsset();
    await mockGenerate(async () => {
      await assetService.update(source.assetId, 'user-1', { editedExternally: true }, false);
      return { mode: 'full', html: '<button data-gf-id="1">New</button>', css: '' };
    });

    const result = await resolveComponentRegeneration(baseParams(source));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('changed while regenerating');
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/componentRegenerationService.test.ts`
Expected: PASS (15 tests). If `generate`'s mock argument indices (`args[7]` for `correction`, `args[8]` for `forceFull`) don't line up, check Task 1's final parameter order against `callGenerateDelta`'s call — they must match `generate(prompt, styleId, componentType, referenceImage, basedOnContent, signal, providerOverride, correction, forceFull)` positionally.

Then run: `npx tsc --noEmit` and `npx eslint lib/services/componentPatchService.ts test/componentRegenerationService.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/services/componentPatchService.ts test/componentRegenerationService.test.ts
git commit -m "feat: add resolveComponentRegeneration with retry-then-fallback and staleness recheck"
```

---

### Task 4: `worker.ts` call-site integration

**Files:**
- Modify: `worker.ts`
- Test: `test/workerComponentRegeneration.test.ts` (create)

**Interfaces:**
- Consumes: `resolveComponentRegeneration` from Task 3.

- [ ] **Step 1: Update the import block**

In `worker.ts`, change:

```ts
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
```

to:

```ts
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import { resolveComponentRegeneration } from '@/lib/services/componentPatchService';
```

- [ ] **Step 2: Update the `case 'component':` branch**

Replace:

```ts
      case 'component': {
        const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
        const providerOverride = buildOllamaOverride(options);
        result = await getComponentGenerator().generate(job.prompt, job.style_id, undefined, referenceImage ?? undefined, basedOnContent, undefined, providerOverride);
        break;
      }
```

with:

```ts
      case 'component': {
        const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
        const providerOverride = buildOllamaOverride(options);
        if (basedOnContent !== undefined && typeof options.basedOnAssetId === 'string') {
          const resolved = await resolveComponentRegeneration({
            basedOnAssetId: options.basedOnAssetId,
            basedOnContent,
            instruction: job.prompt,
            styleId: job.style_id,
            referenceImage: referenceImage ?? undefined,
            providerOverride,
          });
          if (!resolved.ok) throw new Error(resolved.message);
          result = { path: resolved.filename };
        } else {
          result = await getComponentGenerator().generate(job.prompt, job.style_id, undefined, referenceImage ?? undefined, basedOnContent, undefined, providerOverride) as { path: string };
        }
        break;
      }
```

(The `as { path: string }` cast on the `else` branch is safe: `basedOnContent` is `undefined` there by construction, and Task 1's `generate()` only ever returns `ComponentDeltaResult` when `basedOnContent` is defined.)

- [ ] **Step 3: Write the test file**

Create `test/workerComponentRegeneration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { assetService } from '@/lib/services/AssetService';
import * as ComponentPatchServiceModule from '@/lib/services/componentPatchService';
import * as ComponentGeneratorModule from '@/lib/services/ComponentGenerator';
import { processJob } from '../worker';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workercompregen-'));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('processJob component regeneration call-site branching', () => {
  it('calls resolveComponentRegeneration when basedOnAssetId resolves to readable content', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'existing.html'), '<html><body><button data-gf-id="1">Buy</button></body></html>');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'x',
      imagePath: 'existing.html', outputKind: 'component',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'make it blue',
      outputKind: 'component', options: { basedOnAssetId: existingAsset.id },
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration')
      .mockResolvedValue({ ok: true, filename: 'component-123-abcd1234.html' });

    await processJob(job);

    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      basedOnAssetId: existingAsset.id,
      instruction: 'make it blue',
      styleId: style.id,
    }));
    const updatedJob = await jobService.getById(job.id);
    expect(updatedJob?.status).toBe('complete');
    expect(updatedJob?.result_path).toBe('component-123-abcd1234.html');
  });

  it('falls back to the plain generate() call when basedOnAssetId is absent (first-generate, unchanged)', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button', outputKind: 'component',
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration');
    const generateSpy = vi.spyOn(ComponentGeneratorModule, 'getComponentGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.html', prompt: 'a button' }),
      patchElement: vi.fn(),
    } as any);

    await processJob(job);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(generateSpy).toHaveBeenCalled();
  });

  it('falls back to the plain generate() call when basedOnAssetId is present but unreadable', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'a button',
      outputKind: 'component', options: { basedOnAssetId: 'not-a-real-asset-id' },
    });

    const resolveSpy = vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration');
    const generateSpy = vi.spyOn(ComponentGeneratorModule, 'getComponentGenerator').mockReturnValue({
      generate: vi.fn().mockResolvedValue({ path: 'result.html', prompt: 'a button' }),
      patchElement: vi.fn(),
    } as any);

    await processJob(job);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(generateSpy).toHaveBeenCalled();
  });

  it('marks the job failed when resolveComponentRegeneration returns ok:false', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'existing.html'), '<html><body><button data-gf-id="1">Buy</button></body></html>');
    const existingAsset = await assetService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'x',
      imagePath: 'existing.html', outputKind: 'component',
    });
    const job = await jobService.create({
      styleId: style.id, createdBy: 'user-1', assetType: 'button', prompt: 'make it blue',
      outputKind: 'component', options: { basedOnAssetId: existingAsset.id },
    });

    vi.spyOn(ComponentPatchServiceModule, 'resolveComponentRegeneration')
      .mockResolvedValue({ ok: false, message: 'Component changed while regenerating — please try again.' });

    await processJob(job);

    const updatedJob = await jobService.getById(job.id);
    expect(updatedJob?.status).toBe('failed');
    expect(updatedJob?.error_message).toBe('Component changed while regenerating — please try again.');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/workerComponentRegeneration.test.ts`
Expected: PASS (4 tests).

Then run the full suite and the project's other required gates: `npx vitest run`, `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add worker.ts test/workerComponentRegeneration.test.ts
git commit -m "feat: wire resolveComponentRegeneration into the component regeneration job's call site"
```
