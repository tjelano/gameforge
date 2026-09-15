# Delta-Based Regeneration — Design

## Goal

Make "Regenerate with changes" cheaper and faster by having the AI emit a list of targeted
element-level edits instead of the entire HTML+CSS document, whenever the requested change only
touches existing elements' style or content. This is the second item on the Open WebUI comparison
backlog (see `project_openwebui_comparison_findings` memory) — the first item, element-specific
patching (shipped, PR #32), solved this for the click-to-select-one-element case; this generalizes
the same proven mechanism to the "regenerate with changes" flow, where today the AI is shown the
whole current document as context and asked to produce a whole new one, every time, regardless of
how small the actual requested change is.

Explicitly out of scope: the very first `generate()` call (no prior content exists, so there's no
delta to speak of), and true response streaming to the browser (a separate, larger piece of work —
see the companion "streaming responsiveness" spec, not yet written).

## Why this is worth doing

`ComponentGenerator.generate()`'s "regenerate with changes" path (`basedOnContent` present) already
sends the AI the entire current document as "starting point" context, then asks it to emit an
entirely new `{html, css}` document via the `emit_component` tool. Even a one-line wording tweak
resends and regenerates every element and every CSS rule in the component — cost and latency scale
with component size, not with the size of the actual requested change.

This is a recognized problem industry-wide, not a GameForge-specific gap: an Open WebUI maintainer
raised the identical pain point directly ("iterating on them can be slow, because the LLM has to
output the entire HTML page each time" — [Discussion #16181](https://github.com/open-webui/open-webui/discussions/16181))
but the proposed diff format was never implemented there — no prompt format, tool schema, or shipped
mechanism exists to adapt from. Google Stitch's marketing copy describes user-facing behavior
consistent with either a real delta mechanism or just well-prompted full regeneration; it's
closed-source, so there's no way to tell which, and no technical detail to borrow either way.

Broader research into LLM code-editing formats (Aider, Cursor, Cline, Codex, and academic work
comparing diff formats) surfaces two directly relevant findings:

1. **Diffs/patches help for localized changes and hurt for scattered ones.** One benchmark
   ("To Diff or Not to Diff? Structure-Aware and Adaptive Output Formats for Efficient LLM-based
   Code Editing", ACL 2026) reports ~25.7% output-token reduction on long-code edits when the
   change is localized (648 → 481 tokens in their benchmark), while noting diffs are *not* always
   shorter for scattered or extensive changes — matching this design's own scope decision below
   (style/content-only via patches; anything structural falls back to full regeneration).
2. **Mainstream tools all use text-based, context-anchored matching (SEARCH/REPLACE blocks, unified
   diffs), not stable-identifier targeting** — because general source files don't have persistent
   unique element ids. Their documented failure modes (duplicate-block ambiguity, whitespace drift,
   "anchors lack uniqueness") are exactly what GameForge's `data-gf-id` mechanism (already shipped,
   already proven via element-specific patching) sidesteps structurally: it's DOM-id lookup, not
   text-pattern matching, so none of those failure modes apply here. This design is not adapting an
   industry-standard format — no shipped reference implementation of an id-anchored approach was
   found — but the domain (structured HTML with server-assigned stable ids) affords a more reliable
   targeting mechanism than what general-purpose coding tools have to use.

## Architecture

**Tool schema fork.** When `basedOnContent` is `undefined` (first-time generation), `generate()`'s
behavior is completely unchanged — the existing `emit_component` tool, always full, same return
shape as today. When `basedOnContent` is present ("regenerate with changes"), `generate()` uses a
new tool, `emit_component_delta`, and **this caller's return type changes** — it's no longer the
bare `GeneratedComponent` shape, but the discriminated union below, and the worker's
regenerate-with-changes call site is updated to branch on `mode` via a new
`resolveComponentRegeneration()` function (see below — replaces an earlier draft's
`applyRegenerationResult()`, corrected once the actual call site was checked against the real code)
rather than writing the result directly, as it does for first-generate. This is not a change to
`generate()`'s parameter list for existing callers — it's the `basedOnContent`-present caller's own
return value that necessarily changes shape, since that's the whole point of this design:

```ts
type ComponentDeltaResult =
  | { mode: 'patches'; patches: Array<{ dataGfId: string; html: string; cssDeclarations: string | null }> }
  | { mode: 'full'; html: string; css: string };
```

(Implementation note: the `full` arm's `{html, css}` shape is identical to `emit_component`'s
existing schema — define it once as a shared schema fragment both tools reference, rather than two
independently-maintained copies that can silently drift apart.)

The prompt instructs the model to prefer `patches` mode when the instruction only touches existing
elements' style or content, and `full` mode when it requires adding, removing, or reordering
elements. The model decides per-request; there is no separate classification call (that would cost
more than it saves — see Approach B, rejected below).

**Precisely what the schema enforces, vs. what the prompt merely guides.** A `patches` entry can only
ever reference an *existing* `dataGfId` — there is no field in the schema for inserting a *new
top-level sibling* element, so that specific case is structurally inexpressible in patches mode,
independent of whether the model follows the prompt's guidance. That is the *only* thing the schema
itself rules out. Everything else styled as "structural changes fall back to full" earlier is prompt
guidance, not a schema guarantee — restructuring content *within* one already-targeted element's own
subtree is schema-legal, and that includes **adding** a child there (e.g. "add a badge to this
card" targets the card, and a new badge inside it is just new content in the card's own `html`), not
only removing one — this is exactly what single-element patching has always allowed, not a new gap
this batch design introduces, but it does mean "style/content only" (the Goal section's framing) is
a description of the *intended* scope via prompt instruction, not a hard boundary the schema itself
draws; the schema's actual, narrower guarantee is just "no new top-level sibling."
`assignElementIds`'s existing single-root-per-fragment requirement (already enforced, already tested)
rejects a patch whose `html` contains multiple top-level siblings before it ever reaches storage.

**Correction (2026-09-15, before planning began): "regenerate with changes" does not edit an
existing asset in place — verified directly against the real call site, not assumed.** An earlier
draft of this section modeled `applyRegenerationResult()` on `applyElementPatch()`'s own two-phase
unlocked-precheck/locked-recheck-and-write shape, on the theory that batching patches for regenerate-
with-changes is "the same operation, generalized." That premise doesn't hold, checked against three
places in the real codebase:

- The regenerate modal's own copy (`app/dashboard/assets/[id]/page.tsx`'s `handleRegenerate` UI):
  "Creates a new job based on this asset — **the original is never changed**."
- `worker.ts`'s `case 'component':` branch calls `getComponentGenerator().generate()`, which always
  allocates and writes a **brand-new** file (`component-${Date.now()}-${crypto.randomUUID().slice(0,
  8)}.html`) — never the based-on asset's own file.
- `app/api/assets/from-job/route.ts` — promoting a job's result always `INSERT`s a **new** `assets`
  row with a new id. There is no code path that updates the based-on asset's row or file.

So a regenerate-with-changes job is fork-and-create-new, not edit-in-place: it has no `assetId` of
its own until a human promotes it afterward, and the file it's about to write doesn't exist yet, so
nothing else can be concurrently writing *it* — unlike `applyElementPatch()`'s target, which is an
already-promoted, potentially-concurrently-viewed asset. This removes most of what made the original
design's Phase 2 what it was: **no `withFileLock`, no DB re-query of an `assetId`'s trust flag on the
output (there is no output `assetId` yet), no prompt-history write (there is no asset row to record
history against — the eventual promoted asset's `prompt` is set directly from `job.prompt` at
promotion time, not accumulated the way `applyElementPatch()`'s target's `prompt` field is).** What
*does* still matter, and what the corrected design below keeps: the based-on asset's own trust flag
(its `data-gf-id`s can't be trusted for patch-targeting if it was hand-edited), and a single
point-in-time check that the based-on asset's content didn't change out from under the AI call — see
the numbered steps and the two sections after them.

**Signature:**

```ts
export type RegenerationResult =
  | { ok: true; filename: string }   // storage/components/<filename> — same shape the worker
                                      // already expects from generate()'s existing {path} result
  | { ok: false; message: string };

export async function resolveComponentRegeneration(params: {
  basedOnAssetId: string;
  basedOnContent: string;       // already read by worker.ts's existing loadBasedOnContent() —
                                 // this function does not re-read it at the start, only once more,
                                 // at the very end (see step 10 below)
  instruction: string;          // job.prompt
  styleId: string;
  componentType?: string;
  referenceImage?: ReferenceImagePayload;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<RegenerationResult>
```

Lives in `componentPatchService.ts`, alongside `applyPatchBuffer` (shared with `applyElementPatch()`
— see below for why `readVerifiedTokens` is, on reflection, *not* similarly shared) — not in
`ComponentGenerator.ts` or `worker.ts` — since it needs the same import set (`assetService`, the
sanitize/element-tree helpers) `componentPatchService.ts` already has, and it's the same "splice AI
output into a real document" responsibility `applyElementPatch()` already lives there for.

(`message: string`, not a structured error-code union like `PatchError` — see Error Handling below.
A hash mismatch at the final recheck produces the staleness message; a failed re-read produces a
distinct "component could not be re-read" message; a sanitize failure on a `full` result produces
that failure's own message. There is no trust-rejection message anymore — see the numbered steps:
an untrusted based-on asset no longer fails the job, it just skips straight to full mode.)

**`generate()`'s existing callers and behavior are unchanged; it gains two new optional
parameters** to make the retry/fallback callable at all (this was previously unspecified — verified
there's no existing method with this shape): `correction?: string` (appended to the built prompt
before the tool call, regardless of provider — a general mechanism, not the Ollama-only
`providerOverride.correctionRequested`) and `forceFull?: boolean` (when true, uses the plain
`emit_component` tool even though `basedOnContent` is present — this is what the fallback call uses,
so a full-regenerate attempt can't itself come back as `mode: 'patches'` and recurse). **When
`basedOnContent` is present, `generate()`'s return type is uniformly `ComponentDeltaResult` regardless
of `forceFull`** — a forced-full call still comes back shaped `{mode: 'full', html, css}`, never the
legacy bare `GeneratedComponent`, so `resolveComponentRegeneration()` never has to special-case which
tool produced a given result — the caller (not `generate()`) is responsible for sanitizing and
writing that `{html, css}` (mirroring how `patchElement()` already returns raw validated content and
leaves splicing/sanitizing/writing to `componentPatchService.ts`, not to `ComponentGenerator.ts`
itself). **This is a real behavior change to `generate()` itself, stated explicitly because a
reviewer flagged the earlier wording as ambiguous:** today, `generate()` always allocates a filename
and writes it for every call, including today's basedOnContent-present regenerate calls. After this
change, **whenever `basedOnContent` is present, `generate()` never writes to disk at all**, regardless
of the resulting mode (`patches` or `full`) or which of the three calls in the flow below produced it
(the model's first response, the one-shot retry, or the `forceFull` fallback) — every write on this
path happens exactly once, in `resolveComponentRegeneration()`'s own step 11. `generate()`'s
first-generate behavior (`basedOnContent` absent) is genuinely unchanged: it still allocates and
writes its own file, exactly as today. **The raw tool response is validated with the same
`z.object(...).parse()` /
discriminated-union pattern the existing tools already use** (`ComponentGenerator.ts`'s `z.object({
html: z.string(), cssDeclarations: z.string().nullish() }).parse(toolInput)` for the single-patch
tool), **with `.strict()` on both arms of the discriminated union.** This is a correction from an
earlier draft, verified against Zod's actual default behavior rather than assumed: bare `z.object()`
uses "strip" mode — unknown keys are silently *dropped*, not rejected, and a payload carrying
`mode: 'full'` alongside a stray `patches` array would parse cleanly with `patches` quietly
discarded, not throw. `.strict()` on each arm is what actually makes "both arms present" or "unknown
fields" throw, matching what a missing `mode` already does under a bare discriminated union.
**Rather than a hard job failure, a response that fails this validation is routed to the same
`forceFull` fallback as the other batch-level rejections** (`fallbackReason: 'malformed-response'`) —
an earlier draft failed the job outright here, but that wastes exactly the recovery path this whole
design built for every other failure mode: a malformed delta response most often means the *provider*
struggled with the discriminated-union schema (this matters most for Ollama, whose tool-calling
doesn't reliably honor schema discriminators the way Claude's does — GameForge's codebase already has
a distinct "didn't call the tool" retry for this provider's unreliability elsewhere), not that
regeneration itself is impossible — `forceFull` uses the plain, already-proven `emit_component`
schema, sidestepping the discriminated-union complexity entirely. A transport/network failure on
*that* fallback call is still a plain AI-call failure (see Error Handling) — there's no fallback
beneath the fallback.

**`applyElementPatch`'s own `readVerifiedTokens` closure is untouched by this design** — a correction
from an earlier draft, which planned to extract it to module scope specifically so
`resolveComponentRegeneration()` could reuse it. Checked against what step 10 (below) actually needs
and doesn't hold up: `readVerifiedTokens` requires the read to also *parse* successfully
(`parseComponentHtml`) or it reports a failure, but step 10's recheck must not impose that requirement
— a based-on document that fails to parse is completely fine for a `mode: 'full'` result (full mode
never parses `basedOnContent` at all; it's only ever used as unparsed prompt text), so reusing a
helper whose contract *requires* parseability would incorrectly fail full-mode jobs whose source
happens not to parse. Step 10 instead does its own plain `fsPromises.readFile` + `hashDocument`
comparison, no parsing involved — see below. `applyElementPatch()` keeps its private closure exactly
as shipped; nothing in this feature edits that file's existing, already-reviewed function.

`resolveComponentRegeneration()` never independently re-reads `basedOnContent` at the *start*, either
— `worker.ts`'s existing `loadBasedOnContent()` already did that read, which is why `basedOnContent`
arrives as a plain string parameter (see the Worker integration section below) rather than this
function performing its own first read. **This equivalence is verified, not assumed:**
`loadBasedOnContent()` (`worker.ts`) reads `fsPromises.readFile(path.join(getProjectRoot(), 'storage',
subdir, asset.image_path), 'utf-8')` for a component asset — the identical path shape and read
mechanism step 10's own re-read uses for `storage/components/<filename>` — so `hashDocument()` (a pure
string hash) produces the same value for both reads of unchanged content.

**Worker integration** — this is the piece an earlier draft left unstated (flagged directly: without
it, the correction wasn't plannable). `worker.ts`'s `case 'component':` branch already calls
`loadBasedOnContent(options.basedOnAssetId, job.id)`, which returns `undefined` on any read failure,
a missing/invalid `basedOnAssetId`, or an asset whose `output_kind` isn't `component` — exactly the
same "best-effort, never throws" contract it already has today, unchanged by this design. Only when
that call returns a **defined** string does the delta path engage at all:

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
    result = await getComponentGenerator().generate(job.prompt, job.style_id, undefined, referenceImage ?? undefined, basedOnContent, undefined, providerOverride);
  }
  break;
}
```

Throwing on `resolved.ok === false` (rather than adding new error-handling machinery) routes the
failure through `processJob`'s existing `catch` → `markJobFailed`, unchanged. The `else` branch is
exactly today's existing call — first-generate (`basedOnAssetId` absent) and "based-on content
unreadable, continue without it" (`loadBasedOnContent` returned `undefined` for a *present*
`basedOnAssetId`) both already degrade to a plain full generation today, and keep doing so unchanged:
this design only ever engages once a real, readable `basedOnContent` string exists to build a delta
from.

**A shared, pure `applyPatchBuffer(tokens, patches)` helper** does the actual per-patch work, mirroring
`applyElementPatch()`'s own existing per-patch sequence exactly (this was missing from an earlier
draft — sanitization is not optional): the `RAW_MARKER_PATTERN` head/body-escape check,
`sanitizeComponentHtml`, `assignElementIds` (with `startAt` recomputed from the current buffer state
before each patch — reusing pre-batch max across multiple patches that each introduce new descendants
would silently produce colliding ids), `ensureClassOnRoot`, `sanitizeComponentCss` +
`replaceOrAppendRuleForClass` for the CSS side, then splice via `replaceElementByDataGfId`. A
sanitize failure on any patch is a **batch-level rejection** (same treatment as empty/duplicate/cap —
skips the corrective retry, since "here are valid ids" doesn't address unsafe content, and routes
straight to the fallback), not an id-resolution failure. This helper is call-site-agnostic — it knows
nothing about locks, asset ids, or where its output eventually gets written, which is exactly what
lets `applyElementPatch()`'s existing use and `resolveComponentRegeneration()`'s new one share it
unchanged.

`(tokens, patches)` really is the helper's complete input set — verified against the real code, not
assumed: `gfClass` (`componentPatchService.ts:113`) is computed as `` `gf-${dataGfId}` `` only, no
`styleId`/`componentType` or any other value involved anywhere in the class-name or splice logic, so
neither of those needs to be threaded into this helper despite `resolveComponentRegeneration()`
carrying them for other purposes (building the AI prompt).

This whole helper is a **pure function of its inputs** — every function it calls
(`sanitizeComponentHtml`, `assignElementIds`, `findElementByDataGfId`, `replaceElementByDataGfId`) is
itself pure, with no clock, randomness, or global mutable state anywhere in the chain (verified by
reading each). It never touches disk or the AI. Purity is what makes it safe to call more than once
in the same request without side effects to unwind: at most twice total in
`resolveComponentRegeneration()`'s flow below — once against the model's first `patches` response,
and again only if the one-shot corrective retry produces a *different* patch list to try — rather
than any dry-run/real-run duality (an earlier draft's two-phase locked/unlocked split needed exactly
that duality; this design doesn't, since there is no lock to be on the wrong side of).

**Known, accepted limitation, not detected or prevented: last-writer-wins for overlapping targets
within one batch.** The dry run catches a *forward* invalidation (an earlier patch removes a *later*
patch's target — "mid-batch vanish," above). It does not catch the *reverse*: if patch A edits
descendant element 7, and a *later* patch B in the same batch replaces element 5's whole subtree
(element 7's ancestor), B's write silently discards A's edit to 7 with no error and no signal — B's
own target (5) still resolves fine, nothing "vanishes" from the check's perspective. Detecting this
fully would mean asserting, after applying the batch, that every already-applied target's element
still exists unmodified in the final buffer — real additional complexity for what requires two
patches in the same batch where one's target is a structural ancestor of another's, ordered
ancestor-then-descendant, and the ancestor's own patch happens to touch that specific descendant's
region. Given how narrow the trigger condition is, and that the output is still a well-formed,
sanitized document (just possibly missing one of the intended edits, not corrupted), this is
documented as a known gap rather than built out further in this pass — worth a follow-up if it ever
proves to matter in practice, matching this spec's existing precedent of naming rather than solving
the concurrency gap named after the numbered steps below.

**Batch size is capped on both count and total payload bytes.** A count-only cap (e.g. 20 patches,
per the batch-level-rejection step below) doesn't guard the feature's actual cost goal — a handful of
patches can each carry an arbitrarily large `html`/`cssDeclarations` and collectively exceed what a
full regenerate would have cost. A second cap rejects the batch (same `fallbackReason`-tagged,
no-retry treatment as count/duplicate/empty) if the summed byte length of all patches' `html` +
`cssDeclarations` exceeds a fraction of the current document's own size (exact threshold is an
implementation-plan detail, not pinned here) — `fallbackReason: 'payload-too-large'`.

`resolveComponentRegeneration()`'s flow, single-pass (no lock, no separate phases — nothing else can
be writing the file this function is about to create, so there's no "recheck after acquiring a lock"
step; the only thing worth re-checking is whether the *based-on* asset moved during the AI call,
which the last step below does directly):

1. `basedOnContentHash = hashDocument(params.basedOnContent)` — the snapshot to re-verify against at
   the end. Not re-derived from a fresh read here: `params.basedOnContent` is exactly what
   `worker.ts`'s existing `loadBasedOnContent()` already read, and re-reading it again immediately
   would only reproduce the same string absent a genuine intervening change.
2. `assetService.getById(params.basedOnAssetId)` once. Captures `sourceUntrusted = asset?.edited_externally
   === 1`, and also **captures `asset.image_path` and `asset.output_kind` for step 10's own re-read**
   — `resolveComponentRegeneration()` otherwise has no way to know which file to re-read at the end
   (an earlier draft's step 10 referenced "the file at `basedOnAssetId`'s path" without ever deriving
   one; this is that fix). Applies the same `'/','\\','..'` traversal guard `loadBasedOnContent()`
   already uses on `image_path` before trusting it as a path segment.
3. If `sourceUntrusted`: call `generate(..., forceFull: true, basedOnContent: params.basedOnContent,
   ...)` immediately — patches mode is never attempted. A hand-edited based-on asset's `data-gf-id`s
   can't be trusted for id-anchored targeting, but full mode doesn't depend on them at all (it only
   uses `basedOnContent` as unparsed prompt text), so this design can steer around the problem up
   front rather than failing the job the way `applyElementPatch()`'s own single-element target must
   (that function has no less-precise fallback available for one specific click-to-select id; this
   one always has full regeneration to fall back to). This is a mode-selection input, not a failure —
   logged via `sourceUntrusted: true` in Observability below, not a `failureStage`.
   Otherwise: call `generate(...)` normally (delta-capable, `forceFull` omitted), letting the model
   choose `patches` vs `full` per its own prompt guidance.
4. If the response is `mode: 'full'` (from either branch of step 3): skip straight to step 9 — no ids
   to resolve, no batch to simulate.
5. If `mode: 'patches'`: parse `params.basedOnContent` via `parseComponentHtml`. A parse failure here
   (the based-on file is missing a `<style>`/`<body>` pair — e.g. hand-edited into a shape
   `parseComponentHtml` doesn't recognize) is a **batch-level rejection**, `fallbackReason:
   'unparseable-source'`, straight to step 8 — there's no way to resolve `dataGfId`s against a
   document that doesn't parse, and (unlike a genuinely untrusted source) this can't be detected
   up front in step 3 since it's a property of the file's *shape*, not its `edited_externally` flag.
6. Otherwise, check batch-level validity first: empty list, over the count cap (e.g. 20), duplicate
   `dataGfId`s, or over the byte cap. **None of these get the corrective retry in step 7** — same
   reasoning as the original design: a "here are the valid ids" correction doesn't meaningfully
   address "you sent zero patches" or "you sent the same id twice." These route straight to step 8
   with `fallbackReason` set to `'empty-batch'` / `'cap-exceeded'` / `'duplicate-id'` /
   `'payload-too-large'` respectively. Otherwise, resolve every `dataGfId` against the parsed tokens
   (via `findElementByDataGfId`) and run `applyPatchBuffer` once against a copy of them. A sanitize
   failure here is also a batch-level rejection (`fallbackReason: 'sanitize-rejected'`), straight to
   step 8, no retry — same reasoning as empty/duplicate/cap. An unresolved id or a mid-batch vanish
   `applyPatchBuffer` discovers (patch A's new content for element 5 no longer contains the element-7
   descendant patch B independently targets) is a different category — the response is otherwise
   well-formed, just references the wrong target — and *does* get the retry.
7. If step 6 found an unresolved id or a mid-batch vanish: issue the **one-shot corrective retry** —
   `generate()` called again with `correction` set to a message naming the *specific offending ids*
   (unresolved, or the id that vanished and what removed it) alongside a **map of every valid current
   id to its tag/class** (an id integer alone gives the model nothing to anchor a correction to — this
   needs both halves). **The retry may legitimately come back `mode: 'full'`** (the model decides,
   given the correction, that a full rewrite is simpler) — accept that as success (go to step 9), not
   as another failure to retry or fall back from. If it comes back `mode: 'patches'` again, repeat
   step 6's resolve-and-`applyPatchBuffer` exactly once more against the retry's patches — no second
   retry either way. Whether this was triggered by an unresolved id or a vanish, and whether it then
   succeeds or still fails, is recorded as two separate observability fields (`initialRejectReason`,
   `retryOutcome` — see Observability) rather than one overloaded enum value.
8. **Fallback:** if nothing so far produced a validated result — a batch-level rejection that skipped
   the retry, or a retry that still didn't resolve — call `generate(..., forceFull: true)` with the
   *original* `params.instruction`, against the same `params.basedOnContent`. This always *attempts* a
   full-mode call; if that call itself fails outright (network/API error), it's a plain AI-call
   failure like any other (see Error Handling), not a further fallback — there is no fallback beneath
   the fallback.
9. **Sanitize:** for a `full` result (from step 3, 4, 7, or 8), run `sanitizeComponentHtml` +
   `assignElementIds` (full-write mode, no `preserveRootId` — mirrors what `generate()`'s own
   first-generate path already does internally today) and `sanitizeComponentCss`. A sanitize failure
   here is a hard job failure (mirrors today's existing `generate()` full-write failure handling) —
   unlike a `patches`-mode sanitize failure (step 6), there is no fallback beneath `forceFull` itself.
   For a `patches` result (from step 6 or 7), its already-sanitized-and-spliced tokens from
   `applyPatchBuffer` are the result directly — no further sanitize step needed.
10. **The one point-in-time recheck this design performs:** immediately before writing, re-read the
    file at step 2's captured `image_path` (same path shape `loadBasedOnContent()` used: `storage/
    components/<image_path>`) via a plain `fsPromises.readFile` — **not** the shared
    `readVerifiedTokens` helper, since that helper's contract also requires the read to parse
    successfully, which this recheck must not impose (see the note above `applyElementPatch`'s closure
    is untouched). Re-hash the raw string via `hashDocument` and compare against step 1's
    `basedOnContentHash`. A read failure (not-found, or any other fs error) fails the job with a
    distinct "the component this was based on could not be re-read" message (`failureStage:
    'final-read'`). A hash mismatch fails the job with the staleness message (`failureStage:
    'staleness'`) — this is the main concurrency gap this design closes: a click-to-select
    `applyElementPatch()` call landing on the *same* `basedOnAssetId` while this function's
    `generate()` call (steps 3/4/7/8) was in flight. **Also re-query `assetService.getById` for
    `edited_externally` at this same point** — a cheap second read (step 2 already made one; this one
    is not the expensive thing this design avoids, which was the lock, not a DB round-trip) that a
    hash match alone doesn't make redundant: verified directly against the one real setter of this
    flag (`app/api/assets/[id]/component/route.ts`'s `PATCH` handler) that it *always* rewrites the
    file in the same request it flips the flag — but that write isn't guaranteed to change the file's
    *bytes* (a user can re-paste content identical to what's already stored while checking
    "trust as edited"), so a hash match does not strictly prove the flag didn't just flip. If it now
    reads `1` and step 2 read `0` (or vice versa) — mode was chosen against a trust assumption that's
    since changed — fail the job with the staleness message too, same `failureStage`, since the
    underlying concern (this was resolved against a based-on asset that has since moved) is the same
    one word for either kind of change.
11. **Write:** allocate a fresh filename — `` `component-${Date.now()}-${crypto.randomUUID().slice(0,
    8)}.html` `` — the same scheme `ComponentGenerator.ts`'s own `generate()` already uses for every
    write it makes today. `combineComponentHtml` the final `{html, css}`, `fsPromises.mkdir` +
    `writeFile` it, no lock: this filename cannot collide with anything else on disk, the same
    guarantee `generate()`'s own unlocked writes already rely on for first-generate and today's
    full-regenerate — nothing new here, just the existing no-lock-needed-for-a-fresh-name pattern.
12. Return `{ ok: true, filename }`.

## A pre-existing gap this design narrows, but doesn't fully solve

Today, `generate()`'s regenerate-with-changes path has **no staleness check at all**: the worker reads
`basedOnContent` once, and if the based-on asset's file changes before the AI call finishes, the
regeneration proceeds on a stale snapshot without ever knowing it — not "silently clobbering" the
based-on file (an earlier draft of this section claimed that; it's wrong, since the write target was
never the based-on file even before this design — full regenerate has always written to a brand-new
file, same as first-generate), but silently producing a result that may no longer match what the user
is currently looking at, written to a new file the user has to notice and evaluate on its own merits.
This design's step 10 above closes that gap **for the AI-call window specifically** — the narrow
period between reading `basedOnContent` and the (possibly retried, possibly-fallback) `generate()`
call resolving. It does not, and can't, do anything about staleness accrued *before* the worker even
picks up the job (the gap between a user clicking "Queue regeneration" and the worker actually
processing it) — that gap is pre-existing, unrelated to this design, and out of scope here.

**Also worth naming, explicitly not solved here:** step 10's recheck is a single point-in-time
comparison, not a lock — there is no lock anywhere in this design, since the file being written is
freshly allocated and nothing else could be writing it. A concurrent `applyElementPatch()` edit to the
*based-on* asset landing in the gap between step 10's recheck passing and step 11's `writeFile`
completing is not caught — there is no *second* recheck after the first one passes, only the write
itself (which does involve its own awaits — `mkdir`, then `writeFile` — but nothing that re-reads or
re-verifies the based-on asset in between). This is a real, named gap, but it's a **strict
improvement** over today's shipped behavior, which has no recheck at all anywhere on this path — not
a new or widened risk the way an earlier draft of this spec worried its own (since-removed) lock might
introduce.

## Approaches considered

**A (chosen): single AI call, discriminated-union response, id-anchored patches.** Described above.
Reuses the already-shipped, already-reviewed element-patch mechanism generalized to a batch, and
follows the same *shape* as the already-shipped correction-request retry pattern (though not the
literal mechanism — see Architecture for why `generate()` needs its own new `correction`/`forceFull`
parameters rather than reusing the Ollama-only `providerOverride.correctionRequested` field). No new
infrastructure beyond that.

**B (rejected): two-call classify-then-route.** A cheap first call classifies "style-only vs.
structural," then routes to a patch-list tool or the full-regenerate tool. Cleaner separation of
concerns in isolation, but adds a second AI call to every single request — directly working against
the cost/latency goal this design exists to serve, unless that classifier call were dramatically
cheaper than generation itself (no such cheaper-model tier is currently wired into GameForge's
provider selection).

**C (rejected): post-hoc server-side diffing.** Keep the AI generating the full document every time;
diff old vs. new server-side after the fact and convert same-structure results into a patch-style
write. Doesn't reduce AI token cost at all — the AI still generates the entire document either
way — so it fails the actual goal; it would only change write mechanics, not the expensive part.

## Error handling

Deliberately simple — this is a background job (`worker.ts`'s `processJob`), not the interactive
patch-element HTTP flow, so it doesn't need `PatchError`'s structured-code taxonomy (that existed
because the UI branches its rendering per code; a job just succeeds or fails with a message, same as
every other job failure already works). `worker.ts`'s call site wraps `resolveComponentRegeneration`
in a `throw new Error(resolved.message)` on `ok: false`, so it flows through `processJob`'s existing
catch-and-`markJobFailed` path unchanged — no new error-handling machinery needed in `worker.ts`
itself.

- AI call fails outright (network/API error, or the tool-not-called corrective retry still doesn't
  produce a valid call): job fails, same as `generate()`'s existing failure handling.
- The based-on asset's content can't be re-read at the final check (step 10) — not-found or any other
  fs error: job fails with a distinct "component this was based on could not be re-read" message
  (`failureStage: 'final-read'`) — different from staleness below, since this isn't "it changed," it's
  "it can't be read at all anymore."
- **An `edited_externally === 1` based-on asset no longer fails the job.** An earlier draft treated
  this the same way `applyElementPatch()`'s own rejection does (hard failure, same message text). That
  doesn't fit here: `applyElementPatch()` has no fallback for its one specific click-to-select target,
  but a regenerate-with-changes job always has full regeneration available, and full mode never needs
  trustworthy `data-gf-id`s (it only uses `basedOnContent` as unparsed prompt text). So this is now a
  mode-selection input (step 3: skip patches mode, force full immediately) rather than a failure —
  logged as `sourceUntrusted: true`, not a `failureStage`.
- Patches mode has an unresolvable id, a mid-batch vanish `applyPatchBuffer` discovers, a dry-run
  sanitize failure the one-shot corrective retry doesn't resolve (sanitize failures skip the retry
  entirely and go straight to fallback, same as the batch-level rejections below), an unparseable
  based-on document (step 5), or a batch-level rejection (empty, duplicate ids, over the size/byte
  cap — these also skip the retry, per step 6): **not a job failure** — falls through to a
  full-regenerate attempt automatically (step 8), using the same instruction against the still-current
  `basedOnContent`. Logged server-side (`console.error`) for future debugging/cost-tracking visibility
  (see Observability, below — the log records *which* of these reasons triggered the fallback, not
  just that one did). Not surfaced to the user as an error — the job still succeeds from their
  perspective.
- **Staleness detected at the final recheck (step 10) — either a content hash mismatch or the
  `edited_externally` flag having flipped since step 2:** job fails closed, `status: 'failed'`, a
  clear `error_message` ("Component changed while regenerating — please try again"). This protects
  only the window between the worker reading `basedOnContent` and the (possibly retried/fallback) AI
  call resolving — it does not, and can't, protect the separate, pre-existing, out-of-scope gap between
  a user queuing the job and the worker picking it up (see the section above). No auto-requeue: this
  matches the only precedent for "something raced" already in this codebase — the interactive flow's
  `ELEMENT_CHANGED` case, which fails closed and lets the user re-select and retry rather than guessing
  on their behalf. There is no existing pattern of a job silently re-queuing itself on a detected
  conflict anywhere in this codebase; the existing "Retry" button on a failed job is explicitly
  user-initiated, and this follows that same shape.

  **Why this gets different treatment than the unresolvable-id fallback above, even though both are
  "something didn't go as expected":** they're different failure classes. Staleness means the
  based-on asset moved *externally* — another job, another user, a live click-to-select edit — during
  the AI call; guessing what to do about that (auto-requeue, or silently proceeding) risks acting on
  content that's no longer current. An unresolvable id means the model's own patch response didn't
  line up with a document that *hasn't* moved — the full-regenerate fallback re-runs the same,
  still-valid instruction against the same, still-current content, using a code path this system
  already trusts (first-generate's full-write). One case has genuine ambiguity about what's current;
  the other doesn't.
- Sanitize/validation failure on a **`mode: 'full'`** response (step 9): reuses the existing
  `sanitizeComponentHtml`/`sanitizeComponentCss` error paths, job fails with that message, same as
  today's `generate()` full-write. (A sanitize failure on a `mode: 'patches'` response is handled
  differently — see the fallback bullet above; it doesn't fail the job, it triggers full-regenerate.)
- Malformed tool response (doesn't cleanly match either `ComponentDeltaResult` arm under the
  `.strict()` validation — see Architecture): **not a job failure** — routes to the same `forceFull`
  fallback as the other batch-level rejections (`fallbackReason: 'malformed-response'`), since the
  simpler `emit_component` schema the fallback uses is far more likely to succeed than retrying the
  same discriminated-union schema that just failed to parse. Only a transport/network failure on that
  fallback call itself falls into the first bullet above.
- Disk write failure (step 11): same as today.

## Observability

The entire premise of this feature is that patches mode is cheaper than full regeneration — without
visibility into how often it's actually chosen, retried, or abandoned, there's no way to tell whether
it's working or quietly making things worse (patch attempt + failed retry + full fallback costs more
than just going straight to full). `resolveComponentRegeneration()` logs one structured line per call:

```ts
{
  basedOnAssetId: string;
  outcome: 'applied' | 'failed';
  failureStage?: 'final-read' | 'staleness' | 'sanitize-full' | 'ai-call';
  sourceUntrusted: boolean;            // true if edited_externally forced forceFull from step 3
  originalMode?: 'patches' | 'full';   // what the FIRST generate() call came back as
  appliedMode?: 'patches' | 'full';    // what actually got written — absent if outcome is 'failed'
  retryFired: boolean;
  initialRejectReason?: 'unresolved-id' | 'mid-batch-vanish';  // why the retry was triggered, if it was
  retryOutcome?: 'resolved' | 'still-failed';                  // what the retry produced, if it fired
  fallbackUsed: boolean;
  fallbackReason?: 'retry-failed' | 'sanitize-rejected' | 'cap-exceeded' | 'duplicate-id'
                 | 'empty-batch' | 'payload-too-large' | 'malformed-response' | 'unparseable-source';
  filename?: string;                   // the newly allocated filename — present only if outcome is 'applied'
  durationMs: number;
}
```

`appliedMode` is optional, not the non-optional field an earlier draft had — a `final-read`/
`staleness` rejection returns before ever reaching a validated result to apply, so there is no mode to
log for those calls, only an `outcome: 'failed'` and a `failureStage` naming where it stopped. Two
fields instead of one overloaded enum for the retry itself (`initialRejectReason` + `retryOutcome`) —
a single `fallbackReason: 'retry-failed'` value can't distinguish "an unresolved id that a retry still
couldn't fix" from "a mid-batch vanish that a retry still couldn't fix," which defeats the point of
logging a reason at all. `fallbackReason` is only ever set when the flow actually took the fallback
path (never when the model's first or retried response was already `mode: 'full'` on its own — that's
visible instead via `originalMode`/`appliedMode` both being `'full'` with `fallbackUsed: false`).
`sourceUntrusted` is logged unconditionally (not just on failure) since it's the up-front input that
decided whether patches mode was even attempted, independent of how the call ultimately turned out.
Exact AI-reported token counts aren't reliably available from the current `callClaudeTool`/
`callOllamaTool` return shape (`Promise<unknown>`, no usage metadata threaded through) — wiring that
through, alongside `durationMs` (cheap to add now, logged from call start to return), is worth a
follow-up task if fallback rate turns out to matter in practice, not a blocker for this one.

## Testing

Follows `componentPatchService.test.ts`'s existing shape: the AI boundary is mocked (`vi.mock` on
`getComponentGenerator()`, same convention already used there), everything else is real — actual
temp-directory file I/O, actual sanitize/splice/merge logic. New coverage needed:

- Tool-schema selection: `emit_component` is used when `basedOnContent` is absent; `emit_component_delta`
  is used when it's present. (Confirms the fork point, not AI behavior.)
- Successful multi-element patch apply: one write to the newly allocated filename, not N: verify via a
  single `writeFile` call count or a single resulting document read, covering at least two elements
  patched in one batch.
- Successful full-mode apply: unchanged from today's `generate()` full-write test coverage, just
  reached via the new discriminated-union path and written by `resolveComponentRegeneration()` rather
  than by `generate()` itself.
- Unresolvable id → corrective retry → success: mock the AI to return a bad `dataGfId` on the first
  call and a valid one on the retry; assert the retry's `correction` message names the specific
  offending id(s) *and* includes an id→tag/class map of the valid ones (not just one or the other),
  and that the patch succeeds on the second attempt.
- Retry also fails → full-regen fallback: mock the AI to keep returning unresolvable ids across both
  attempts; assert the job still completes via a `forceFull: true` full-write result generated
  against the *current* `basedOnContent` and the *original* instruction (not a second retry), and that
  `fallbackReason: 'retry-failed'` with `initialRejectReason: 'unresolved-id'`, `retryOutcome:
  'still-failed'` is logged.
- **Sanitize failure in patches mode:** mock the AI's patch `html` to contain something
  `sanitizeComponentHtml` rejects. Assert this is caught by `applyPatchBuffer`, skips the corrective
  retry entirely (same as empty/duplicate/cap), and falls straight to full-regenerate with
  `fallbackReason: 'sanitize-rejected'`.
- **Multi-root / unparseable patch `html`:** a patch's `html` fragment has more than one top-level
  element (what `assignElementIds`'s `preserveRootId` mode already rejects for the single-patch case).
  Assert `applyPatchBuffer` catches this the same way as a sanitize failure — batch-level, no retry,
  straight to fallback.
- **Cap-exceeded fallback:** a patch list longer than the size cap. Assert it's rejected before any id
  resolution is even attempted, `retryFired: false`, `fallbackReason: 'cap-exceeded'`.
- **Malformed tool response:** the mocked AI returns something matching neither `ComponentDeltaResult`
  arm — both missing `mode` and, separately, a response carrying fields from *both* arms at once
  (asserting the `.strict()` schemas actually reject this, not silently strip the extra arm's fields
  the way a bare `z.object()` would). Assert both cases route to the `forceFull` fallback
  (`fallbackReason: 'malformed-response'`), not a hard job failure and not the id-resolution retry.
- **Payload-too-large fallback:** patches individually valid (resolve fine, no duplicates, under the
  count cap) but their combined `html`+`cssDeclarations` byte length exceeds the size guard. Assert
  it's rejected before any AI retry, `fallbackReason: 'payload-too-large'`.
- **Unparseable based-on content in patches mode:** mock `basedOnContent` to a string missing a
  `<style>`/`<body>` pair, and mock the AI to return `mode: 'patches'` anyway. Assert this is caught
  before id resolution is attempted (`parseComponentHtml` throws), routes straight to the `forceFull`
  fallback with `fallbackReason: 'unparseable-source'`, and does not crash the job.
- **Backward mid-batch invalidation (documented limitation, not a bug to fix):** patch A edits
  descendant element 7, then patch B (later in the same batch) replaces ancestor element 5's whole
  subtree. Assert the *documented* behavior — B's write wins, A's edit to 7 is silently absent from
  the final result, no error — matches what's actually implemented, so this known limitation doesn't
  silently regress into something worse (e.g., a crash) without a test noticing.
- **The based-on asset changes during the AI call (the one concurrency case this design detects):**
  mock the AI call to mutate the based-on asset's stored file mid-call (simulating a concurrent
  `applyElementPatch()` write landing while `generate()` is in flight); assert the final recheck (step
  10) catches it and fails the job closed with the staleness message, rather than writing a result
  computed against the now-stale snapshot. This single test covers what would otherwise be two
  separate concurrency tests in a locked design (there's no lock here, so there's no separate
  "AI calls happen outside the lock" regression to test, and no "two concurrent calls race for the
  same file" case either — there is exactly one writer of a freshly allocated filename).
- **Id uniqueness across a multi-patch batch:** apply two patches in one batch where each introduces
  a new descendant element; assert the two new ids are distinct (guards against `startAt` being
  computed once from the pre-batch document instead of recomputed from the growing buffer before
  each patch).
- **A patch invalidates a later patch's target (mid-batch vanish):** patch A's new content for its
  target no longer contains a descendant that patch B (same batch) independently targets. Assert this
  is caught by `applyPatchBuffer` before any write, which triggers the one-shot corrective retry with
  a message describing the vanished id — same treatment as an unresolved id. Also assert the retry can
  rescue it (patch B's correction targets a different, still-present id) and, separately, that a retry
  which still vanishes falls through to full-regenerate.
- Duplicate `dataGfId` in one batch, and an empty patch list: both skip the corrective retry entirely
  (a "here are the valid ids" message doesn't address either) and fall through to full-regenerate
  directly, with `fallbackReason` set to `'duplicate-id'` / `'empty-batch'` respectively — assert
  `retryFired: false` for both, distinguishing them from the unresolved-id/vanish cases above.
- **Retry returns `mode: 'full'`:** the corrective retry, given the correction message, comes back
  full-mode instead of a corrected patch list. Assert this is accepted as a normal success (written as
  a full result, `fallbackUsed: false`), not treated as a failure needing the separate `forceFull`
  fallback call.
- **Untrusted based-on asset skips patches mode entirely:** a based-on asset with `edited_externally
  === 1`. Assert `generate()` is called with `forceFull: true` from the very first call — never given
  the chance to choose `patches` — for both a request whose instruction sounds style-only (proving
  trust overrides the model's own mode choice, not just a plausible-structural request) and a plain
  request. Assert `sourceUntrusted: true` is logged, and that this is not a job failure.
- Staleness → job fails closed, two variants: (1) write a content change to the based-on asset's
  stored file between the initial read and the final recheck (same technique the existing
  `ELEMENT_CHANGED` tests already use for the interactive flow); (2) leave the file's bytes unchanged
  but flip its `edited_externally` flag between step 2 and step 10 (the narrow case a hash check alone
  can't catch — see step 10's own reasoning). Assert both fail with `status: 'failed'` and the expected
  message, and that no new file was written to disk.
- **Worker call-site branching:** assert `resolveComponentRegeneration` is called only when
  `loadBasedOnContent` returns a defined string for a string `basedOnAssetId`; assert the existing
  plain `generate()` call still fires, unchanged, for first-generate (`basedOnAssetId` absent) and for
  "based-on content unreadable" (`basedOnAssetId` present but `loadBasedOnContent` returns
  `undefined`) — both must keep degrading to today's behavior, not attempt the delta path with no
  content to diff against.

## Open questions

None outstanding. Beyond the original brainstorming decisions (fail-closed on staleness; one-shot
corrective retry before falling back to full regeneration; style/content-only patch scope with
structural changes falling back to full regeneration; no new structured error-code taxonomy), five
rounds of adversarial spec review (see the paired review-log file) resolved a genuine architectural
mistake where AI calls were briefly specified as happening *inside* a held file lock, a dead-end where
recovering from a mid-batch target invalidation had no legal path, a missing sanitization step in the
shared patch-application helper, and several precision gaps in the function's signature, error-message
mapping, and observability fields. A sixth, distinct problem surfaced only once planning started and
the real call site got checked directly: "regenerate with changes" doesn't edit an existing asset in
place at all (see the correction in Architecture, above) — none of the five DeepSeek rounds could have
caught this, since DeepSeek was only ever shown `applyElementPatch()` (the mechanism this design was
told to generalize), never `worker.ts`'s job-then-separately-promoted-asset architecture, and had no
way to know the generalization target didn't share its target's edit-in-place shape. The corrected
design removes the lock, the DB trust re-check on the output, and the prompt-history write entirely —
net simpler than what five rounds of review had converged on, not an addition to it.

A sixth, single-pass sanity review (targeted at just the correction, not a full fresh 5-round loop,
with the real `worker.ts`/`from-job`/`page.tsx`/`applyElementPatch` excerpts pasted in) confirmed the
correction's central claim but found and fixed six precision gaps in the corrected sections
themselves: `resolveComponentRegeneration()` never stated *where* it re-reads the based-on asset's
file from at step 10 (fixed — step 2 now captures `image_path`/`output_kind` for reuse there); the
spec never explicitly said `generate()` stops writing to disk for every `basedOnContent`-present call,
not just the ones that end up in patches mode (fixed — stated directly in the `generate()` params
paragraph); the worker integration point (when `resolveComponentRegeneration` gets called vs. the
existing plain `generate()` call) was implied but never actually written down (fixed — a full code
snippet now lives in the "Worker integration" note); the plan to reuse `applyElementPatch`'s
`readVerifiedTokens` for step 10 was checked against that helper's actual contract and found to be
wrong (it requires successful parsing, which a `mode: 'full'` recheck must not impose) — dropped
entirely, `applyElementPatch()`'s own closure is now untouched by this feature; and the claim that a
content-hash match at step 10 always implies the trust flag couldn't have flipped was checked directly
against the one real setter of that flag and found to have a narrow counterexample (re-pasting
byte-identical content while flipping "trust as edited") — fixed by re-querying the flag at step 10
too, cheaply, alongside the hash check.
