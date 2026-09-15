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
regenerate-with-changes code is updated to branch on `mode` and call `applyRegenerationResult()`
rather than writing the result directly (as it does for first-generate). This is not a change to
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

**Layering, and why AI calls stay outside the lock.** `applyElementPatch()`'s own comment states the
rule this design must also follow: "AI call — deliberately outside the mutex; nothing here touches
the file." Holding `withFileLock` across a network round-trip would serialize every other in-process
operation on that filename behind an LLM call (seconds to minutes) — a correctness-adjacent
performance bug significant enough to reject a design over, not a "slightly longer" widening of the
already-acknowledged cross-process gap. So `applyRegenerationResult()` follows the *same two-phase
shape* `applyElementPatch()` already uses — unlocked pre-check (including any AI calls the pre-check
discovers it needs) → locked re-check-and-write — rather than inventing a new one:

**Signature:**

```ts
async function applyRegenerationResult(params: {
  filename: string;
  assetId: string;
  requestingUserId: string;
  isAdmin: boolean;
  instruction: string;              // the original "regenerate with changes" instruction
  result: ComponentDeltaResult;     // what generate() already returned in the worker
  basedOnContentHash: string;       // hashDocument() of the exact bytes loadBasedOnContent() read
  styleId: string;
  componentType?: string;
  referenceImage?: ReferenceImagePayload;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<RegenerationResult>
```

`RegenerationResult` (replaces the single-root `PatchResult` shape, which doesn't fit a batch):

```ts
type RegenerationResult =
  | { ok: true; mode: 'patches'; appliedIds: string[]; newDescendantIds: string[]; newDocumentHash: string }
  | { ok: true; mode: 'full'; newDocumentHash: string }
  | { ok: false; message: string };
```

(`message: string`, not a structured error-code union like `PatchError` — see Error Handling below.
Mapping: a hash mismatch produces the staleness message; a missing/unparseable file produces a
distinct "component could not be read" message; an `edited_externally` hit produces the same
trust-rejection message text `applyElementPatch()` already uses. `appliedIds`/`newDescendantIds` are
read from **phase 2's real run** specifically — the dry run in phase 1 never writes anything, so it's
never the authoritative source for what's actually on disk, even though (see the determinism note
below) its output is identical.)

**`generate()`'s existing callers and behavior are unchanged; it gains two new optional
parameters** to make the retry/fallback callable at all (this was previously unspecified — verified
there's no existing method with this shape): `correction?: string` (appended to the built prompt
before the tool call, regardless of provider — a general mechanism, not the Ollama-only
`providerOverride.correctionRequested`) and `forceFull?: boolean` (when true, uses the plain
`emit_component` tool even though `basedOnContent` is present — this is what the fallback call uses,
so a full-regenerate attempt can't itself come back as `mode: 'patches'` and recurse). **When
`basedOnContent` is present, `generate()`'s return type is uniformly `ComponentDeltaResult` regardless
of `forceFull`** — a forced-full call still comes back shaped `{mode: 'full', html, css}`, never the
legacy bare `GeneratedComponent`, so `applyRegenerationResult()` never has to special-case which tool
produced a given result. **The raw tool response is validated with the same `z.object(...).parse()` /
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

**`readVerifiedTokens` must be extracted to module scope** to be reusable at all — verified against
the real code: it's currently a closure declared *inside* `applyElementPatch`, capturing `filePath`
and `params.documentHash`, not an independently-callable helper. This is a real edit to shipped,
already-reviewed code (`componentPatchService.ts`), not a free reuse: `readVerifiedTokens(filePath,
expectedHash)`, called identically from both functions, and **returning the raw document string
alongside the hash-check result and parsed tokens** — the retry/fallback calls in phase 1 need the
raw `basedOnContent` text to rebuild their prompt, and since `readVerifiedTokens` already reads it
(and the hash check just confirmed it's byte-identical to the original snapshot), that read is the
one source of truth for it — no separate `basedOnContent` parameter needed on
`applyRegenerationResult()` itself. **This equivalence is verified, not assumed:** `loadBasedOnContent()`
(`worker.ts`) reads `fsPromises.readFile(path.join(getProjectRoot(), 'storage', subdir,
asset.image_path), 'utf-8')` for a component asset — the identical path shape and read mechanism
`readVerifiedTokens` uses for `storage/components/<filename>` — so `hashDocument()` (a pure string
hash) produces the same value for both reads of unchanged content.

**A shared, pure `applyPatchBuffer(tokens, patches)` helper** does the actual per-patch work, mirroring
`applyElementPatch()`'s own existing per-patch sequence exactly (this was missing from an earlier
draft — sanitization is not optional): the `RAW_MARKER_PATTERN` head/body-escape check,
`sanitizeComponentHtml`, `assignElementIds` (with `startAt` recomputed from the current buffer state
before each patch — reusing pre-batch max across multiple patches that each introduce new descendants
would silently produce colliding ids), `ensureClassOnRoot`, `sanitizeComponentCss` +
`replaceOrAppendRuleForClass` for the CSS side, then splice via `replaceElementByDataGfId`. A
sanitize failure on any patch is a **batch-level rejection** (same treatment as empty/duplicate/cap —
skips the corrective retry, since "here are valid ids" doesn't address unsafe content, and routes
straight to the fallback), not an id-resolution failure.

`(tokens, patches)` really is the helper's complete input set — verified against the real code, not
assumed: `gfClass` (`componentPatchService.ts:113`) is computed as `` `gf-${dataGfId}` `` only, no
`styleId`/`componentType` or any other value involved anywhere in the class-name or splice logic, so
neither of those needs to be threaded into this helper despite `applyRegenerationResult()` carrying
them for other purposes (building the AI prompt).

This whole helper is a **pure function of its inputs** — every function it calls
(`sanitizeComponentHtml`, `assignElementIds`, `findElementByDataGfId`, `replaceElementByDataGfId`) is
itself pure, with no clock, randomness, or global mutable state anywhere in the chain (verified by
reading each) — which is exactly what makes running it twice (dry run in phase 1, for real in phase 2)
sound: identical inputs guarantee identical outputs, so phase 2 reaching a *different* result than
phase 1's dry run on the same hash-verified-identical content is not a race to guard against, it's a
contradiction that shouldn't be reachable. It never touches disk or the AI. Called from two places
below — once as a dry run in phase 1 (to discover a sanitize failure or mid-batch-vanish somewhere an
AI retry is still legal), once for real in phase 2 (to actually produce what gets written) — rather
than being written twice.

**Known, accepted limitation, not detected or prevented: last-writer-wins for overlapping targets
within one batch.** The dry run catches a *forward* invalidation (an earlier patch removes a *later*
patch's target — "mid-batch vanish," above). It does not catch the *reverse*: if patch A edits
descendant element 7, and a *later* patch B in the same batch replaces element 5's whole subtree
(element 7's ancestor), B's write silently discards A's edit to 7 with no error and no signal — B's
own target (5) still resolves fine, nothing "vanishes" from the check's perspective. Detecting this
fully would mean asserting, after the dry run, that every already-applied target's element still
exists unmodified in the final buffer — real additional complexity for what requires two patches in
the same batch where one's target is a structural ancestor of another's, ordered ancestor-then-
descendant, and the ancestor's own patch happens to touch that specific descendant's region. Given how
narrow the trigger condition is, and that the output is still a well-formed, sanitized document (just
possibly missing one of the intended edits, not corrupted), this is documented as a known gap rather
than built out further in this pass — worth a follow-up if it ever proves to matter in practice,
matching this spec's existing precedent of naming rather than solving the cross-process locking gap.

**Batch size is capped on both count and total payload bytes.** A count-only cap (e.g. 20 patches,
per the batch-level-rejection step below) doesn't guard the feature's actual cost goal — a handful of
patches can each carry an arbitrarily large `html`/`cssDeclarations` and collectively exceed what a
full regenerate would have cost. A second cap rejects the batch (same `fallbackReason`-tagged,
no-retry treatment as count/duplicate/empty) if the summed byte length of all patches' `html` +
`cssDeclarations` exceeds a fraction of the current document's own size (exact threshold is an
implementation-plan detail, not pinned here) — `fallbackReason: 'payload-too-large'`.

Phase 1 — unlocked (mirrors `applyElementPatch`'s existing "cheap, unlocked pre-check... not a
replacement for the locked re-check, just an optimization to avoid wasting inference"):

1. **Trust guard first:** `edited_externally === 1` fails the job closed here, before any file read —
   matching `applyElementPatch()`'s *actual* shipped order (added to that function "at the very top...
   before the unlocked pre-check," per its own PR #32 commit), not the file-read-first ordering an
   earlier draft of this spec had (which would waste a file read on an asset that's going to be
   rejected regardless, and reported hash-mismatch staleness ahead of a trust rejection for content
   that's both trusted and stale).
2. `readVerifiedTokens(filePath, params.basedOnContentHash)`. Not-found/parse-failure/hash-mismatch
   all fail the job closed here, before any AI call — see Error Handling for which message each maps
   to.
3. If `params.result.mode === 'full'`: nothing further to validate here — a full response has no ids
   to resolve or batch to simulate. Proceed straight to phase 2 with this result.
4. If `params.result.mode === 'patches'`, first check batch-level validity: empty list, more than a
   fixed size cap (e.g. 20 — undermining "localized change" is itself a signal to just regenerate), or
   duplicate `dataGfId`s. **None of these get the corrective retry in step 6** — a "here are the valid
   ids" correction doesn't meaningfully address "you sent zero patches" or "you sent the same id
   twice," and a working fallback path exists regardless, so there's no need for the retry mechanism
   to be able to help *every* rejection reason, just the ones it plausibly can; these three route
   straight to the fallback (step 7) with `fallbackReason` set to `'empty-batch'` / `'cap-exceeded'` /
   `'duplicate-id'` respectively.
5. Otherwise, resolve every `dataGfId` against the tokens from step 2 (reusing
   `findElementByDataGfId` — the resolution is what guarantees each id is a genuine digit-string that
   exists in the document, the invariant `extractDeclarationsForClass`'s doc comment already documents
   for the single-patch case), then **run `applyPatchBuffer` as a dry run** against a copy of those
   tokens. This is what actually discovers a sanitize failure or a mid-batch-vanish (patch A's new
   content for element 5 no longer contains the element-7 descendant patch B independently targets) —
   *here*, where a corrective retry is still legal, not in phase 2 where it wouldn't be. A sanitize
   failure is a batch-level rejection (`fallbackReason: 'sanitize-rejected'`, straight to step 7, no
   retry — same reasoning as empty/duplicate/cap). An id that fails to resolve upfront and a vanish
   discovered by the dry run are a different category (the response is otherwise well-formed, just
   references the wrong target) and *do* get the retry.
6. If step 5 found an unresolved id or a mid-batch vanish (not a sanitize failure or batch-level
   issue — those go straight to step 7): issue the **one-shot corrective retry** — `generate()` called
   again with `correction` set to a message naming the *specific offending ids* (unresolved, or the id
   that vanished and what removed it) alongside a **map of every valid current id to its tag/class**
   (an id integer alone gives the model nothing to anchor a correction to — this needs both halves).
   This call is unlocked, same reasoning as `applyElementPatch`'s existing AI call. **The retry may
   legitimately come back `mode: 'full'`** (the model decides, given the correction, that a full
   rewrite is simpler) — accept that as success, not as another failure to retry or fall back from. If
   it comes back `mode: 'patches'` again, repeat steps 4-5 against the retry's patches (batch-level
   checks, resolve, dry run) exactly once — no second retry either way. Whether the retry was
   triggered by an unresolved id or a vanish, and whether it then succeeds or still fails, is recorded
   as two separate observability fields (`initialRejectReason`, `retryOutcome` — see Observability)
   rather than one overloaded enum value, since collapsing "unresolved-id-then-still-failing" and
   "vanish-then-still-failing" into a single `'retry-failed'` value would erase exactly the
   distinction `fallbackReason` exists to preserve.
7. If the retry (or the original response) still doesn't produce a validated `patches` or `full`
   result — unresolved/vanished after the retry, or a batch-level rejection from step 4/5 that skipped
   the retry entirely: call `generate()` with `forceFull: true`, the *original* instruction, against
   the same content. This always *attempts* a full-mode call — if that call itself fails outright
   (network/API error), it's a plain AI-call failure like any other (see Error Handling), not a
   further fallback; there is no fallback beneath the fallback.

At the end of phase 1, there is always either a validated result to apply (an original or retried
`full` response, or an original or retried `patches` response whose dry run already succeeded) or a
job failure already returned.

Phase 2 — locked (mirrors `applyElementPatch`'s existing "locked re-check — the document may have
changed during the AI call"):

8. Acquire `withFileLock(filename, ...)`.
9. Re-query `assetService.getById(params.assetId)` for `edited_externally` immediately before any
   write — this is a **database** re-check, not something derivable from the file read below; the
   flag lives on the asset row, not in file content, so "re-check the trust guard against this fresh
   read" (an earlier draft's wording) was describing something that isn't coherent — there's no file
   property to re-check it against.
10. `readVerifiedTokens(filePath, params.basedOnContentHash)` **again** — the document may have
    changed during phase 1's AI call(s). Applies the **same mapping as step 2** (not-found/parse-fail →
    the distinct "could not be read" message; hash-mismatch → the staleness message) — an earlier
    draft only described the hash-mismatch case here, but a file deleted between phase 1 and phase 2
    (after an AI call had time to run) isn't "stale," it's gone, and deserves the same distinct message
    step 2 already gives that case.
11. `mode === 'full'`: write the full result. `mode === 'patches'`: run `applyPatchBuffer` for real
    against step 10's tokens and write the resulting buffer. Since that read is hash-verified
    identical to phase 1's, and `applyPatchBuffer` is verified pure (above), a *different* outcome here
    than phase 1's dry run isn't reachable in practice — but **if it somehow still reports a mid-batch
    vanish**, fail the job closed anyway, with its own distinct **"internal consistency error"**
    message (logged as an error, not just recorded), not the staleness message — the staleness message
    means "content changed, try again," which would be actively misleading here: by this same
    reasoning, nothing *did* change (the read is hash-identical), so this branch firing at all would
    mean the purity assumption was wrong somewhere, not that the user's content moved. No further AI
    call is legal from inside the lock, so there is no fallback to reach for at this point, only a
    fail-closed backstop.
12. Write once — atomic, no partially-applied document ever reaches disk.
13. Release the lock (implicit in `withFileLock`'s own scoping) and return the result.
14. **Outside the lock**, record the write into the asset's prompt history — every successful write
    from this function (patches, full, and fallback alike; `fallbackReason` is only ever set when
    phase 1 actually took the fallback path, not when the model's first or retried response was
    already `mode: 'full'` on its own), the same mechanism `applyElementPatch()` already uses for every
    successful patch. This is placed after the lock releases, not inside it — it's a best-effort DB
    write (a failure here is logged, not fatal, same as `applyElementPatch()`'s own version), and
    nothing about it needs the file lock's protection, so it doesn't belong in the critical section
    whose whole point is staying fast (read-verify-apply-write only).

**Authorization:** `requestingUserId`/`isAdmin` exist on this function's params specifically to feed
step 14's `assetService.update()` call, which performs its own ownership check as part of the update
(the established "ownership checks live in the service layer" pattern) — the same reason
`applyElementPatch()` needs them. The job itself was already authorized at creation time (the HTTP
route that queues a "regenerate with changes" job checks ownership before ever enqueuing it, same as
every other job type); these params aren't a second authorization gate on top of that, just what the
prompt-history write needs.

No call to `withFileLock` ever nests inside another for the same filename — every write in this
function happens inline within the single phase-2 acquisition; every AI call (retry and fallback
alike) already happened back in phase 1, unlocked, precisely so phase 2 never needs to call out to
anything that might itself try to lock.

## A pre-existing gap this design closes for its own path, but doesn't retrofit elsewhere

Today, `generate()`'s full-write path has **no staleness check at all** — if the stored file changes
between the worker reading `basedOnContent` and the AI call finishing, the full rewrite silently
clobbers it. This is a real, pre-existing gap, not something this design introduces. Since patches
specifically need valid current ids to apply safely (unlike a full overwrite, which is "just" a
lost-update problem), this design adds a real hash check on the new `applyRegenerationResult()` path
— a net-new safety improvement scoped to this path, not a retrofit of the old one. If the old
first-generate path's lack of any check is ever worth fixing, that's a separate, smaller follow-up
task.

**Also worth naming, explicitly not solved here:** `componentPatchService.ts`'s file lock
(`withFileLock`) is in-process only. The worker (`worker.ts`, runs `generate()`) and the Next.js
server (runs click-to-select's `applyElementPatch()` via the patch-element routes) are separate
processes — a regenerate-with-changes job and a live click-to-select Apply on the *same* asset,
happening concurrently in different processes, are not mutually protected by this lock today. This
design's phase-2 lock is held only for read-verify-apply-write (no AI calls inside it, per the
Layering section above), so it doesn't widen that window at all — an earlier draft of this spec
claimed batching "marginally widens" it, which was wrong once the AI calls were correctly moved
outside the lock; corrected. A real fix for the cross-process gap itself needs cross-process locking
(e.g., an OS-level file lock, or a lock row in SQLite) — out of scope for this feature, worth its own
task if the collision ever proves to matter in practice.

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
every other job failure already works).

- AI call fails outright (network/API error, or the tool-not-called corrective retry still doesn't
  produce a valid call): job fails, same as `generate()`'s existing failure handling.
- Not-found or unparseable component file (phase 1, step 2; re-checked phase 2, step 10): job fails
  with a distinct "component could not be read" message — different from the staleness message below,
  since this isn't "it changed," it's "it can't be read at all" (deleted, or corrupted outside this
  pipeline).
- Trusted (`edited_externally === 1`) target asset: job fails with the **same message text**
  `applyElementPatch()`'s own rejection already uses for this case (checked in both phase 1, step 1,
  and again in phase 2, step 9 as a fresh DB query, not a file re-check — this function's own copy of
  the guard, not inherited from `applyElementPatch()` since it's a separate write path).
- Patches mode has an unresolvable id, a dry-run-discovered mid-batch vanish, or a dry-run-discovered
  sanitize failure that the one-shot corrective retry doesn't resolve (sanitize failures skip the
  retry entirely and go straight to fallback, same as the batch-level rejections below), or a
  batch-level rejection (empty, duplicate ids, over the size cap — these also skip the retry, per
  phase 1 step 4): **not a job failure** — falls through to a full-regenerate attempt automatically
  (phase 1 step 7), using the same instruction against the still-current document. Logged server-side
  (`console.error`, matching the existing best-effort-log-don't-fail convention already used for
  prompt-history recording in `componentPatchService.ts`) for future debugging/cost-tracking
  visibility (see Observability, below — the log records *which* of these reasons triggered the
  fallback, not just that one did), and recorded into the asset's prompt history the same way every
  successful write from this function already is (phase 2 step 14), so a regeneration that ended up
  more invasive than the instruction implied is auditable later. Not surfaced to the user as an
  error — the job still succeeds from their perspective.
- Staleness detected at apply-time (phase 1 step 2, and re-checked in phase 2 step 10 after any AI
  call): job fails closed, `status: 'failed'`, a clear `error_message` ("Component changed while
  regenerating — please try again"). No auto-requeue: the
  user's instruction was written against a specific version of the component they were looking at;
  silently re-applying it to whatever the component has since become risks producing a result they
  didn't actually ask for. This also matches the only precedent for "something raced" already in
  this codebase — the interactive flow's `ELEMENT_CHANGED` case, which fails closed and lets the
  user re-select and retry rather than guessing on their behalf. There is no existing pattern of a
  job silently re-queuing itself on a detected conflict anywhere in this codebase; the existing
  "Retry" button on a failed job is explicitly user-initiated, and this follows that same shape.

  **Why this gets different treatment than the unresolvable-id fallback above, even though both are
  "something didn't go as expected":** they're different failure classes. Staleness means something
  *external* moved — another job, another user, another tab — out from under the instruction the
  user wrote against a specific version of the component; guessing what to do about that (auto-
  requeue, or silently proceeding) risks acting on content they haven't seen. An unresolvable id
  means the model's own patch response didn't line up with a document that *hasn't* moved — the full-
  regenerate fallback re-runs the same, still-valid instruction against the same, still-current
  content the user actually saw, using a code path this system already trusts (first-generate's
  full-write). One case has genuine ambiguity about what the user wants; the other doesn't.
- Sanitize/validation failure on a **`mode: 'full'`** response: reuses the existing
  `sanitizeComponentHtml`/`sanitizeComponentCss` error paths, job fails with that message, same as
  today's `generate()` full-write. (A sanitize failure on a `mode: 'patches'` response is handled
  differently — see the fallback bullet above; it doesn't fail the job, it triggers full-regenerate.)
- Malformed tool response (doesn't cleanly match either `ComponentDeltaResult` arm under the
  `.strict()` validation — see Architecture): **not a job failure** — routes to the same `forceFull`
  fallback as the other batch-level rejections (`fallbackReason: 'malformed-response'`), since the
  simpler `emit_component` schema the fallback uses is far more likely to succeed than retrying the
  same discriminated-union schema that just failed to parse. Only a transport/network failure on that
  fallback call itself falls into the first bullet above.
- Disk write failure: same as today.

## Observability

The entire premise of this feature is that patches mode is cheaper than full regeneration — without
visibility into how often it's actually chosen, retried, or abandoned, there's no way to tell whether
it's working or quietly making things worse (patch attempt + failed retry + full fallback costs more
than just going straight to full). `applyRegenerationResult()` logs one structured line per call:

```ts
{
  fileName: string;
  outcome: 'applied' | 'failed';       // did this call end in a write, or a job failure
  failureStage?: 'trust' | 'read' | 'staleness' | 'sanitize-full' | 'ai-call' | 'internal-consistency';
  originalMode?: 'patches' | 'full';   // what params.result came in as — absent if outcome is 'failed'
                                        // before phase 1 even reached a validated result
  appliedMode?: 'patches' | 'full';    // what actually got written — absent when outcome is 'failed'
  retryFired: boolean;
  initialRejectReason?: 'unresolved-id' | 'mid-batch-vanish';  // why the retry was triggered, if it was
  retryOutcome?: 'resolved' | 'still-failed';                  // what the retry produced, if it fired
  fallbackUsed: boolean;
  fallbackReason?: 'retry-failed' | 'sanitize-rejected' | 'cap-exceeded' | 'duplicate-id'
                 | 'empty-batch' | 'payload-too-large' | 'malformed-response';
  durationMs: number;
}
```

`appliedMode` is optional, not the non-optional field an earlier draft had — a trust/read/staleness
rejection returns before phase 1 ever reaches a validated result to apply, so there is no mode to
log for those calls, only an `outcome: 'failed'` and a `failureStage` naming where it stopped. Two
fields instead of one overloaded enum for the retry itself (`initialRejectReason` + `retryOutcome`) —
a single `fallbackReason: 'retry-failed'` value can't distinguish "an unresolved id that a retry
still couldn't fix" from "a mid-batch vanish that a retry still couldn't fix," which defeats the
point of logging a reason at all. `fallbackReason` is only ever set when phase 1 actually
took the fallback path (never when the model's first or retried response was already `mode: 'full'`
on its own — that's visible instead via `originalMode`/`appliedMode` both being `'full'` with
`fallbackUsed: false`). `sanitize-rejected` covers a dry-run sanitize failure specifically (batch-level,
no retry, per Architecture). Exact AI-reported token counts aren't reliably available from the current
`callClaudeTool`/`callOllamaTool` return shape (`Promise<unknown>`, no usage metadata threaded
through) — wiring that through, alongside `durationMs` (cheap to add now, logged from call start to
return), is worth a follow-up task if fallback rate turns out to matter in practice, not a blocker for
this one.

## Testing

Follows `componentPatchService.test.ts`'s existing shape: the AI boundary is mocked (`vi.mock` on
`getComponentGenerator()`, same convention already used there), everything else is real — actual
temp-directory file I/O, actual locking, actual sanitize/splice/merge logic. New coverage needed:

- Tool-schema selection: `emit_component` is used when `basedOnContent` is absent; `emit_component_delta`
  is used when it's present. (Confirms the fork point, not AI behavior.)
- Successful multi-element patch apply: one write to disk, not N: verify via a single `writeFile`
  call count or a single resulting document read, covering at least two elements patched in one
  batch.
- Successful full-mode apply: unchanged from today's `generate()` full-write test coverage, just
  reached via the new discriminated-union path.
- **AI calls happen outside the lock:** assert (via mock call-order or timing) that
  `withFileLock`/phase-2 file access happens only after any retry/fallback `generate()` call has
  resolved, never during it — this is the specific bug round 2 of the spec review caught (an earlier
  draft held the lock across the AI call), so it gets its own explicit regression test, not just
  incidental coverage from the other tests below.
- Unresolvable id → corrective retry → success: mock the AI to return a bad `dataGfId` on the first
  call and a valid one on the retry; assert the retry's `correction` message names the specific
  offending id(s) *and* includes an id→tag/class map of the valid ones (not just one or the other),
  and that the patch succeeds on the second attempt.
- Retry also fails → full-regen fallback: mock the AI to keep returning unresolvable ids across both
  attempts; assert the job still completes via a `forceFull: true` full-write result generated
  against the *current* document and the *original* instruction (not a second retry), and that the
  fallback is recorded into the asset's prompt history with `initialRejectReason: 'unresolved-id'`,
  `retryOutcome: 'still-failed'`, `fallbackReason: 'retry-failed'`.
- **Sanitize failure in patches mode:** mock the AI's patch `html` to contain something
  `sanitizeComponentHtml` rejects. Assert this is caught by phase 1's dry run, skips the corrective
  retry entirely (same as empty/duplicate/cap), and falls straight to full-regenerate with
  `fallbackReason: 'sanitize-rejected'`.
- **Multi-root / unparseable patch `html`:** a patch's `html` fragment has more than one top-level
  element (what `assignElementIds`'s `preserveRootId` mode already rejects for the single-patch case).
  Assert `applyPatchBuffer`'s dry run catches this the same way as a sanitize failure — batch-level,
  no retry, straight to fallback.
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
- **Backward mid-batch invalidation (documented limitation, not a bug to fix):** patch A edits
  descendant element 7, then patch B (later in the same batch) replaces ancestor element 5's whole
  subtree. Assert the *documented* behavior — B's write wins, A's edit to 7 is silently absent from
  the final result, no error — matches what's actually implemented, so this known limitation doesn't
  silently regress into something worse (e.g., a crash) without a test noticing.
- **Content changes between phase 1 and phase 2** (during the retry/fallback AI call, not before it):
  mock the AI call to mutate the stored file mid-call (simulating a concurrent write landing while
  phase 1's AI call is in flight); assert phase 2's re-check catches it and fails closed, rather than
  writing against phase 1's now-stale resolution.
- **Id uniqueness across a multi-patch batch:** apply two patches in one batch where each introduces
  a new descendant element; assert the two new ids are distinct (guards against `startAt` being
  computed once from the pre-batch document instead of recomputed from the growing buffer before
  each patch).
- **A patch invalidates a later patch's target (mid-batch vanish):** patch A's new content for its
  target no longer contains a descendant that patch B (same batch) independently targets. Assert this
  is caught by phase 1's **dry run** (`applyPatchBuffer` against an in-memory copy, before any write),
  which triggers the one-shot corrective retry with a message describing the vanished id — same
  treatment as an unresolved id, not a direct-to-fallback batch-level rejection. Also assert the retry
  can rescue it (patch B's correction targets a different, still-present id) and, separately, that a
  retry which still vanishes falls through to full-regenerate.
- Duplicate `dataGfId` in one batch, and an empty patch list: both skip the corrective retry entirely
  (a "here are the valid ids" message doesn't address either) and fall through to full-regenerate
  directly, with `fallbackReason` set to `'duplicate-id'` / `'empty-batch'` respectively — assert
  `retryFired: false` for both, distinguishing them from the unresolved-id/vanish cases above.
- **Retry returns `mode: 'full'`:** the corrective retry, given the correction message, comes back
  full-mode instead of a corrected patch list. Assert this is accepted as a normal success (written as
  a full result, `fallbackUsed: false`), not treated as a failure needing the separate `forceFull`
  fallback call.
- **Trusted content, both branches:** a target whose asset has `edited_externally === 1` is rejected
  before any write — once via the direct patches-mode call, once via the full-fallback path
  specifically (the fallback must inherit the same guard, not just the primary path). Assert the
  actual rejection **message text** matches `applyElementPatch()`'s existing trust-rejection message,
  not just that the call failed.
- Staleness → job fails closed: write a change to the stored file between snapshot and apply (same
  technique the existing `ELEMENT_CHANGED` tests already use for the interactive flow); assert
  `status: 'failed'` with the expected message, and that nothing was written to disk.
- Concurrent-batch-apply race: mirrors the existing "serializes two concurrent patches" test in
  `componentPatchService.test.ts` — but assert what that test actually demonstrates (verified against
  its real behavior before writing this down): **one call succeeds and the other observes a clean
  staleness failure**, not that both eventually succeed in serial order. The file lock prevents
  simultaneous writes; it doesn't make a second call's now-stale snapshot valid again. The
  cross-process gap noted above stays explicitly out of scope, not something this test claims to
  cover.

## Open questions

None outstanding. Beyond the original brainstorming decisions (fail-closed on staleness; one-shot
corrective retry before falling back to full regeneration; style/content-only patch scope with
structural changes falling back to full regeneration; no new structured error-code taxonomy), four
rounds of adversarial spec review (see the paired review-log file) resolved: a genuine architectural
mistake where AI calls were briefly specified as happening *inside* the held file lock, contradicting
the shipped code's own explicit design, fixed by adopting the same two-phase
unlocked-precheck/locked-recheck shape `applyElementPatch()` already uses; a dead-end where phase 2
had no legal way to discover or recover from a mid-batch target invalidation, fixed by moving batch
simulation into a phase-1 dry run; a missing sanitization step in the shared patch-application helper;
and several precision gaps in the function's signature, error-message mapping, and observability
fields that would have made the design ambiguous or uncallable as first specified.
