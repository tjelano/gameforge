# DeepSeek plan review — 2026-09-14-dashboard-visual-refresh.md

Two chunks (Tasks 1-3, then Tasks 4-7), one history. Every finding checked against the actual plan
text before acting — most of this round's findings didn't survive that check (either factually wrong
against what the plan actually says, or already covered by an existing test/guard the reviewer didn't
fully register), but a few real ones did, including one caught only because DeepSeek's suggestion
prompted a recount.

## Real, fixed

1. **Broken intermediate link.** The original task order put the Settings hub page 3 tasks after the
   sidebar restructure that adds a "Settings" sidebar link pointing at it — clicking that link during
   that window would 404. Fixed by moving the Settings hub to Task 3, immediately after the sidebar
   restructure (Task 2), closing the window entirely rather than just documenting it.
2. **Unsafe font-file deletion.** `cp` immediately followed by `rm -rf` on the only source, with no
   check that the copy actually succeeded. Added a `test -s` verification gate before the delete.
3. **Arithmetic error, confirmed by direct count.** The plan said "9 tool links" / "11 visible links
   total" in several places. Counting the real `DASHBOARD_ROUTES` array (17 entries: 1 Overview + 10
   tools + 1 Settings hub + 5 settings sub-routes) gives 10 tools and 12 visible sidebar items, not 9
   and 11. Fixed throughout. (DeepSeek's actual suggestion was "derive the count instead of
   hardcoding it," not "the count is wrong" — but chasing that suggestion is what surfaced the real
   error.)
4. **Type-safety improvement, no real cost.** The Overview page redeclared local `ContextData`/
   `ActivityItem` interfaces instead of importing the real types from `projectContext.ts`/
   `recentActivity.ts`. Both are plain, client-safe type-only exports, so importing them directly
   removes a real (if minor) drift risk for free. Fixed.
5. **Clarifying comment, not a bug.** Added a one-line explanation in `getRecentlyResolved()`'s doc
   comment for why `'complete'` status is deliberately excluded from the activity feed (it means
   "awaiting your decision," not a resolved outcome) — DeepSeek's confusion here was reasonable even
   though the design itself was already correct.

## Checked and found false or already-addressed

- "`resetForRetry`-style race condition" style concerns didn't recur here since this plan's own test
  code was fully re-read line-by-line before triage (a deliberate habit adopted after the spec-review
  mistake earlier this session) — no repeat of that error.
- "Ordering/status filtering aren't tested" (Task 4's `JobService` test): false — the test has three
  dedicated cases for exactly this, verified by re-reading the actual test code in the plan.
- "The route has no error path" / "the page's non-fatal handling is never exercised" (Task 5's route):
  false — the route's shown code has a complete try/catch returning `{success:false,error}` at 500.
- "The activity-merge test never exercises truncation, only exactly 8 items" (Task 5): false — the
  test creates 10 jobs specifically to exercise the >8 truncation path.
- "The `DASHBOARD_ROUTES` code block is cut off mid-array, can't verify the settings sub-routes
  remain": checked directly against the exact chunk file sent to DeepSeek — the array was complete,
  all 17 entries present, properly closed. Not a chunking artifact; the claim was simply wrong.
- "Global Constraints say `--font-sans` is unchanged, contradicting the plan changing it": no
  `--font-sans` variable exists anywhere in this codebase or this plan — the real, only-ever-mentioned
  names are `--font-display`/`--font-body`/`--font-mono`, and only `--font-mono` is the protected one.
- Several test-boilerplate concerns (migration-copy pattern, `afterEach`'s `if (tempRoot)` guard,
  `DatabaseConnection.resetForTests()` auto-running migrations) — all exactly the same, already-proven
  patterns used in every other test written this session across two full feature plans; not a gap
  specific to this plan.
- A handful of intentional, load-bearing design choices restated as if they were oversights (the
  Settings hub's hardcoded 5-route list instead of deriving from `DASHBOARD_ROUTES`, `getActiveStyles()`
  having no SQL-level limit before the in-memory slice, no dedicated route-level test for a trivial
  untested-by-precedent wrapper route) — each checked against either explicit YAGNI/precedent
  reasoning or this app's real, 2-person scale, and left as designed.

## Resolution

`VERDICT: REVISE` on the final chunk, for reasons that were mostly unfounded once checked directly
against the real plan text (not just plausible-sounding). Five real, fixable points survived scrutiny
and are now fixed, including a real arithmetic error DeepSeek didn't itself catch but whose alternate
framing prompted a direct recount that did. Ready to execute.
