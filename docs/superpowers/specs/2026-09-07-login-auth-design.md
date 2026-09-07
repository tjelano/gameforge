# Login / Auth — Design Spec

## Goal

GameForge has no real identity system today: `created_by` is a random UUID a
browser generates once and stores in `localStorage`
(`lib/utils/clientId.ts`), sent by the client in every request body. This
lets the user (the admin) tell people apart by name instead of a raw UUID,
and gives GameForge one real, server-enforced rule: **only the creator of a
Style Bible (or the admin) can edit or delete it.** Everyone else must Fork.

This is local-first software — 2-3 people, each running their own instance
on their own machine, syncing data via git (`GitService`). There is no
network attacker model to defend against; the goal is a real, non-spoofable
identity for attribution and ownership, not a production-grade auth system.

## Non-goals (explicitly out of scope, confirmed with the user)

- **No passwords.** Logging in is picking your name from a list. Anyone with
  local access to a machine already has full access to that machine's data;
  a password doesn't change that threat model for this app.
- **No new restriction on jobs or assets.** Generating against ANY Style
  Bible (owned by you or not) stays exactly as open as it is today. Only the
  Style Bible record itself (name + design tokens) gets an ownership check.
- **No promote/demote admin UI.** The first user ever created (globally,
  across the synced `users` table — see Login flow below) is the sole admin.
  Adding more admins later is a small follow-up, not part of this spec.
- **No migration/reassignment of existing anonymous data.** Styles/assets
  created before this ships keep whatever random UUID they already have in
  `created_by`. The admin can still edit/delete all of them (admin bypasses
  the ownership check entirely), so this is a non-issue in practice given
  there's only ever been one real user of the app so far. Not worth building
  a "claim your old data" flow for.

## Data model

Two new tables, migration `011_add_users_and_sessions.sql`:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

`lib/database/schema.ts` gets matching Zod schemas: `UserSchema` (`id`,
`name`, `is_admin: z.union([z.literal(0), z.literal(1)])`, `created_at`) and
`SessionSchema` (not git-synced, so no Zod export needed for import/export —
see below).

`lib/services/UserService.ts` (new, mirrors `StyleService.ts`'s shape):
`getAll()`, `getActiveUsers()` (all users, for the login picker — no
soft-delete concept needed here, YAGNI), `getById(id)`, `getByName(name)`,
`create({ name }): Promise<User>` (id via `crypto.randomUUID()`, `is_admin`
= 1 if `getAll()` is currently empty, else 0 — see "First-run and the
git-sync race" below for why this can't just be "first row in this local
DB").

`lib/services/SessionService.ts` (new): `create(userId): Promise<{ token,
expiresAt }>` (`crypto.randomBytes(32).toString('hex')` as the token, 90-day
expiry — long-lived by design, this is a low-friction local tool, not
something that should force a re-login every few days), `getUserByToken(
token): Promise<User | null>` (joins `sessions` → `users`, returns `null` if
missing or `expires_at` has passed), `destroy(token): Promise<void>`
(logout).

## Git sync: `users` must sync, `sessions` must not

`GitService.ts`'s `DATA_DIRS = ['data/styles', 'data/assets']` is the
existing sync mechanism: every style/asset round-trips through
`exportToJson()`/`importFromJson()` as one JSON file per row, `git add`ed,
committed, pushed/pulled, then re-imported via `INSERT ... ON CONFLICT DO
UPDATE` (last-write-wins, same as every other synced table in this app).

**`users` needs the exact same treatment**, or this feature doesn't actually
work across machines: if Alice creates styles on her machine and pushes,
when Bob pulls, his local `users` table has no row for Alice's user id
unless `users` synced too — every style/asset Alice created would still
show as a raw UUID on Bob's screen, which defeats the entire point ("help
people see who is who"). Concretely:

- `DATA_DIRS` becomes `['data/styles', 'data/assets', 'data/users']`.
- `exportToJson()` gains a loop over `userService.getAll()`, one file per
  row at `data/users/user-<id>.json`, same shape as the styles/assets loops.
- `importFromJson()` gains a matching `INSERT INTO users (...) VALUES (...)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_admin =
  excluded.is_admin, created_at = excluded.created_at` loop, same
  conflict-marker check as the other two loops.
- `stageFilesForCommit()`'s `git.add('data/')` already covers `data/users/`
  since it adds the whole `data/` directory — no change needed there.

**`sessions` must NOT sync.** It's pure local-machine login state — Alice's
session token has no meaning on Bob's machine, and committing live session
tokens into git history would be a real (if minor, given the trust model)
credential leak for no benefit. `sessions` stays a plain local table, never
touched by `exportToJson`/`importFromJson`.

## First-run and the git-sync race

`gitService.pull()`/`push()` are **not automatic** — they only run when a
user explicitly triggers them (`app/api/git/pull`, `app/api/git/push`, both
manually invoked from a settings page). This creates a real correctness
problem for "first user created = admin": if Bob clones the repo fresh and
opens the app before ever clicking "Pull," his local `users` table is
genuinely empty — not because no admin exists anywhere, but because his
machine hasn't synced yet. If the login page treated "local `users` table is
empty" as "no admin exists, so make me one," Bob would incorrectly become a
second admin.

Fix: the login page's empty-`users` state offers **"Pull from git first"**
(calls the existing `POST /api/git/pull`) as the primary action, with
**"This is a brand new project — create the first account"** as a secondary
action, clearly labeled as making you the admin. If Pull succeeds and finds
existing users, the page re-renders with the real login list. If Pull fails
(no remote configured yet — a real, common case for someone's very first
`git init`) or the user explicitly chooses the second option, the "create
the first account" flow proceeds and that new user's `is_admin` is set from
`userService.getAll()` being empty at that moment.

## Session mechanism

Plain random bearer token (`crypto.randomBytes(32).toString('hex')`,
128 bits of entropy), stored server-side in `sessions.token`, sent to the
browser as an HttpOnly cookie. No JWT, no signing library (`jose` or
similar) — the token itself is unguessable and the server is the sole
source of truth for what it maps to, so there's nothing a signature would
protect against here that a bare random token doesn't already. Matches
AGENTS.md's "no utility libraries, simplest thing that works."

Cookie options, set via `NextResponse.cookies.set(...)` (not `next/headers`'s
`cookies()` — see "Route Handlers and testability" below):

```ts
response.cookies.set('session', token, {
  httpOnly: true,
  secure: false, // this app is never served over HTTPS — see below
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 90, // 90 days
  path: '/',
});
```

**`secure: false` is deliberate, not an oversight.** Next.js's own docs
default this to `true`, which is correct for a real deployed app but would
silently break login here: this app is `next dev`/`next start` on
`localhost` (or a bare LAN IP if someone opens it from another device on
their network), never behind HTTPS. A `secure` cookie is never sent back to
the server over plain HTTP, so `secure: true` would look like login "works"
(the `Set-Cookie` header goes out) while every subsequent request silently
arrives with no cookie at all.

## Route Handlers and testability

This codebase's existing route tests (14 files, e.g. `test/fromCrop.test.ts`)
construct a raw `NextRequest` directly and call the exported route function,
without going through Next.js's real server dispatch. `next/headers`'s
`cookies()` relies on request-scoped context that real dispatch sets up —
calling it from a route invoked this way in a unit test is unreliable.
`NextRequest` and `NextResponse` both have a built-in `.cookies` accessor
that works directly off the `Cookie`/`Set-Cookie` headers with no such
dependency. So: every Route Handler in this feature reads the session via
`request.cookies.get('session')?.value`, and every Route Handler that sets
one builds a `NextResponse` and calls `.cookies.set(...)` on it directly —
never `next/headers`'s `cookies()`. This keeps every new/changed route
testable with the exact same `new NextRequest(url, { headers: { Cookie:
'session=...' } })` pattern already used everywhere else in this codebase.

`lib/utils/session.ts` (new, the one shared helper — this is exactly the
"safety-critical logic" AGENTS.md's REQUIRED list says to extract on sight,
not a forbidden wrapper):

```ts
export async function getCurrentUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get('session')?.value;
  if (!token) return null;
  return sessionService.getUserByToken(token);
}
```

## Login / logout flow

- `GET /login` (new page, `app/login/page.tsx`): server component. Fetches
  `userService.getActiveUsers()` directly (no API round-trip needed — this
  is a Server Component, matches how other pages already read services
  directly server-side where they can). Empty list → the Pull-first flow
  above. Non-empty list → buttons, one per user, each posting to
  `POST /api/auth/login`.
- `POST /api/auth/login` (new route): body `{ userId }` OR `{ name }` for
  the create-first-account path — `{ userId }` looks up an existing user;
  `{ name }` creates one (only meaningful/reachable when `getAll()` is
  empty, enforced server-side too, not just hidden client-side, so this
  can't be used to self-appoint admin later). Creates a session, sets the
  cookie, returns `{ success: true, data: { id, name, isAdmin } }`.
- `POST /api/auth/logout` (new route): reads the cookie, calls
  `sessionService.destroy(token)`, clears the cookie (`maxAge: 0`).
- A small client component in the dashboard layout shows "Logged in as
  {name}" + a Logout button, fetching `GET /api/auth/me` (new, thin route
  wrapping `getCurrentUser`) once on mount.

## Proxy-level redirect (optimistic check only)

`proxy.ts` at the project root (Next.js 16 renamed `middleware.ts` →
`proxy.ts` — confirmed against `node_modules/next/dist/docs`, this is
exactly the kind of breaking-change-vs-training-data AGENTS.md warns about).
Per Next's own guidance, Proxy should do an **optimistic, cookie-presence-
only** check — no DB hit — and leave the real, secure check to the route/DAL
layer (`getCurrentUser`), since Proxy runs on every request including
prefetches.

```ts
// proxy.ts
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has('session');
  if (!hasSession) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = {
  matcher: ['/((?!login|api|_next/static|_next/image|favicon.ico).*)'],
};
```

This only gates **pages** (API routes are excluded from the matcher and
each does its own `getCurrentUser` check where it matters). A cookie that's
present but expired/invalid still gets past Proxy and lands on a real page;
that page's own data-fetching will find no valid session server-side and
can redirect from there if needed — acceptable for this app's low stakes,
and consistent with "optimistic checks only" being Proxy's actual job.

## Where `getCurrentUser` replaces client-submitted identity

Complete inventory (grepped directly, not estimated) of every place that
currently trusts a client-submitted identity:

**Client pages** (remove `getClientId()` import and the field from the
request body — the server derives identity from the session cookie
automatically, no body field needed):
- `app/dashboard/ui-sheets/page.tsx:59`
- `app/dashboard/themes/page.tsx:37`
- `app/dashboard/components/page.tsx:39`
- `app/dashboard/styles/page.tsx:21` (create) and `:36` (fork)
- `app/dashboard/generate/page.tsx:37`
- `app/dashboard/jobs/[id]/split/page.tsx:131`

`lib/utils/clientId.ts` is deleted entirely once nothing imports it.

**API routes** (remove `createdBy`/`requestingUserId`/`newOwnerId` from
each Zod body schema; call `getCurrentUser(req)` instead, 401 if `null`):
- `app/api/assets/route.ts:35,48`
- `app/api/assets/from-crop/route.ts:13,43`
- `app/api/styles/route.ts:18`
- `app/api/styles/[id]/route.ts:20,28,29,53,58,62` — this is also where the
  ownership check itself changes, from `existing.created_by !==
  requestingUserId` to `existing.created_by !== user.id && !user.isAdmin`
- `app/api/styles/[id]/fork/route.ts:7,12,14`
- `app/api/generate/route.ts:11`

**Service layer is unchanged.** `StyleService.create/update/fork`,
`AssetService.create`, `JobService.create` all keep their existing
`createdBy`/`requestingUserId` parameter signatures — only where the ROUTE
sources that value from changes (request body → `getCurrentUser(req).id`).
This keeps the change mechanical and scoped to the trust boundary, not a
deeper refactor.

## Test impact

14 existing test files construct a route request with a `createdBy`/
`requestingUserId`/`newOwnerId` JSON body field (e.g.
`test/fromCrop.test.ts:59`). Each needs its request construction updated to
set a `Cookie: session=<token>` header instead, backed by a real seeded
`users`/`sessions` row (matching this codebase's established pattern of
testing against a real temporary SQLite DB, not mocks — see
`test/dedupQueries.test.ts` for the exact `setProjectRootForTests` +
migrations-copy + `DatabaseConnection.resetForTests()` pattern to reuse). A
small test helper, `test/helpers/testSession.ts`, seeding one user + one
session and returning `{ userId, cookieHeader }`, avoids repeating that
boilerplate across all 14 files.

New tests needed: `UserService`/`SessionService` unit tests; the
Pull-before-first-account race (empty local `users`, but `importFromJson`
brings in an existing admin — the second "create first account" path must
no longer be offered); `getCurrentUser` returning `null` for a missing,
unknown, or expired token; the style ownership check's admin-bypass path;
`proxy.ts`'s redirect behavior (via `unstable_doesProxyMatch` /
direct invocation, per the Next.js docs' testing utilities).

## Security note (scope, not oversight)

This is real attribution and real ownership enforcement (closing today's
"send any `requestingUserId` you like" spoofing gap), but it is **not**
production-grade auth: no password, no rate-limiting, no CSRF token beyond
`sameSite: 'lax'`, no protection against someone with physical/local access
to a shared machine picking a different name off the login list. That
matches the explicit, deliberate scope the user chose (Option A: named
identity, no credentials, 2-3 trusted people, one person per machine) — not
a gap to close later, a boundary already agreed on.
