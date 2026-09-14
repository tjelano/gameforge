# DeepSeek spec review — 2026-09-14-dashboard-visual-refresh-design.md

**Correction (post-hoc):** this log originally accused DeepSeek of fabricating `resetForRetry()` and
`ACTIVE_WINDOW_MS`/a 5-minute job window. That accusation was wrong and has been corrected below. The
Claude-side verification during the review used `grep "async get"` against `JobService.ts`, which
silently excludes a method named `resetForRetry` (it doesn't start with "get") — both `resetForRetry()`
and `ACTIVE_WINDOW_MS` are real, existing code in the real file, confirmed by reading it in full
afterward. The findings below are re-triaged against that corrected understanding. What remains
genuinely fabricated (the `.empty-state { display: grid }` claim, and round 2's specific "an existing
method literally named `getRecentlyResolved`" framing) is unaffected by this correction — those were
checked by full-file reads and Next.js semantics, not the flawed grep.

## Round 1 — 20 findings

**Confirmed fabricated — checked against the real, fully-read source, not the flawed `async get` grep:**
- A `.empty-state { display: grid }` CSS rule — the spec never touches `.empty-state`'s layout at all
  (only colors/radii via the shared token change), and the real current CSS has no `display` set on
  `.empty-state` either (block by default).

**Real, but out of this spec's scope — not fabricated, just not actionable here:**
- `resetForRetry()`'s "race condition" (clears `result_path` before the caller frees the old image
  file). This method and its documented caller contract are real, existing `JobService` code — but
  this visual-refresh spec neither creates, calls, nor modifies it. A legitimate finding about
  pre-existing code, out of scope for a visual/nav refresh.
- `ACTIVE_WINDOW_MS` (a real 5-minute constant) and `getActive()`'s inclusion of recently-terminal jobs
  — real, existing code, but it serves the Jobs page's live-polling "just finished" display, a
  different method for a different purpose than this spec's new `getRecentlyResolved()` (which has no
  time window at all, just `ORDER BY updated_at DESC LIMIT ?`). No actual collision or shared code
  path — but real enough, and similar-sounding enough, that a one-line clarifying note was added to
  the spec so a future reader isn't left wondering about the relationship between the two.

**Still fabricated even after the correction — round 2's specific framing:**
- "An existing `JobService.getRecentlyResolved` with a 5-minute window" that the new spec's method
  supposedly collides with. No method by this literal name exists in the real file (only `getById`,
  `getActive`, `getByBatchId`, `create`, `resetForRetry`, `delete`) — this was DeepSeek conflating the
  real `ACTIVE_WINDOW_MS` pattern from `getActive()` with the new method's name, not citing something
  that's actually there under that name.

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

## Round 2 — after rebuttal (rebuttal itself was partly wrong)

Sent back a fabrication list that incorrectly included `resetForRetry()` and `ACTIVE_WINDOW_MS` — see
the correction note at the top. DeepSeek's round 2 response held its ground on both and repeated them;
at the time this was logged as "doubling down on disproven specifics," but the specifics weren't
actually disproven — the rebuttal itself was wrong, built on an incomplete `async get` grep rather than
a full read of `JobService.ts`. What DeepSeek got wrong in round 2 on its own merits: it framed the
5-minute window as belonging to "an existing `getRecentlyResolved`" method, which doesn't exist under
that name — the real 5-minute window lives in `getActive()`, a different method. It also claimed the
font `src` path was still "TBD, decided at implementation time," which was false in every version of
the spec it was shown — that path had already been made concrete during self-review before round 1
ever ran. One new, genuinely real point survived: no empty-state was defined for the activity feed
when there's nothing recent to show. Fixed. One nitpick (the `href.startsWith('/dashboard/settings/')`
filter "silently" routes future settings sub-pages into the hidden group) was rejected — that's the
deliberate, maintainable design intent (a new settings page joins the hidden group automatically, no
allowlist to remember to update), not a bug.

## Resolution

Did not run a third round — at the time, for the wrong reason ("high fabrication rate," per the
now-corrected claims above). In hindsight the right reason to stop was narrower: round 2's only actual
new problems (the `getRecentlyResolved`-naming mix-up, the stale font-path claim) were both cheap to
resolve directly, and everything else across both rounds had already been checked against real source.
Fixed in the spec: the site-root redirect, a test for the new activity-feed merge logic, the
`docs/copilot-knowledge.md` update, the NavRail logout-preservation note, the activity-feed empty
state, and a clarifying note distinguishing the new `getRecentlyResolved()` from `getActive()`'s
unrelated `ACTIVE_WINDOW_MS`. Treating this spec as reviewed and sound to proceed from.
