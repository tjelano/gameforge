# Website Builder Workbench — SDD execution log

Archived from the gitignored `.superpowers/sdd/2026-09-24-website-builder-workbench/progress.md`
ledger before worktree removal (per `feedback_archive_sdd_ledger_before_worktree_removal`). Covers
subagent-driven execution of `docs/superpowers/plans/2026-09-24-website-builder-workbench.md`, after
its own pre-execution DeepSeek plan review (see `2026-09-24-website-builder-workbench-review-log.md`).

Final commit range: `22ae0be..bba7891` (11 commits: the plan doc + 8 tasks + 1 mid-task fix round +
1 post-final-review fix).

## Pre-flight conflict scan

Checked every pair of tasks sharing a file/interface (Task 1→3, 2→4, 3→6, 4→6, 5→6, 6→7) for name/
shape mismatches, plus every task's own test-vs-implementation self-consistency, plus the plan's
Global Constraints (no `allow-scripts` anywhere, iframe-DOM reads confined to `inspectFrame.ts`, CSP
unchanged, non-editable rendering byte-for-byte regression tests present, patch-element endpoint
untouched, no new npm dependency). Scan was clean — no rulings needed before execution began.

## Per-task outcomes

- **Task 1** (`composeEditablePageHtml`, `lib/services/pageDocument.ts`) — clean, Approved. 1 cosmetic
  Minor (commit trailer said "Claude Haiku 4.5" instead of the required "Claude Sonnet 5" — the
  dispatched implementer used its own model identity rather than the literal text given).
- **Task 2** (`componentAssetId`/`componentRevisionHash`, `lib/preview/inspectFrame.ts`) — REOPENED
  after Task 3's implementer ran `tsc` and found a cross-file consequence Task 2's own scope missed:
  `test/elementPatchPanel.test.tsx`'s `selectionOf()` helper builds a `FrameElementInfo`-shaped object
  missing the two new required fields, breaking typecheck. **Ruling:** fixed by resuming the original
  implementer to add the two `null` defaults there (matching the identical fix Task 4's own brief
  already specified for a different helper). Fixed in one round; the fix also proactively pre-applied
  Task 4's own Step-1 edit to `previewFrame.test.tsx`, which Task 4's dispatch was told about.
- **Task 3** (`?editable=1` render mode) — clean, Approved. 2 Minor, both plan-mandated (unconditional
  `hashDocument()` cost regardless of mode; a reused `html` identifier across two block scopes) —
  negligible cost, not fixed.
- **Task 4** (`kind: 'page'` + function-form `patchEndpoint` in `PreviewFrame.tsx`) — clean, Approved.
  Reviewer independently proved a self-disclosed implementer deviation (adding `isEditablePreview` to
  a `useCallback` deps array) was a genuine behavior-neutral no-op. 1 Minor deferred (3 doc comments
  now describe only half of the behavior they should).
- **Task 5** (Website nav group, `lib/dashboardRoutes.ts` + `NavRail.tsx` + `globals.css`) — clean,
  Approved. 1 Minor, plan-mandated (the "Website" group label sits directly above a route also
  labeled "Website" — cosmetic, as specified).
- **Task 6** (workbench page shell) — the original implementer subagent hit a session rate-limit
  mid-task and terminated without committing or reporting; not reachable via SendMessage afterward. A
  fresh implementer verified and finished the already-substantially-complete, correct work rather than
  restarting. Clean, Approved after a full live-browser Playwright smoke check (login → create Style
  Bible → create/select a page → live preview → reload → re-select, zero console/server errors). 2
  Minor deferred, both plan-mandated (a function unused until Task 7 wires it in; a missing try/catch
  matching a pre-existing inconsistency already present elsewhere in the codebase).
- **Task 7** (inline "Generate new component") — implementer reported DONE_WITH_CONCERNS: it correctly
  backed off mid live-smoke-check after observing what looked like concurrent dev-server/DB activity,
  to avoid risking corruption of another session's state. Investigated directly: no other real Claude
  session was running; the actual cause was a **stale `next dev` process left running from Task 6's
  own earlier smoke check, never shut down** — a process-hygiene gap, not a real hazard. Killed the
  stale process directly. Separately, the review surfaced a genuine **Important** finding (plan-
  mandated, not implementer-introduced): `handlePromoteJob` had no error/catch handling, and a real
  failure path exists (a second, non-owning user can see and click "Promote" on someone else's job via
  the globally-visible active-jobs list and get a real 403 with zero UI feedback). **Ruling:** fixed
  in the same task rather than deferred, since Important findings enter the fix loop regardless of
  plan-mandated origin. Fixed in one round, re-review confirmed addressed with no new breakage.
- **Task 8** (end-to-end manual verification) — full automated suite clean (1281/1281 tests, `tsc`
  clean, `eslint` clean, zero regressions branch-wide). All 7 live-verification items passed with
  concrete evidence (network logs, independently-patched on-disk files, curl output), including both
  items flagged by earlier reviews as needing empirical closure: the non-owner 403 now shows real UI
  feedback, and a click on the *second* of two composed components resolves to and patches that
  component specifically — the core novel behavior this feature exists to deliver. One out-of-scope
  finding noted, not fixed here: `MockComponentGenerator.generate()` (untouched by this plan) never
  assigns `data-gf-id`, so click-to-edit is unselectable against mock-generated content when no real
  generation API key is configured — a pre-existing gap outside this plan's 8 tasks.

## Final whole-branch review

Claude final reviewer (most-capable tier): **"Ready to merge: Yes."** Zero Critical/Important.
Independently re-verified (not just re-read) the hash-matching argument between the render route and
the patch service, the unescaped-attribute-safety argument, the "only `inspectFrame.ts` reads
`contentDocument`" invariant (repo-wide grep), and backward compatibility for every other
`PreviewFrame`/`DASHBOARD_ROUTES` consumer — then independently re-ran the full `vitest`/`tsc`/`eslint`
gate, matching Task 8's numbers exactly. One new Minor noted (`NAV_PRIMARY_ROUTES` no longer has a
real production consumer besides its own test) — harmless, not acted on.

### DeepSeek Mode 2 cross-model review (whole branch)

Run once, over the whole branch diff, as a pre-merge gate — this project's own standing mandate calls
for this per-task during execution, which was missed this run (a repeat of a previously-flagged gap;
see the `feedback_deepseek_during_sdd_execution` memory). 7 findings, each verified directly against
the real code before acting:

1. **hashDocument mismatch risk** — REJECTED. Already directly verified twice (Task 3's own review and
   the plan's own pre-execution review): both the render route and `componentPatchService.ts` read the
   identical file path with the identical `'utf-8'` encoding and call the identical `hashDocument`
   function. DeepSeek itself flagged it couldn't confirm this without seeing
   `componentPatchService.ts`.
2. **`.rail-group-label:first-of-type` never matches** — **CONFIRMED REAL.** `:first-of-type` matches
   the first `<div>`-type sibling under `<nav>` (which is `.rail-brand`), not the first element with
   class `.rail-group-label` — so the intended 8px top-margin override for the first nav group label
   silently never fired; "Assets" always got the full 16px. Verified directly against the shipped CSS
   and `NavRail.tsx`'s real render order. DeepSeek's own suggested fix
   (`.rail-brand + .rail-group-label`) was *also* wrong (not an adjacent sibling in the real DOM — an
   `<a>` link sits between them). **Fixed correctly** with the general-sibling-combinator approach
   (base rule gets 8px, `.rail-group-label ~ .rail-group-label` gets 16px) — commit `bba7891`.
3. **`patchEndpoint` resolving to `''` still passing `PreviewFrame`'s `patchEndpoint && selection`
   gate** (which checks prop truthiness, not the resolved value) — REJECTED as a live bug. Already
   traced twice, independently, by two different Claude reviewers (Task 6's and the final review):
   `componentAssetId === null` structurally implies `dataGfId === null` in composed-page markup (every
   `data-gf-id` element is nested inside a `data-gf-component-asset-id` wrapper by construction), so
   `ElementPatchPanel`'s own `unselectable` gate always disables Apply before an empty-string endpoint
   could ever be POSTed to. A real structural observation, not an exploitable defect.
4. **`hashDocument` cost on the export/download path too** — already-known, already-triaged Minor from
   Task 3's own review; re-discovered, not new.
5. **Unguarded `JSON.parse(component_asset_ids)`** — already litigated during the plan's own
   pre-execution DeepSeek review; matches an identical, already-shipped unguarded pattern for the same
   field elsewhere in this codebase (`app/dashboard/styles/[id]/page.tsx`).
6. **A new `inspectFrame.ts` test allegedly reusing a prior test's leftover DOM** — REJECTED. The exact
   same false claim DeepSeek made during the plan's own pre-execution review, re-verified false again:
   `beforeEach` recreates the test fixture fresh before every single test, including this one.
7. **The render route's `?editable=1` discloses `assetId`+`revisionHash` with no auth check of its
   own** — verified directly: this route has *never* had an auth check (no `getCurrentUser` import,
   confirmed by reading it), and this plan doesn't change that. Not a new vulnerability: a
   `revisionHash` is a staleness check, not a credential, and the actual mutation surface (the
   patch-element endpoint) carries its own independent, untouched auth+ownership check. A pre-existing
   app design characteristic, not something this plan introduces.

**Outcome:** 1 of 7 findings real (the CSS selector bug), fixed; 6 of 7 were false positives or
already-known/triaged items — consistent with this project's own calibration note that DeepSeek
findings need independent verification before acting, with roughly a 1-in-5 (here 1-in-7) real hit
rate.

## Rulings made during execution

1. Task 2's cross-file `tsc` breakage (test helper missing two new required fields) — fixed by
   resuming the original implementer; cost if wrong: a second small test-file edit, nothing else.
2. Task 7's `handlePromoteJob` missing error handling — fixed in-task despite being plan-mandated
   code, since Important findings always enter the fix loop; cost if wrong: reverting a 10-line,
   already re-reviewed diff.
3. The final DeepSeek review's one real finding (CSS selector) — fixed correctly (with a different
   selector than DeepSeek's own incorrect suggestion); cost if wrong: purely cosmetic sidebar spacing,
   zero functional risk.

## Pre-push review finding (caught after the final review, before push)

The mandatory pre-push-review pass (a fresh subagent, different focus than the final code review)
found one more real, previously-uncaught bug — missed by every earlier pass (8 task reviews, 1 final
whole-branch review, 1 DeepSeek cross-model pass): `app/components/ElementPatchPanel.tsx`'s remount
key, `key={selection.dataGfId ?? 'unselectable'}`, was built for PR #32's single-component preview
mode, where `dataGfId` really is unique within the one document being previewed. This branch's whole
purpose — composing multiple components onto one page — breaks that uniqueness assumption:
`dataGfId` sequences independently restart at 1 per component, so two different composed components
can share the same local id (the exact case `test/inspectFrame.test.ts`'s own "resolves
componentAssetId... from the nearest wrapper" test deliberately exercises). Selecting an element in
component A, typing a partial edit instruction, then clicking a same-numbered element in component B
would silently carry the stale instruction text over (React reuses the panel instance instead of
remounting it, since the key didn't change) — and applying it would edit the wrong component with no
visual cue.

**Ruling:** fixed immediately rather than pushing with a known correctness bug, per the pre-push-review
skill's own "stop, don't push, let the human decide" protocol — the human chose "fix it now, then
push." Fix: the key now also incorporates `selection.componentAssetId` (`` `${componentAssetId ?? ''}:${dataGfId ?? 'unselectable'}` ``),
which is always `null` in single-component mode, making the change a no-op there — verified by the
full existing `elementPatchPanel.test.tsx` suite (12 pre-existing tests) passing unchanged. A new
regression test reproduces the exact collision (TDD: confirmed RED against the old key, GREEN after
the fix). Commit `185eb61`. Cost if the fix were somehow wrong: reverting a 13-line, fully tested,
single-file change with no other consumers.

**Branch is ready to merge. No open Critical/Important findings anywhere — including the pre-push gate.**
