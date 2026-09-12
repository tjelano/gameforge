# Unauthenticated Routes Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a login check to the 7 route files (8 handlers) that currently have none, closing a real security gap found by the final whole-branch review of `docs/superpowers/plans/2026-09-12-audit-fixes.md` (PR #23) but deliberately excluded from that PR's scope because it spans different subsystems than anything that plan touched.

**No separate spec file** — this plan argues directly from that review's own finding, already independently re-derived against live code (confirmed in this session: none of the 7 files call `getCurrentUser` anywhere). The finding is the spec.

## Why this is real, not theoretical

All 7 handlers have **no authentication check at all** — not "weak," not "bypassable under some condition," just absent. Any request that can reach the server — `curl`, a script, another process on the same machine or network, anyone who can open a TCP connection to the port `next dev`/the deployed app listens on — triggers a git push/pull/merge-abort, spawns a local Aseprite process, deletes files, or reads/writes the configured executable path, with **no session cookie, no credential, nothing**. The dashboard UI gating these actions behind a login screen does not stop this, because the attack never touches the dashboard UI at all — it calls the route directly.

(An earlier pass at this plan argued these were also exploitable as a cross-origin CSRF via a browser `fetch()` from any site the user has open, reasoning that POST-with-JSON counts as a CORS "simple request" needing no preflight. That framing doesn't hold: `lib/utils/session.ts`'s `SESSION_COOKIE_OPTIONS` sets `sameSite: 'lax'`, and browsers withhold a `Lax` cookie from a cross-site, non-top-level request — a cross-origin `fetch()` POST would arrive with no cookie and 401 under either the old or new code. Caught by DeepSeek adversarial review before this plan was dispatched; corrected here. The CSRF angle doesn't apply, but the underlying defect — zero auth, full stop — stands on its own and doesn't need it.)

`lib/services/shared/editDecision.ts` (lines 36-40) has a comment justifying its own minimal validation as "proportionate mitigation for this app having no auth anywhere." That premise is stale: real session-based auth shipped in PR #12, and the entire 36-task audit-fixes plan's Part A was specifically about retrofitting ownership/login checks onto every other mutating route. These 7 handlers are the gap that sweep missed.

## Scope decision: login-only, not ownership, not admin-only

Every other ownership check added by the audit-fixes plan exists because the mutated resource (a style, asset, job, preset, page) has a `created_by` owner. None of these 7 handlers touch an owned resource — they touch global app state (the git working tree, a local settings value, orphaned files on disk). There is no existing "admin-only, no-owner" gate anywhere in this codebase to extend (checked: every `is_admin` reference in `app/api` is an ownership-bypass, not a standalone gate). Decided: require **any logged-in user** (mirror `app/api/assets/from-job/route.ts`'s existing pattern exactly — `getCurrentUser(req)`, 401 with `{ success: false, error: 'Not logged in' }` if null), not admin-only. Cost if wrong: low and reversible — tightening this later from "any user" to "admin only" is a one-line change to one condition per file, not a re-architecture.

## Global Constraints

- No new npm dependencies.
- Mirror `app/api/assets/from-job/route.ts:12-17` exactly: `import { getCurrentUser } from '@/lib/utils/session';`, then as the first statement inside the handler's `try` block (or first statement if there is no `try`):
  ```typescript
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }
  ```
- Every handler touched needs a `req: NextRequest` parameter — 4 of the 7 files currently declare their handler with no parameters at all (`GET()`, `POST()`) since they never read the request; add the parameter.
- `NextRequest` import: add `import { NextRequest, NextResponse } from 'next/server';` where only `NextResponse` is currently imported.
- Existing tests for the 2 files that already have tests must be updated to seed a session (`test/helpers/testSession.ts`'s `seedSession()`) and pass its `cookieHeader` on every request that expects to reach past the new guard — otherwise every existing test starts failing at the new 401, not because the route broke but because the test stopped authenticating.
- New test files needed for the 5 files with zero existing route-level tests (`storage/cleanup`, and all 4 `git/*` routes) — at minimum one "401s when not logged in" case and one "passes through to existing behavior when logged in" case per route.
- `User.is_admin` is irrelevant here — this plan doesn't use it.

## Task 1: Add a login guard to all 7 unauthenticated route files (batched — same one-line fix, repeated)

**Files:**
- Modify: `app/api/assets/[id]/edit/route.ts`
- Modify: `app/api/settings/aseprite-path/route.ts` (both `GET` and `PUT`)
- Modify: `app/api/storage/cleanup/route.ts`
- Modify: `app/api/git/pull/route.ts`
- Modify: `app/api/git/push/route.ts`
- Modify: `app/api/git/abort/route.ts`
- Modify: `app/api/git/resolve/route.ts`
- Modify: `test/assetEdit.test.ts` (seed a session, pass `cookieHeader`, add one 401 case)
- Modify: `test/asepritePathSettings.test.ts` (seed a session, pass `cookieHeader`, add one 401 case for each of GET/PUT)
- Test (new): `test/storageCleanupRoute.test.ts` — 401 when logged out, success (200, calls both `assetService.cleanupOrphanedImages()`/`cleanupOrphanedThemes()`) when logged in
- Test (new): `test/gitRoutesAuth.test.ts` — covers all 4 git routes in one file (same shape). This codebase's existing `GitService` tests (`test/gitServicePages.test.ts` etc.) all use a real temp-git-repo fixture, never a mock — but that convention exists to test `GitService`'s actual git logic, which these 4 routes don't add or change. This plan is testing the routes' new auth layer only, so: `vi.mock('@/lib/services/GitService', () => ({ gitService: { pull: vi.fn(), push: vi.fn(), abortMerge: vi.fn(), resolveConflicts: vi.fn() } }))` at the top of this file, each mock resolving a success shape matching its real method's return type. Two cases per route: (1) no cookie → `401`, mock not called; (2) seeded session cookie → falls through to the mock (asserts it was called once), response matches what the route already does with a successful `gitService` result.

**Interfaces:**
- Consumes: `getCurrentUser(req: NextRequest): Promise<User | null>` (existing, `lib/utils/session.ts`) — same function every other authenticated route in this codebase already uses.
- No new interfaces produced. No signature changes to any service — only the route handlers gain the guard.

**Per-file specifics:**

1. **`app/api/assets/[id]/edit/route.ts`** — handler already takes `(_req: NextRequest, ...)` (currently unused, prefixed `_`); rename to `req` and add the guard as the first line inside the existing `try` block, before `const { id } = await params;`.
2. **`app/api/settings/aseprite-path/route.ts`** — `GET()` becomes `GET(req: NextRequest)`; `PUT(req: NextRequest)` already has the parameter. Add the guard as the first line inside each handler's `try` block.
3. **`app/api/storage/cleanup/route.ts`** — `POST()` becomes `POST(req: NextRequest)`. Add the guard as the first line inside the existing `try` block.
4. **`app/api/git/pull/route.ts`** and **`app/api/git/resolve/route.ts`** — `POST()` becomes `POST(req: NextRequest)`. Both already have a `try` block; add the guard as its first line.
5. **`app/api/git/push/route.ts`** and **`app/api/git/abort/route.ts`** — these two have **no `try/catch` at all** today (pre-existing gap, out of scope to fix here — note it in the report but do not add error handling beyond what's needed to compile; the guard itself needs no `try`). `POST()` becomes `POST(req: NextRequest)`; add the guard as the first line of the function body, before the existing `const result = await gitService...()` call.

**Existing-test fixups (both files already seed a full temp-DB fixture in `beforeEach` — only the request construction changes):**

- `test/assetEdit.test.ts`: add `import { seedSession } from '@/test/helpers/testSession';`, seed a session in `beforeEach` (after the existing DB setup), and change `editRequest()` to accept and send the `cookieHeader` (`headers: { cookie: cookieHeader }`). Add one new test: `it('401s when not logged in', ...)` asserting a request with no cookie header gets `401` and `spawnMock` is never called.
- `test/asepritePathSettings.test.ts`: same pattern — seed a session, thread `cookieHeader` through `putRequest()` and any direct `GET` call, add a 401 case for both `GET` and `PUT` when logged out.

- [ ] **Step 1: Add the guard to all 7 files per the per-file specifics above**
- [ ] **Step 2: Update `test/assetEdit.test.ts` and `test/asepritePathSettings.test.ts`** to seed a session and thread the cookie through every request that expects to reach past the new guard; add the 401 cases
- [ ] **Step 3: Write `test/storageCleanupRoute.test.ts` and `test/gitRoutesAuth.test.ts`** per the File list above
- [ ] **Step 4: Run the full suite and `tsc --noEmit`** — every pre-existing test in the 2 modified files must still pass (now via a seeded session), the new tests must pass, and no other test anywhere in the suite may reference these 7 routes without a session (grep for `/api/assets/.*edit`, `/api/settings/aseprite-path`, `/api/storage/cleanup`, `/api/git/` across `test/` before finishing, to catch any other caller this brief's review missed)

## Out of scope (adjacent, pre-existing, not this plan's job)

- `app/api/git/push/route.ts` and `app/api/git/abort/route.ts` having no `try/catch` at all — real, matches the pattern Task 8 of the audit-fixes plan fixed elsewhere, but a different kind of fix than "add a login check." Leave a note in the task report; do not fix silently inside this plan.
- Whether these 7 actions should eventually be admin-only rather than any-logged-in-user — explicitly decided above as login-only for this plan; revisit only if the user asks.
- Any client-side (`fetch(...)`) changes — none needed. All 3 call sites live under `/dashboard`, already same-origin, and browsers attach cookies to same-origin `fetch` calls by default.
