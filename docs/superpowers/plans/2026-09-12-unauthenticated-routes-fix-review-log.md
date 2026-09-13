# DeepSeek plan review — 2026-09-12-unauthenticated-routes-fix.md

## Round 1 — DeepSeek

6 findings, full text in session transcript (not reproduced here — see the plan file's own
"Why this is real" section, which now embeds the one load-bearing correction). Summary:

1. **Confirmed, load-bearing.** Plan's original justification argued a cross-origin CSRF via
   browser `fetch()` (CORS "simple request," no preflight). False: `SESSION_COOKIE_OPTIONS` sets
   `sameSite: 'lax'`, which withholds the cookie from a cross-site non-top-level request — the
   described attack wouldn't carry a session cookie either way. Verified directly against
   `lib/utils/session.ts`. Does not change the fix (still needed) but the stated reasoning was
   wrong. Rewrote the plan's "Why" section to the simpler, correct framing: zero auth means any
   direct request succeeds, no cookie or CSRF angle required at all.
2. Guard-placement-order nitpick (before vs. after `params` resolution) — stylistic, not a defect.
   Not acted on.
3. `git/push`/`git/abort` have no try/catch today, so an unhandled throw from the new guard call
   gets no logging — true, but these handlers already have zero error handling for their existing
   `gitService` calls; the guard doesn't introduce a new gap, it inherits an old one. Already
   explicitly out-of-scope in the plan. Not acted on.
4. **Confirmed, load-bearing.** Plan's own test-strategy text for the 4 git routes was genuinely
   ambiguous ("mock the same way ... if such a pattern exists, otherwise...") — checked and no
   `vi.mock('@/lib/services/GitService', ...)` precedent exists anywhere in `test/`; every existing
   GitService test uses a real temp-git-repo fixture. Committed to a specific approach instead:
   mock `gitService` inline in the new auth-only test file (testing the route's new guard, not
   GitService's git logic, which is already covered elsewhere). Plan text updated.
5. Claimed `test/asepritePathSettings.test.ts` might have no GET test to preserve — checked, false:
   `describe('GET/PUT /api/settings/aseprite-path')` already has 2 tests exercising GET
   (`'GET returns an empty path...'`, `'PUT saves the path, and a subsequent GET returns it'`). The
   plan's existing instruction to thread the cookie through "any direct GET call" already covers
   these. No change needed.
6. Cookie-name-hardcoding observation — true but trivial, no action needed (one constant, one
   consumer, already consistent).

**VERDICT: APPROVED** (DeepSeek's own bottom line, after listing the 6 findings above).

Claude's response: 2 of 6 were real and load-bearing (1, 4) — both fixed directly in the plan file.
2 were true but already explicitly out-of-scope by the plan's own design (3, and non-actionable
nitpick 2). 1 was false, checked against the live test file (5). 1 was trivial, no action (6).
Plan is ready to dispatch as-is.
