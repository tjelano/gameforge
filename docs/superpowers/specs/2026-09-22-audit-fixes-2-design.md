# Audit Fixes Round 2 — Design

**Origin:** a manual + automated UX/code audit of the running app (2026-09-22), covering auth flow,
error handling, empty/loading states, and accessibility. 13 confirmed findings, all verified against
the actual running app and/or code before being included here (one automated-scan finding — "no
server-side auth gate exists" — was checked and found **false**; `proxy.ts`, Next 16's renamed
`middleware.ts`, does gate every route except `/login`/`/api`/Next internals, and was dropped from
scope).

## Global Constraints

- Follow `AGENTS.md`'s forbidden/required lists (no DTOs, no wrapper classes, direct Zod, flat
  procedural logic, `try/catch` on all file-system ops, disable-on-submit for all forms).
- `proxy.ts` stays exactly as-is — its own header comment documents it as a deliberate, DB-free
  optimistic check; the fixes below work with that boundary, not around it.
- No new dependencies. No new abstractions for a single call site.
- Every task must pass `npx tsc --noEmit`, `npx eslint app lib worker.ts`, and `npx vitest run`
  before being considered done, plus a DeepSeek Mode 2 diff review per this project's standing
  practice.

---

## Cluster A — Stale-session UX (findings #1, #2, #3, #4)

### Problem
A `session` cookie that no longer resolves to a real user (expired, or the user was deleted) passes
`proxy.ts`'s presence-only check but fails `getCurrentUser()` everywhere downstream. Two independent
consumers of `useCurrentUser()` (`NavRail`, `CopilotPanel`) each just quietly render less — no shared
handling, no signal to the user that anything's wrong. Separately, the login page renders the full
dashboard nav (since `NavRail`/`CopilotPanel` are mounted globally in the root layout), and once one
account exists there's no way to create a second.

### Fix A1 — Centralize the stale-session redirect in `useCurrentUser`
`lib/hooks/useCurrentUser.ts`: after the `/api/auth/me` fetch resolves with `loading: false` and
`user: null`, if `pathname` starts with `/dashboard`, call `router.push('/login?reason=expired')`.
This is the one place every dashboard page's identity check already flows through, so no other file
needs its own stale-session detection. `/login` itself must never trigger this (a null user there is
completely normal, not an error) — the `pathname.startsWith('/dashboard')` guard handles that.

`app/login/LoginForm.tsx`: read `reason` from `useSearchParams()`; when it's `'expired'`, render a
one-line banner above the account list: "Your session expired — pick your name again."

### Fix A2 — Defense-in-depth for the in-flight-submission race
A user can still have a dashboard page open at the exact moment their session lapses and submit a
form before A1's redirect fires (a narrow race, not the common case). Wherever a mutation's error
state already surfaces a raw `"Not logged in"`-shaped message from the backend (confirmed instance:
`app/dashboard/styles/page.tsx:414`'s `createError`), append a `<Link href="/login">Log in again</Link>`
next to it. Scope this to the one confirmed instance — don't speculatively touch every error-rendering
call site in the app; if the pattern recurs elsewhere it can be handled next round.

Also fix `app/api/drive/connect/route.ts:9-12`: change the raw
`NextResponse.json({success:false,...}, {status:401})` for the logged-out case to
`NextResponse.redirect(new URL('/login?reason=expired', req.url))`, matching how the two `catch`
branches immediately below it already redirect rather than return raw JSON. This route is only ever
reached via a full-page `<a href>` navigation (Settings → Google Drive → Connect), so a JSON body
renders as literal on-screen text today — a redirect is strictly better here, not just consistent.

### Fix A3 — Add-another-account path
`app/login/LoginForm.tsx`: in the `users.length > 0` branch, add a small "+ Add another account"
toggle button below the existing-account list that switches to rendering the same create-account form
already used in the `users.length === 0` branch (extract that form's JSX into a local helper so it
isn't duplicated). Submitting it calls the same `handleCreateFirst`-shaped logic (rename to
`handleCreateAccount` since it's no longer only for the first account) — `POST /api/auth/login` with
`{name}` already supports creating a new user at any time; nothing server-side needs to change ( verify
this against `app/api/auth/login/route.ts` during implementation — if it turns out to reject a `name`
POST once `users.length > 0`, that's a signal the server route needs the equivalent one-line relaxation,
not a reason to abandon the feature).

### Fix A4 — Scope `NavRail`/`CopilotPanel` off the login page
Both already self-gate on `!user` (`CopilotPanel.tsx:46`) or conditionally render a sub-block on `me`
(`NavRail.tsx`). Add one more early check to each, matching that existing pattern: `usePathname() ===
'/login'` → `return null` (for `CopilotPanel`) / skip rendering the nav links entirely, keeping just the
brand mark (for `NavRail`, so the page doesn't look totally bare — match `LoginForm`'s existing visual
weight). This is a two-line change per component, not a route-group restructure — consistent with how
both components already self-gate on `user`.

---

## Cluster B — Missing error handling (findings #5, #6, #7)

### Fix B1 — Guard the two unguarded initial fetches
`app/dashboard/jobs/[id]/edit/page.tsx:40-48` and `app/dashboard/jobs/[id]/edit-component/page.tsx:27-35`
each have a bare `const res = await fetch(...)` inside the mount effect with no try/catch, unlike the
three sibling detail pages. Wrap each in the exact same shape the siblings already use (see
`app/dashboard/assets/[id]/page.tsx:51-68`'s pattern): `try { ...; } catch { if (!ignore)
setError('Could not reach the server.'); }`.

### Fix B2 — `/api/drive/connect` redirect
Covered under A2 above (same file, adjacent fix).

### Fix B3 — Worker-health signal
Add a lightweight worker heartbeat: `worker.ts` already runs a polling loop; have it write its own
`last_seen` timestamp into the existing `settings` table (Zod-validated key/value store, per
`AGENTS.md`'s schema notes — no new table) on every poll tick. Add `GET /api/dashboard/worker-status`
returning `{ alive: boolean }` (alive = last_seen within, say, 15s — 3x a typical poll interval; confirm
the worker's actual poll interval in `worker.ts` during implementation and size the threshold off that,
don't guess a number now). Surface it as a small dot + label ("Worker: ● running" / "○ not detected")
in `app/dashboard/page.tsx`'s Overview stat-cards row — the page users land on first, and where the
existing "Jobs in flight" stat already lives, so a stalled queue and a dead worker read together.

---

## Cluster C — Missing empty/loading states (findings #8, #9)

### Fix C1 — Export page empty state
`app/dashboard/export/page.tsx` already destructures `stylesLoading` from `useStyles()` but never
checks it for an empty-state branch. Add the exact block `generate/page.tsx:108-112` already uses
(`{!stylesLoading && !stylesError && styles.length === 0 ? <empty-state> : <form>...}`), adapted to
Export's copy ("No Style Bibles yet — create one on the Style Bibles page before exporting.").

### Fix C2 — Loading spinners for Assets grid and Overview activity
`app/dashboard/assets/page.tsx:68-85`: the current condition only branches on
`!loading && !error && assets.length === 0`; everything else (including the loading state) falls into
the grid-render branch, showing a blank grid. Add a third branch: `loading ? <loading indicator> :
(existing empty/grid logic)`. Reuse whatever loading-indicator convention already exists elsewhere in
this codebase (check `DriveBrowser.tsx:352`'s `<p className="page-subtitle">Loading…</p>` for the
established pattern rather than inventing a new one).

`app/dashboard/page.tsx:63-75` (Overview's Recent Activity): same shape — the `!loading &&
activity.length === 0` empty-state check means `loading === true` falls into the `<div>{activity.map(...)}
</div>` branch, rendering blank. Add the same `loading ? <indicator> : (existing logic)` branch.

---

## Cluster D — Consistency / accessibility (findings #10, #11, #12, #13)

### Fix D1 — Real labels on placeholder-only inputs
Four confirmed instances, all get a real `<label htmlFor>` matching the visually-hidden pattern already
established in `DriveBrowser.tsx:251,264` (`position: absolute; width: 1px; height: 1px; overflow:
hidden; clip: rect(0,0,0,0); white-space: nowrap`) or a plain visible `<label>` where the surrounding
layout already has room (match whichever convention the immediate sibling inputs on that same page use
— `styles/page.tsx`'s `importName`/`importFile` inputs already use plain visible labels, so match that
there rather than introducing the visually-hidden variant into a file that doesn't use it yet):
1. `app/dashboard/styles/page.tsx:404` — "New Style Bible name" input.
2. `app/dashboard/styles/page.tsx:481` — Inspo search input.
3. `app/login/LoginForm.tsx:107` — "Your name" input (the very first form field a new user ever fills
   in).
4. `app/dashboard/assets/[id]/page.tsx:574` — new pseudo-state name input.

### Fix D2 — Dialog semantics on the two custom modals
`app/dashboard/presets/page.tsx:235-273` (apply-preset overlay) and
`app/dashboard/drive/DriveBrowser.tsx:333-343` (move-file overlay): add `role="dialog"`
`aria-modal="true"` to the outer fixed-position wrapper, an `onKeyDown` handler on that wrapper closing
on `Escape` (calling the same setter the existing Cancel button already calls —
`setApplyingId(null)`/`setMovingItem(null)`), and a `useEffect` that moves focus into the dialog's first
interactive element when it mounts and returns focus to the trigger element on unmount. Keep this
self-contained per modal (two small, near-identical blocks) rather than extracting a shared `<Modal>`
component — two call sites doesn't clear this codebase's bar for a new abstraction (`AGENTS.md`:
"Extract shared helpers... not once it's been copy-pasted a certain number of times" — two is not
"a certain number of times" for a component this small; revisit if a third modal appears).

### Fix D3 — Keyboard support for the sprite-sheet crop-box editor
`lib/hooks/useDraggableBoxes.ts` itself needs no change — `updateBox(id, patch)` is already the right
primitive. The fix goes in both consumers' box-rendering JSX
(`app/dashboard/jobs/[id]/split/page.tsx:175-204` and `app/dashboard/ui-sheets/page.tsx:164-189`):
add `tabIndex={0}`, `role="group"`, an `aria-label` describing the piece (its current label/kind), and
an `onKeyDown` that calls `updateBox` directly (not `startDrag`, which is pointer-drag-tracking
machinery the keyboard path doesn't need):
- Arrow keys alone: move by 4px in the pressed direction.
- Shift+Arrow: resize — Right/Down grow `w`/`h` by 4px (floored at `MIN_SIZE` from the hook), Left/Up
  shrink by 4px.
- Add a visible `:focus` outline via each box's existing inline `style` object (a 2px outline in the
  accent color when focused) — right now the box has no focus-visible treatment at all.

### Fix D4 — Small polish items
1. **Favicon**: add `app/icon.png` (Next.js App Router's file-based favicon convention — confirm
   during implementation whether `app/favicon.ico` or `app/icon.png`/`.svg` is preferred for this
   Next.js version per `node_modules/next/dist/docs/`, per this repo's own `AGENTS.md` instruction to
   check the docs before assuming). Reuse an existing GameForge mark asset if one exists under
   `public/`; if not, a simple text-based generated icon (the "GF" wordmark, matching the existing
   orange/black palette) is enough — this is a 404-silencing fix, not a design task.
2. **Clickable activity rows**: `app/dashboard/page.tsx:68-73` — wrap each `activity-row` in a `Link`.
   `ActivityItem.kind === 'job'` → `/dashboard/jobs` (the Jobs review page; there's no per-job detail
   route generic enough to deep-link to across all job types, so link to the list rather than
   inventing one). `kind === 'style'` → `/dashboard/styles/${item.id}`.
3. **Asset-type dropdown**: `app/dashboard/generate/page.tsx`'s free-text "Asset type" field — confirm
   the actual accepted value(s) against the job-creation Zod schema during implementation (it may
   genuinely only ever be `"sprite"` today, in which case the right fix is a disabled/fixed
   single-option `<select>` matching the Style Bible/Size dropdowns' pattern, not a fabricated list of
   options that don't exist server-side yet).

---

## Testing approach

- Cluster A: a Vitest test against `useCurrentUser`'s redirect behavior needs a mocked
  `next/navigation` router + pathname (check `test/` for an existing mocking pattern before inventing
  one — several hook tests likely already exist). `LoginForm`'s add-account toggle and the
  `reason=expired` banner get component tests via the existing Testing Library setup (see
  `test/elementPatchPanel.test.tsx` / `test/previewFrame.test.tsx` for this repo's established
  component-test shape).
- Cluster B: `worker-status` route gets a route test with a mocked `settings` table row (fresh
  `last_seen` → alive; stale/missing → not alive). The two guarded-fetch fixes get a test asserting the
  page renders an error state instead of hanging when the fetch rejects.
- Cluster C: component tests asserting a loading indicator renders when `loading` is true and neither
  the empty-state nor the grid renders in that state.
- Cluster D: D1/D2 get accessibility-shaped assertions (label present, `role="dialog"`/`aria-modal`
  present, Escape closes). D3 gets a test driving `onKeyDown` and asserting `updateBox` was called with
  the expected delta. D4 items are small enough that a manual browser check covers them adequately
  (per this project's established pattern of pairing automated tests with real-browser verification for
  UI work) — favicon renders with no 404, activity rows navigate, asset-type field behaves per whatever
  the schema investigation finds.
