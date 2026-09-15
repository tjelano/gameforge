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

**Tool schema fork.** `ComponentGenerator.generate()`'s signature is unchanged. Internally: when
`basedOnContent` is `undefined` (first-time generation), behavior is completely unchanged — the
existing `emit_component` tool, always full. When `basedOnContent` is present ("regenerate with
changes"), `generate()` uses a new tool, `emit_component_delta`, whose response is a discriminated
union:

```ts
type ComponentDeltaResult =
  | { mode: 'patches'; patches: Array<{ dataGfId: string; html: string; cssDeclarations: string | null }> }
  | { mode: 'full'; html: string; css: string };
```

The prompt instructs the model to prefer `patches` mode when the instruction only touches existing
elements' style or content, and `full` mode when it requires adding, removing, or reordering
elements. The model decides per-request; there is no separate classification call (that would cost
more than it saves — see Approach B, rejected below).

**Layering.** Following the existing split between `ComponentGenerator` (talks to the AI, returns a
candidate result) and `componentPatchService` (owns safe-apply-with-concurrency-control — already
true of `applyElementPatch()` for the single-element click-to-select case): `generate()` returns the
raw `ComponentDeltaResult` without writing anything. A new function in `componentPatchService.ts`,
`applyRegenerationResult()`, does the actual write:

1. Locks the file (reuses the existing `withFileLock`, keyed by filename).
2. Re-reads the current stored document and hashes it (reuses `hashDocument`).
3. **Staleness check (new — see "A pre-existing gap" below):** compares this hash against the
   `basedOnContent` snapshot the prompt was originally built from. If they don't match, discard the
   result and fail the job closed (see Error Handling) — do not apply patches against a document
   that has since changed, and do not silently overwrite whatever changed it either.
4. If `mode === 'full'`: write the whole document, exactly as `generate()` does today for a
   from-scratch generation. No further change to this path.
5. If `mode === 'patches'`: resolve every `dataGfId` in the list against the freshly-read document
   (reusing `findElementByDataGfId`). If every id resolves, apply all patches to an in-memory copy
   of the document and write once — atomic, no partially-applied document ever reaches disk. Every
   individual patch's own processing (sanitize, splice via `replaceElementByDataGfId`,
   `ensureClassOnRoot`, CSS merge via `replaceOrAppendRuleForClass`) is identical to what
   `applyElementPatch()` already does per-patch today; this just calls that same logic N times
   against one shared in-memory buffer instead of once against disk.
6. If any `dataGfId` fails to resolve: issue a **one-shot corrective retry**. Verified before
   writing this down: the existing `providerOverride.correctionRequested` field
   (`ComponentGenerator.ts:94-96`, `:160-162`) is wired into the Ollama branch only — the default
   `callClaudeTool` branch (`:101-111`) has no equivalent retry today, and Claude is the primary
   provider (Ollama requires an explicit user-selected override). So this can't literally reuse that
   field; it needs its own one-shot retry that wraps whichever provider actually produced the
   response — same *shape* as the existing pattern (a single retry with an appended corrective
   message, not an open-ended loop), implemented as its own retry inside the new delta call path so
   it applies uniformly regardless of provider. The retry message includes the real current id list
   so the model can self-correct — mirroring Aider's documented pattern of feeding the LLM a
   specific match failure rather than failing silently. If the retry's patch list *still* has an
   unresolvable id, discard it and fall through to a full-regenerate attempt (step 4's path, using
   the *original* instruction against the *current* document) — never a second retry.

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
happening concurrently in different processes, are not mutually protected by this lock today.
Batching multiple patches into one held lock marginally widens that pre-existing window (the lock is
held slightly longer per operation) rather than closing it. A real fix needs cross-process locking
(e.g., an OS-level file lock, or a lock row in SQLite) — out of scope for this feature, worth its own
task if the collision ever proves to matter in practice.

## Approaches considered

**A (chosen): single AI call, discriminated-union response, id-anchored patches.** Described above.
Reuses the already-shipped, already-reviewed element-patch mechanism generalized to a batch; reuses
the already-shipped correction-request retry pattern; no new infrastructure.

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
- Patches mode has an unresolvable `dataGfId`, the one-shot corrective retry also fails: **not a job
  failure** — falls through to a full-regenerate attempt automatically (step 4 of the apply flow,
  above). Logged server-side (`console.error`, matching the existing best-effort-log-don't-fail
  convention already used for prompt-history recording in `componentPatchService.ts`) for future
  debugging/cost-tracking visibility, but not surfaced to the user — the job still succeeds from
  their perspective, they don't need to know which internal path produced the result.
- Staleness detected at apply-time (step 3): job fails closed, `status: 'failed'`, a clear
  `error_message` ("Component changed while regenerating — please try again"). No auto-requeue: the
  user's instruction was written against a specific version of the component they were looking at;
  silently re-applying it to whatever the component has since become risks producing a result they
  didn't actually ask for. This also matches the only precedent for "something raced" already in
  this codebase — the interactive flow's `ELEMENT_CHANGED` case, which fails closed and lets the
  user re-select and retry rather than guessing on their behalf. There is no existing pattern of a
  job silently re-queuing itself on a detected conflict anywhere in this codebase; the existing
  "Retry" button on a failed job is explicitly user-initiated, and this follows that same shape.
- Sanitize/validation failure on the AI's output (patches or full): reuses the existing
  `sanitizeComponentHtml`/`sanitizeComponentCss` error paths, job fails with that message, same as
  today.
- Disk write failure: same as today.

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
- Unresolvable id → corrective retry → success: mock the AI to return a bad `dataGfId` on the first
  call and a valid one on the retry; assert the retry fires with the real current id list in its
  message, and that the patch succeeds on the second attempt.
- Retry also fails → full-regen fallback: mock the AI to keep returning unresolvable ids across both
  attempts; assert the job still completes via a full-write result generated against the *current*
  document and the *original* instruction, not a second retry.
- Staleness → job fails closed: write a change to the stored file between snapshot and apply (same
  technique the existing `ELEMENT_CHANGED` tests already use for the interactive flow); assert
  `status: 'failed'` with the expected message, and that nothing was written to disk.
- Concurrent-batch-apply race: mirrors the existing "serializes two concurrent patches" test in
  `componentPatchService.test.ts`, applied to two concurrent `applyRegenerationResult()` calls
  against the same file — confirms the in-process lock genuinely serializes them (the cross-process
  gap noted above stays explicitly out of scope, not something this test claims to cover).

## Open questions

None outstanding — every decision point raised during design was resolved during the brainstorming
conversation (fail-closed on staleness; one-shot corrective retry before falling back to full
regeneration; style/content-only patch scope with structural changes falling back to full
regeneration; no new structured error-code taxonomy).
