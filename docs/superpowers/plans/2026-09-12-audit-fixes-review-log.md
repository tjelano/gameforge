# DeepSeek adversarial review — 2026-09-12-audit-fixes.md

Run retroactively, after Tasks 1-2 were already implemented/reviewed/merged (the plan's own
pre-execution DeepSeek pass was skipped by oversight — caught by the user mid-execution). Scoped to
the 34 remaining tasks (3-36), split into 6 chunks by Part (further split where a Part exceeded
~40KB, the proxy's practical payload ceiling), each an independent DeepSeek history/call — not a
shared growing thread — with the plan's Global Constraints and a "Tasks 1-2 are done, trust them"
note prepended to every chunk.

Every finding below was checked against the actual current plan text and/or live code before acting
— DeepSeek has no filesystem access, so every claim is a guess until verified. Claude is final
arbiter throughout.

## Round 1 — Tasks 3-6 (VERDICT: REVISE)

9 findings raised. All 5 "Important" ones were false positives once checked:
- Admin bypass tests assume `userService.create({name:'Admin'})` becomes admin without an explicit
  flag — checked `lib/services/UserService.ts:38-47`: the first user ever created in that test's
  isolated DB *does* auto-become admin (`existingCount === 0 ? 1 : 0`), and both flagged tests
  create "Admin" first. Not a bug.
- `@/lib/database` barrel import questioned — already confirmed working (read in `StyleService.ts`
  earlier this session).
- `app/api/assets/[id]/component/route.ts` assumed not to have `user` in scope — checked: it does
  (`route.ts:21`, `const user = await getCurrentUser(req)`).
- Migration-setup-in-tests concern (no explicit `runMigrations()` call) — this exact pattern is
  already proven working in the just-merged Task 2 test suite (689/689 passing).
Remaining items were either already-known future dependencies (noted in the plan itself) or minor
UX nice-to-haves. **No plan change made.**

## Round 2 — Tasks 7-9 (VERDICT: REVISE)

7 findings. Most speculative test-mock-fragility concerns that the SDD process's own
implementer+reviewer loop already guards against structurally. One (`error.message` leaked to
client in 500 responses) is real in the abstract but is the established, already-reviewed
codebase-wide convention (confirmed identical pattern already passed Task 2's review) — out of
scope for a "wrap in try/catch" task to silently change project-wide. One (hardcoded retry-status
set duplicating `JobCard.tsx`'s `canAct`) is a legitimate but minor DRY nit for 2 call sites — not
worth an extraction. **No plan change made**; both noted as backlog watch-items, not blockers.

## Round 3 — Tasks 10-17 (VERDICT: REVISE)

8 findings. Confirmed false: Task 12's `STYLE_NOT_FOUND` route-mapping (already wired into
`ExportSiteErrorKind`/`ERROR_MESSAGES` per the plan text), circular-import risk between
`SiteExporter`↔`StyleService` (checked `StyleService.ts` — imports nothing from `SiteExporter`),
Task 15's "ambiguous path" (the plan text already tells the implementer to verify the exact caller
file). One real, pre-existing finding: Task 14's `GitService.exportToJson()` refactor (both the
"current" and "replacement" snippets) has zero try/catch around its `fsPromises.writeFile` calls,
technically violating AGENTS.md's blanket fs-try/catch rule — but this predates the plan entirely
and Task 14's explicit scope is a mechanical loop-dedup, not a safety audit. **No plan change
made** — logged as a separate future backlog item (adding try/catch to `GitService.exportToJson()`
proper), not folded into Task 14 to avoid scope creep on a mechanical refactor.

## Round 4 — Tasks 18-21 (VERDICT: REVISE)

5 findings. Confirmed false: the two "one-line mock fixup" tests in `themeGenerator.test.ts` and
`pageLayoutSuggester.test.ts` were checked directly — neither asserts `toHaveBeenCalledTimes`, so
the plan's `mockResolvedValueOnce`→`mockResolvedValue` fix is sufficient. The retry-helper
"duplication" finding was already an explicit, deliberate, documented decision in the plan's own
pre-flight conflict-scan table (different API shapes) — re-litigating a settled decision, not a new
finding. Two real but minor: no test for "all retries exhausted then throws," and the backoff delay
isn't linked to the caller's abort signal (currently unreachable in practice — `worker.ts`
constructs no `AbortController` yet, per Task 20's own note). **No plan change made** — both carried
forward as inline notes for Task 21's dispatch rather than plan edits, since they're additive
(extra test case, defensive-but-currently-dead-code-path).

## Round 5 — Tasks 22-25 (VERDICT: REVISE)

2 findings + 2 minor. One real: Task 22's `markJobFailed()` helper (as specified) only does the SQL
update — the instruction to "replace" the 3 existing call sites is ambiguous about whether their
adjacent, distinct `console.error` messages ("has malformed options JSON" vs "has invalid UI sheet
options" vs generic) survive. Checked `worker.ts` directly: all 3 currently have their own
`console.error` line. One confirmed false: Task 23's size selector is not "unconditionally visible
across asset types" — `/dashboard/generate` is GameForge's dedicated sprite-only page (themes/
components/ui-sheets each have their own separate page), so there's no type-switch to guard.
**Plan change:** none yet — this is a dispatch-time clarification for Task 22 (keep each call site's
existing `console.error` line untouched, only swap the SQL-update line for `markJobFailed(...)`),
carried in that task's dispatch prompt rather than a plan edit, since the fix is procedural
(preserve existing behavior) not a code change to the plan's snippet.

## Round 6 — Tasks 26-36 (VERDICT: REVISE) — the one real, plan-blocking catch

5 findings. **Confirmed real and load-bearing:** Task 26's `useStyles`/`useJobStore` replacement
code only sets `error` inside `catch` (network-level failure) — there is no `else` branch when the
server responds with valid JSON `{success: false, error: '...'}` (the exact shape every route in
this codebase already uses on failure), so a real server error would still be silently swallowed,
completely defeating the task's own stated purpose. Task 29 inherits the same bug by explicitly
saying "mirror Task 26 exactly." **Plan fixed**: added `else { setError(body.error ?? 'Request
failed.') }` / `else { set({ error: body.error ?? 'Request failed.' }) }` to all 3 affected blocks
in Task 26's file-replacement snippets, and updated Task 29's prose to name the else-branch
explicitly so it isn't lost in the "mirror" paraphrase. Confirmed false: the "race condition" in
`refresh()` (no `ignore`-flag guard) is a pre-existing, explicitly-documented deliberate design
choice already in the live `useStyles.ts` (see its own comment, lines 18-22) — not a regression, not
new. Confirmed non-blocking: Task 28's "depends on 27 too" (true in spirit, but this plan's tasks
always execute in strict task-number order regardless of the "Depends on" annotation, so it can't
actually run out of order in practice).

## Overall

6 chunks, 1 real plan-blocking defect found and fixed (Task 26/29's swallowed-server-error bug),
2 real-but-out-of-scope pre-existing gaps logged as backlog (not folded into these tasks), 2 real
minor additive notes carried into future dispatch prompts, ~25 other findings verified false once
checked against actual code/plan text. Net: DeepSeek's per-chunk true-positive rate on "Important"
findings was roughly 1-in-5, consistent with it having no filesystem access and no execution-order
context — but the one it got right would have propagated through 5+ downstream tasks (27-31, 35)
building UI atop a permanently-null error field. Worth the ~$0.02 and ~10 minutes.
