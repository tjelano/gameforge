# DeepSeek review log — delta-based-regeneration spec

Model: `deepseek-v4.1-flash` (recovered after failing 3/3 times earlier the same session; verified
recovered before this round, per the user's own cheaperinference billing dashboard showing the
earlier failures as `failed`/$0.00 vs. genuine settled calls once it came back).

## Round 1 — 18 findings + 2 nits, VERDICT: REVISE

Every finding verified against the actual spec text and the real `componentPatchService.ts`/
`worker.ts` source before acting — several required reading code not shown to the reviewer in round
1 to confirm.

**Accepted and revised into the spec (16 of 18, both nits):**

1. `startAt` for a patch's new descendant ids must be recomputed from the growing in-memory buffer
   before each patch, not computed once from the pre-batch document — confirmed against
   `componentPatchService.ts`'s existing single-patch code, which computes this fresh per call for
   exactly this reason.
2. An earlier patch in a batch can invalidate a later patch's target (remove/restructure a descendant
   another patch independently targets) — added: re-resolve each target against the buffer
   immediately before applying it, not just once upfront; fall through to full-regenerate if a target
   vanished mid-batch.
4. "Structural changes fall back to full" was prompt-only in the original text — clarified (not a new
   mechanism) that the response schema itself already makes document-level structural changes
   inexpressible in patches mode (a patch can only reference an existing id, `assignElementIds`
   already rejects multi-root fragments); within-one-element restructuring was already legal for
   single-patch mode and isn't a new gap.
5. TOCTOU between the staleness hash-check and id-resolution — fixed by reusing
   `readVerifiedTokens()` verbatim (one atomic read, hash + parse together), same helper
   `applyElementPatch()` already uses.
6. Missing `edited_externally`/trust guard on the new write path — added explicitly (this is the
   exact class of bug PR #32's final-review fix closed on a sibling path earlier today; the new
   function is a separate write path and doesn't inherit that guard automatically).
7. Empty patch list was unspecified — now explicit: treated as invalid, falls through to full.
8. No bound on batch size — added a fixed cap (illustrative "e.g. 20"), falls through to full if
   exceeded.
9. `PatchResult`'s single-root shape doesn't fit a batch result — defined an explicit
   `RegenerationResult` type for the new function.
10. `dataGfId` must be resolved via `findElementByDataGfId` (which structurally guarantees
    digit-string-ness by construction) *before* any class-name/regex use — clarified the ordering
    requirement explicitly in the spec text; verified this was already the design's intent, not a new
    mechanism, just under-specified.
11. The corrective retry's owner was ambiguous (`generate()` vs. the apply function) — clarified
    `applyRegenerationResult()` owns it, since it's the only place that discovers the failure and
    holds the current document to correct against.
12. The retry message needed an id→tag/class map, not bare id numbers, to actually be correctable —
    added.
13. `emit_component` and `emit_component_delta`'s full arm risk schema drift — noted as an
    implementation detail (share one schema fragment).
14. No observability into mode/retry/fallback rates for a feature whose whole point is cost
    savings — added an Observability section.
15. Full-fallback results weren't recorded to prompt history the way successful patches are — added.
16. The "concurrent batch-apply" test description claimed the lock "serializes" two concurrent calls;
    verified against what the existing analogous single-patch test actually demonstrates (one
    success + one clean `ELEMENT_CHANGED`, not both eventually succeeding) — corrected the test
    description to match reality.
17. Missing tests for id-uniqueness-across-a-batch and a patch invalidating another patch's
    target — added (directly follow from findings 1 and 2).
18. Missing test for the trust guard on both the direct-patches and full-fallback paths — added.
- Nit: "no further change" for the full-mode write path was wrong — the new staleness/trust checks do
  gate it now; fixed the wording.
- Nit: staleness (fail closed) vs. unresolvable-id (auto-fallback) looked inconsistent without stated
  rationale — added an explicit paragraph distinguishing the two failure classes (external state
  moved vs. the model's own response didn't match still-current state).

**Rejected, with reasoning (1 of 18):**

3. "The staleness hash may not be comparable to `basedOnContent` at all" (claimed a parse/recombine
   step could make the two hashes never match) — verified false against `worker.ts`'s
   `loadBasedOnContent()`: it reads the exact same raw file bytes `readVerifiedTokens()` reads at
   apply-time, no parse/recombine step in between, so the hashes are directly comparable today. Not a
   live bug. Kept the suggested *implementation detail* anyway (pass the snapshot hash through
   explicitly rather than re-deriving it) since it removes a latent assumption cheaply, even though
   nothing is currently broken.

**Self-caught during the revision (not from DeepSeek):** the revision's own first draft introduced a
`RegenerationError` reference in the new return type without ever defining it, contradicting the
spec's own "no structured error-code taxonomy" decision restated two sections later. Caught on
re-read before sending round 2; fixed to a plain `message: string`.

## Round 2 — 10 findings (5 material, 5 smaller), VERDICT: REVISE

Round 2 reviewed the round-1 revision and caught a genuinely serious architectural mistake introduced
*by* that revision: moving the retry/fallback logic into `applyRegenerationResult()` accidentally put
both AI calls (the corrective retry and the full-regenerate fallback) *inside* the held file lock —
directly contradicting `applyElementPatch()`'s own explicit, already-shipped design ("AI call —
deliberately outside the mutex; nothing here touches the file"). Verified directly against the real
code before accepting.

**All 10 accepted** (this round had no false findings):

1. **AI calls were inside the lock** — the single most serious finding. Fixed by restructuring the
   whole function into `applyElementPatch()`'s existing two-phase shape: an unlocked phase 1
   (pre-check + any retry/fallback AI calls) followed by a locked phase 2 (re-check + apply + write),
   rather than one lock held across everything.
2. **No re-check after the retry/fallback AI call** — follows directly from fixing #1: phase 2 now
   re-runs the staleness check and re-resolves ids against a fresh read, since the document could have
   changed during phase 1's AI call(s).
3. **Potential self-deadlock** if the fallback path ever nested a second `withFileLock` call for the
   same filename (`withFileLock` is not reentrant, verified against its real implementation) — made
   explicit that every write happens inline within the single phase-2 lock acquisition; the fallback's
   AI call already happened back in phase 1, unlocked, specifically so phase 2 never needs to call out
   to anything that might lock again.
4. **The function's signature and the retry's entry point were never actually specified** — defined
   `applyRegenerationResult()`'s full parameter list and `RegenerationResult`'s shape, and specified
   that `generate()` needs two new optional parameters (`correction`, `forceFull`) since neither
   existing method has the shape "re-invoke with an appended correction" for the non-Ollama case.
5. **`readVerifiedTokens()` can't be reused "verbatim"** — verified against the real code: it's a
   closure inside `applyElementPatch`, not a module-scope helper. Spec now states this explicitly as
   a real edit to shipped code (extract to `readVerifiedTokens(filePath, expectedHash)`), not a free
   reuse.
6. Apply-time error mapping was unspecified — added explicit mapping (not-found/parse-failure →
   distinct message; hash-mismatch → the staleness message; trust guard → the shared message with
   `applyElementPatch()`'s existing rejection).
7. Prompt-history recording was asymmetric (spec only mentioned the fallback case) — now every
   successful write from this function (patches, full, fallback alike) is recorded.
8. The corrective retry's message only listed valid ids, never the offending ones — fixed to include
   both.
9. Trust-guard message needed to be explicitly the *same text* as the interactive flow's rejection,
   with its own test asserting the message, not just the failure — added both.
10. Observability's `fallbackUsed` boolean couldn't distinguish *why* a fallback fired — added a
    `fallbackReason` enum (`retry-failed | cap-exceeded | duplicate-id | mid-batch-vanish |
    empty-batch`).

**Also self-caught while implementing this round's fix (not from DeepSeek):** the batch-level
rejections (empty list, duplicate ids, size cap) don't naturally benefit from the corrective retry's
"here are the valid ids" message — a retry only makes sense for an *unresolved* id, not for "you sent
zero patches" or "you sent the same id twice." Split phase-1 step 3 so batch-level issues route
straight to the fallback (step 5), skipping the retry (step 4) entirely, rather than lumping every
patches-mode rejection into one undifferentiated "→ retry" path.

Sending round 3 with this revision.

## Round 3 — 8 findings (3 blockers, 3 moderate, 2 minor), VERDICT: REVISE

Round 3 confirmed the two-phase restructure from round 2 was the right call, but caught that it
introduced a genuine dead end: phase 2's mid-batch-vanish handling claimed a full-regenerate fallback
was "already available from phase 1 if it was going to" happen — false. Phase 1 only checked upfront
id *existence*, never actually simulated applying the batch, so mid-batch-vanish (a target disappearing
because an *earlier* patch in the same batch restructured or removed it) was a failure mode phase 1
never detected at all — it could only be discovered during real application in phase 2, where no AI
call is legal anymore (the exact constraint round 2 established). Also flagged two params missing from
the function signature that would have made it uncallable, and three smaller precision fixes.

**All 8 accepted** (this round also had no false findings):

1. **The core blocker.** Restructured phase 1 to include a dry run: `applyPatchBuffer` (a new shared,
   pure helper — resolve, splice, CSS-merge, `startAt` recompute, called from both phases rather than
   duplicated) runs against an in-memory copy in phase 1, so mid-batch-vanish is discovered where a
   corrective retry is still legal. Phase 2 now only re-runs the same helper for real, and fails closed
   (no fallback reachable) if it somehow still vanishes there — reachable only if phase 1 and phase 2's
   reads diverged despite passing the same hash check, i.e. never in practice.
2. **Missing `result: ComponentDeltaResult` parameter** — the function had no way to receive the AI
   response it exists to apply. Added.
3. **Missing raw content for the retry/fallback prompt** — only the hash was in scope, not the text.
   Fixed by having `readVerifiedTokens` return the raw document alongside the hash-check and parsed
   tokens, since it already reads it and the hash check already guarantees it matches the original
   snapshot — no separate parameter needed.
4. `forceFull`'s return shape was unstated — specified `generate()` returns `ComponentDeltaResult`
   uniformly whenever `basedOnContent` is present, `forceFull` or not.
5. A retry returning `mode: 'full'` was unhandled by the original phase-1 wording (which only
   described "if the retry's patches don't resolve") — made explicit: accepted as success, not another
   failure needing the separate full-regenerate fallback.
6. Phase 2's re-resolution was framed as protection against document drift; corrected — the hash check
   already guarantees byte-identical reads between phases, so the only thing phase 2's re-run can still
   catch is the batch's own internal mutations (finding #1), not external drift.
7. Added a test for the corrected mid-batch-vanish handling (dry-run discovery, retry, and the
   still-vanishing-after-retry fallback case).
8. Clarified `fallbackReason` is only set when phase 1 actually took the fallback path, never when the
   model's own first or retried response was already `mode: 'full'`.

**Also resolved the reviewer's direct question** (was the empty/duplicate/cap-exceeded-skips-retry
split correct?): yes, keep it, but the stated justification needed narrowing — the retry mechanism
takes a free-form correction string, so it technically *could* address "you sent zero patches" with a
different message; the real reason to skip it for those three specifically is that they're
unlikely to be fixed by any correction and a working fallback path exists regardless, not that
corrective retries are inherently limited to id-list content. Mid-batch-vanish was reclassified out of
that group entirely — grouped with unresolved-id (gets the retry) rather than with the batch-level
structural rejections (skip straight to fallback), per finding #1's fix.

Sending round 4 with this revision.

## Round 4 — 15 findings, VERDICT: REVISE

The accumulated history file had grown to 103KB by this point (risking the same proxy payload ceiling
that caused failures earlier this session), so round 4 was sent with a **fresh history file** and a
concise summary of rounds 1-3 instead of the full transcript — noted here in case a future round needs
the same treatment.

Round 4 confirmed the core two-phase/dry-run shape from rounds 2-3 is now sound, but found 15 more
issues — one genuine security gap and several real precision/ordering bugs, none false.

**All 15 accepted:**

1. **Security gap:** `applyPatchBuffer`'s description never mentioned sanitization — an earlier draft
   would have spliced raw, unsanitized AI content into the document. Fixed: the helper now explicitly
   mirrors `applyElementPatch()`'s full per-patch sequence (`RAW_MARKER_PATTERN` check,
   `sanitizeComponentHtml`, `sanitizeComponentCss`), with a sanitize failure treated as a batch-level
   rejection (skips the retry, straight to fallback) since a "here are valid ids" correction doesn't
   address unsafe content.
2. The `loadBasedOnContent`/`readVerifiedTokens` hash-comparability claim (verified back in round 1)
   had been trimmed out of the spec text during later restructuring, making it look unverified from a
   fresh read. Re-inlined the verification at the point the claim is made.
3. `fallbackReason` as a single enum couldn't distinguish "unresolved id, retry still failed" from
   "mid-batch vanish, retry still failed" — both collapsed to `'retry-failed'`. Split into
   `initialRejectReason` + `retryOutcome` fields.
4. Direct wording contradiction ("signature is unchanged" vs. "gains two new optional parameters") —
   reworded.
5. **Real ordering bug**, not just wording: the trust guard was placed *after* `readVerifiedTokens` in
   phase 1, contradicting both the "before any file work" claim in the same sentence and
   `applyElementPatch()`'s actual shipped order (verified: the guard was added there "at the very
   top... before the unlocked pre-check"). Reordered to match.
6. Phase 2's trust re-check was described as "against this fresh read" (the file read) — incoherent,
   since `edited_externally` is a database field, not a file property. Fixed: phase 2 re-queries the
   asset row directly.
7. Phase 2's staleness re-check only described the hash-mismatch case, silently implying a
   deleted/unparseable file would also get the "staleness" message. Fixed to use the same full mapping
   phase 1 already has.
8. Prompt-history recording (a best-effort DB write) sat inside the phase-2 lock, in tension with the
   design's own "nothing slow inside the lock" rationale. Moved outside the lock, after release.
9. "The fallback always succeeds... always returns `mode: 'full'`" overclaimed — the fallback call can
   still fail outright like any AI call. Reworded to "always attempts," with outright failure handled
   by the existing AI-call-failure bucket.
10. The schema-enforcement claim assumed providers honor discriminated unions, which isn't guaranteed
    (especially for Ollama). Added: raw tool-response validation uses the same `.parse()` pattern the
    existing tools already use, and a validation failure is a plain AI-call failure, not routed through
    the id-resolution retry.
11. `requestingUserId`/`isAdmin` were threaded through but their purpose was never stated. Clarified:
    they feed the prompt-history `assetService.update()` call's own ownership check — the job itself is
    already authorized at creation time, this isn't a second gate.
12. `appliedIds`/`newDescendantIds` provenance was undefined given the function now runs the same logic
    twice (dry run + real run). Clarified: always read from phase 2's real run, the only one that
    actually writes anything.
13. The dry-run/real-run equivalence (central to the whole round-3 fix) was asserted without stating
    why it holds. Added: `applyPatchBuffer` and everything it calls are verified pure functions (no
    clock/randomness/global state), which is what makes running the same logic twice, against
    hash-verified-identical input, sound.
14. Added the three missing test cases the above findings implied: cap-exceeded fallback, a
    multi-root/unparseable patch (`assignElementIds`'s existing rejection), and a sanitize failure in
    patches mode.
15. Observability's `mode` field was ambiguous (original AI response vs. what actually got applied
    after retry/fallback) and had no latency data. Split into `originalMode`/`appliedMode`, added
    `durationMs`.

Sending round 5 (the last round this loop allows) with this revision.

## Round 5 — 9 findings, VERDICT: REVISE (loop cap reached — this is a deadlock, not a convergence)

Round 5 confirmed "the core architecture ... is sound and I have no argument with the big decisions,"
but found 9 more concrete problems, several of which would have surfaced as a failing test or a
compile error during implementation, not just prose imprecision. This is the 5th and last round this
skill's loop allows — per its own resolution protocol, a REVISE verdict at the cap is a deadlock, not
something to keep iterating past. Every finding was still triaged with full rigor (verified against
real code, not accepted or rejected on the reviewer's word) — the cap ends the *DeepSeek* loop, not
the requirement to actually check each claim.

**8 of 9 accepted, 1 rejected as false after verification:**

1. **Real, verifiable bug.** The spec claimed a bare `z.discriminatedUnion` would throw on "missing
   `mode`, both arms present, unknown fields" — verified against Zod's actual default behavior: bare
   `z.object()` uses "strip" mode (unknown keys silently dropped, not rejected), so only the
   missing-`mode` case would actually throw; "both arms present" would parse with the extra arm's
   fields quietly discarded. Fixed by adding `.strict()` to both arms, which is what actually makes
   the other two cases throw too.
2. **Rejected, verified false.** Claimed `applyPatchBuffer` might need `styleId`/`componentType` if the
   generated class name embeds them. Checked the real code: `gfClass` (`componentPatchService.ts:113`)
   is computed as `` `gf-${dataGfId}` `` only — no other input involved anywhere in the class-name or
   splice logic. Stated this explicitly in the spec (with the verification) to close off the ambiguity
   rather than just silently disagreeing.
3. **Good suggestion, adopted.** A malformed delta response (fails the new `.strict()` validation from
   #1) was routed to a hard job failure in the prior draft, even though a working `forceFull` recovery
   path exists for every other failure mode. Rerouted malformed responses to the same fallback
   (`fallbackReason: 'malformed-response'`) — the fallback's plain `emit_component` schema sidesteps
   the discriminated-union complexity a struggling provider (mainly Ollama) tripped over in the first
   place, which a same-schema retry wouldn't.
4. The count-based batch cap (e.g. 20 patches) doesn't guard against a handful of large patches
   collectively costing more than a full regenerate — added a second, byte-size-based cap.
5. Confirmed the same contradiction I'd independently caught myself while round 5 was in flight (see
   note above) — one half of it had been fixed in round 4, the other ("generate()'s signature is
   unchanged," in an earlier section) had not. Fixed both occurrences to state precisely what changes
   (the `basedOnContent`-present caller's return type) vs. what doesn't (existing callers' parameter
   list).
6. The "schema enforces the boundary" claim overreached — the schema only rules out a *new top-level
   sibling*; within-subtree content addition (not just removal) is schema-legal, contradicting the
   Goal section's "style/content only" framing as a hard boundary. Reworded to state the schema's
   actual, narrower guarantee precisely.
7. The unreachable (per the round-4 purity argument) phase-2 vanish backstop used the staleness
   message if it somehow fired — misleading, since by the same purity argument nothing actually
   changed if it does fire; it would mean an internal bug, not user-facing staleness. Gave it its own
   "internal consistency error" message, logged as an error.
8. Observability's `appliedMode` was non-optional, but a trust/read/staleness rejection returns before
   any mode is ever determined — a real type hole. Made it optional, added `outcome`/`failureStage`
   fields so failed calls log something meaningful instead of a garbage or absent mode.
9. **Genuinely subtle, accepted as a real gap.** The dry run only catches *forward* mid-batch
   invalidation (patch A removes patch B's target). It doesn't catch the *reverse* — patch B
   overwriting an ancestor's subtree after patch A already edited a descendant within it, silently
   discarding A's edit with no error. Given the narrow trigger (two patches in one batch, one's target
   an ancestor of another's, ordered ancestor-after-descendant) and that the output stays well-formed
   (missing an edit, not corrupted), this is documented as a known, accepted limitation rather than
   built out further — same treatment this spec already gives the cross-process locking gap.

**Self-caught during this round (before DeepSeek's answer came back):** the "Tool schema fork"
section's opening sentence still read "signature is unchanged," a stale leftover from round 4's fix
that only corrected the *restatement* in the later "Layering" section, not this original occurrence —
DeepSeek's finding #5 above independently caught the same thing.

## Where this stands: 5 rounds, 60 total findings, 2 rejected after verification, everything else
## fixed. Per the skill's deadlock protocol (cap reached on a REVISE, not a convergence), this is not
## being presented as "approved" — see the message to the user for the honest final state and the
## question of how to proceed.
