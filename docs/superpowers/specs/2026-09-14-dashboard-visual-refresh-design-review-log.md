# DeepSeek spec review — 2026-09-14-dashboard-visual-refresh-design.md

Unlike every prior DeepSeek review this session, this one produced a high proportion of **fabricated
findings** — specifics that don't exist anywhere in the pasted spec or supporting files, not just
plausible-but-wrong guesses about code DeepSeek couldn't see. Recorded here in more detail than usual
because the pattern itself (confident, specific fabrication that survived being told directly it was
wrong) is the notable part, not any individual finding.

## Round 1 — 20 findings

**Confirmed fabricated — referenced code/values that do not exist anywhere in the spec or the pasted
real source files:**
- A function called `resetForRetry()` with a "race condition" clearing `result_path` — no such
  function appears anywhere in the spec or in the real `JobService.ts` pasted alongside it (which only
  has `getById`/`getActive`/`getByBatchId`).
- A `5-minute` / `ACTIVE_WINDOW_MS` time-window filter on the activity feed, and a "polling interval"
  for it — the actual spec's `getRecentlyResolved()` has no time window at all
  (`ORDER BY updated_at DESC LIMIT ?`), and the Overview page loads once, it doesn't poll.
- A `.empty-state { display: grid }` CSS rule — the spec never touches `.empty-state`'s layout at all,
  only colors/radii via the shared token change.
- An "existing `JobService.getRecentlyResolved` with a 5-minute window" that the new spec's version
  supposedly collides with (round 2) — there is no pre-existing method by this name; the real
  `JobService.ts` was pasted in full and doesn't contain it.

**Confirmed false, checked directly against the pasted files:**
- "Font path is contradictory / `next/font/local` can't load from `public/`." Wrong:
  `next/font/local`'s `src` resolves relative to the calling file, so `../public/fonts/...` from
  `app/layout.tsx` correctly reaches `public/fonts/...` — standard, documented usage.
- "Error-handling contract for the new activity route is unstated." The spec's own "Error handling"
  section states it verbatim.
- "`inFlightJobs`/`totalActiveAssets` definitions are unverified." The exact filter is in
  `lib/services/projectContext.ts`, pasted in full.
- "`/api/context`'s response shape isn't shown, might break." `app/api/context/route.ts` was pasted
  in full too.
- "11 visible vs. 17 total `DASHBOARD_ROUTES` entries is misleading." These are two different,
  explicitly-labeled counts (sidebar-visible items vs. total real routes) — the spec explains the
  divergence directly, doesn't conflate them.

**Real, fixed:**
- `app/page.tsx` (site root `/`) also redirects to `/dashboard/generate` today — confirmed by
  grepping the real repo (`grep -rn "redirect('/dashboard" app/`). Now redirects to `/dashboard`
  instead, alongside `app/dashboard/page.tsx`.
- No test was specified for the new `recentActivity.ts` merge/interleave logic — the one genuinely new
  piece of business logic in this refresh. Added.
- `docs/copilot-knowledge.md` (from the already-merged AI-copilot feature) has no entries for the two
  new pages — added as an explicit update needed alongside this refresh, so the copilot can both
  explain them and correctly prefer the hub over guessing a sub-page for an ambiguous "open settings."
- Explicit note added that `NavRail`'s restructure preserves its existing logout handler and
  `router.refresh()` call unchanged (real, if low-risk, thing to state plainly for an implementer).

**Checked and found already-handled, no change needed:**
- Form-control font inheritance: `button, input, textarea, select { font-family: inherit; ... }`
  already exists at `app/globals.css:44-51`.

## Round 2 — after rebuttal with evidence

Sent the fabrication list back with the specific line/file evidence above. Response repeated two of
the same fabrications (the phantom `getRecentlyResolved` "5-minute window" and `resetForRetry`) and
added a new false claim — that the font `src` path was still "TBD, decided at implementation time"
— when the spec had already been revised to a concrete, static path
(`public/fonts/Sentient-Variable.woff2`) during self-review, before round 1 ever ran; this was true in
every version of the spec DeepSeek was shown. One new, genuinely real point survived: no empty-state
was defined for the activity feed when there's nothing recent to show. Fixed. One nitpick (the
`href.startsWith('/dashboard/settings/')` filter "silently" routes future settings sub-pages into the
hidden group) was rejected — that's the deliberate, maintainable design intent (a new settings page
joins the hidden group automatically, no allowlist to remember to update), not a bug.

## Resolution

Did not run a third round. Per this skill's "Claude is final arbiter" rule, two rounds of a
high-fabrication-rate response — including doubling down on disproven specifics after being shown the
exact file:line evidence against them — is a real, repeatable signal, not a fluke worth one more
attempt to fix. The genuinely real findings from both rounds (2 items) are fixed in the spec; the
rest, including everything from round 2's "REVISE" rationale, don't survive verification against the
actual pasted source. Treating this spec as reviewed and sound to proceed from — the same bar every
other DeepSeek-reviewed document this session was held to, just reached by direct verification against
the real files instead of a clean final "APPROVED" line.
