# Audit Fixes Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 13 findings from the 2026-09-22 GameForge UX/code audit — stale-session UX, missing
error handling, missing empty/loading states, and accessibility gaps.

**Architecture:** Four independent clusters (A: auth-session UX, B: error handling, C: empty/loading
states, D: consistency/accessibility). Tasks within and across clusters are meant to run strictly
sequentially, one subagent at a time (`subagent-driven-development`'s own rule — never dispatch
implementers in parallel), NOT as independently-parallelizable units. Three files are each touched by
more than one task, and correctness depends on that sequential order: `app/login/LoginForm.tsx`
(Tasks 1, 3, 9 — in that order), `app/dashboard/styles/page.tsx` (Tasks 2, 9 — in that order), and
`app/dashboard/page.tsx` (Tasks 6, 8, 12 — in that order, each scoped to a disjoint part of the file so
their diffs stay individually reviewable). Every other file is touched by exactly one task.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Zod, better-sqlite3, Vitest +
@testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-22-audit-fixes-2-design.md`

## Global Constraints

- No new dependencies. No new abstractions for a single/two call sites (`AGENTS.md`: extract shared
  helpers on sight only for safety-critical logic, not for two near-identical UI blocks).
- `proxy.ts` is NOT touched by this plan — it stays exactly as-is.
- Every task: `npx tsc --noEmit`, `npx eslint app lib worker.ts`, `npx vitest run` must all pass, plus
  a DeepSeek Mode 2 diff review, before being marked done.
- Disable-on-submit for every new/modified form control, per `AGENTS.md`.
- `try/catch` on every new file-system/DB/network operation, per `AGENTS.md`.
- The worker's real poll interval is **2000ms** (`worker.ts:19`, `POLL_INTERVAL_MS`) — any
  heartbeat-freshness threshold in this plan is sized off that real value, not a guess.
- The `settings` table (`lib/database/migrations/007_add_settings_table.sql`) has exactly two columns:
  `key TEXT PRIMARY KEY`, `value TEXT NOT NULL` — no timestamp column. All settings-table keys are
  declared as `*_SETTING_KEY` string constants in `lib/config.ts`, read/written only via
  `lib/services/SettingsService.ts`'s `settingsService.get(key)`/`.set(key, value)` — never raw SQL
  against that table from application code.
- No existing test mocks `next/navigation` — Task 1 establishes this repo's first such mock, following
  the one consistent `vi.mock('<module>', () => ({ ...vi.fn() exports }))` factory idiom already used
  throughout `test/` (e.g. `test/driveFilesListRoute.test.ts`).
- `.tsx` component tests require the literal first line `// @vitest-environment jsdom` (this repo's
  Vitest config defaults to `environment: 'node'`), explicit `describe/it/expect/vi/afterEach` imports
  from `'vitest'` (no globals), and `afterEach(() => { cleanup(); vi.restoreAllMocks(); })` — see
  `test/elementPatchPanel.test.tsx` for the canonical example.
- `fetch` is mocked per-test via `vi.stubGlobal('fetch', fetchMock)`, never a module-level fetch mock.

---

### Task 1: Stale-session redirect + expired-session login banner

**Files:**
- Modify: `lib/hooks/useCurrentUser.ts`
- Modify: `app/login/LoginForm.tsx`
- Test: `test/useCurrentUser.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `useCurrentUser()` still returns `{ user, loading }` (unchanged shape) — later tasks (4)
  rely on this signature being unchanged.

Current `lib/hooks/useCurrentUser.ts` (full file):
```ts
'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

export interface CurrentUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export function useCurrentUser() {
  const pathname = usePathname();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Same ignore-flag shape as useStyles.ts — avoids a StrictMode
    // double-invoke race setting state after unmount.
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        const body = await res.json();
        if (!ignore && body.success) setUser(body.data);
      } catch {
        // Purely informational — a failed fetch just means no identity shows.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [pathname]);

  return { user, loading };
}
```

- [ ] **Step 1: Write the failing test**

Create `test/useCurrentUser.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';

const pushMock = vi.fn();
let currentPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pushMock.mockClear();
});

function Probe() {
  const { user, loading } = useCurrentUser();
  return <div data-testid="probe">{loading ? 'loading' : user ? user.name : 'anon'}</div>;
}

describe('useCurrentUser stale-session redirect', () => {
  it('redirects to /login?reason=expired when unauthenticated on a /dashboard route', async () => {
    currentPathname = '/dashboard/generate';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon'));
    expect(pushMock).toHaveBeenCalledWith('/login?reason=expired');
  });

  it('does not redirect when unauthenticated on /login itself', async () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon'));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not redirect when a real user is returned', async () => {
    currentPathname = '/dashboard';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { id: 'u1', name: 'Alice', isAdmin: false } }),
    }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Alice'));
    expect(pushMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/useCurrentUser.test.tsx`
Expected: FAIL — no redirect happens yet (`pushMock` never called), first test fails on the
`toHaveBeenCalledWith` assertion.

- [ ] **Step 3: Write minimal implementation**

Replace `lib/hooks/useCurrentUser.ts` in full:
```ts
'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

export interface CurrentUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export function useCurrentUser() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Same ignore-flag shape as useStyles.ts — avoids a StrictMode
    // double-invoke race setting state after unmount.
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        const body = await res.json();
        if (ignore) return;
        if (body.success && body.data) {
          setUser(body.data);
        } else if (pathname.startsWith('/dashboard')) {
          // A session cookie can pass proxy.ts's presence-only check but still
          // fail to resolve to a real user (expired, or the user was deleted) —
          // proxy.ts deliberately never validates against the DB (see its own
          // header comment), so this is the one place that gap gets closed.
          // /login itself is excluded: a null user there is the normal,
          // expected state, not a session that went stale.
          router.push('/login?reason=expired');
        }
      } catch {
        // Purely informational — a failed fetch just means no identity shows.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [pathname, router]);

  return { user, loading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/useCurrentUser.test.tsx`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Add the expired-session banner to LoginForm**

Current `app/login/LoginForm.tsx` top imports and `users.length > 0` branch:
```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
```
```tsx
  if (users.length > 0) {
    return (
      <div>
        {users.map(u => (
          <button key={u.id} className="btn" style={{ display: 'block', width: '100%', marginBottom: 8 }} onClick={() => loginAs(u.id)} disabled={submitting}>
            {u.name}
          </button>
        ))}
        {error && <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>}
      </div>
    );
  }
```

Change the import line to:
```tsx
import { useRouter, useSearchParams } from 'next/navigation';
```

Add inside the component, right after `const router = useRouter();`:
```tsx
  const searchParams = useSearchParams();
  const expired = searchParams.get('reason') === 'expired';
```

Add the banner as the first child of the `users.length > 0` branch's returned `<div>`:
```tsx
  if (users.length > 0) {
    return (
      <div>
        {expired && (
          <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
            Your session expired — pick your name again.
          </p>
        )}
        {users.map(u => (
```

- [ ] **Step 6: Wrap LoginForm in a Suspense boundary (required by `useSearchParams`)**

Next.js's App Router requires any client component calling `useSearchParams()` to be wrapped in
`<Suspense>` — without this, `next build` fails with "useSearchParams() should be wrapped in a
suspense boundary at page /login". `app/login/page.tsx` currently renders `<LoginForm>` directly with
no Suspense boundary anywhere in its tree. `tsc`/`eslint`/`vitest` do not catch this (the LoginForm
test mocks `useSearchParams` entirely) — only `next build` does, so this step is required even though
no test will fail without it.

Current `app/login/page.tsx` (full file):
```tsx
import { userService } from '@/lib/services/UserService';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const users = await userService.getAll();
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1 className="page-title">Who are you?</h1>
      <LoginForm users={users.map(u => ({ id: u.id, name: u.name }))} />
    </div>
  );
}
```

Replace with:
```tsx
import { Suspense } from 'react';
import { userService } from '@/lib/services/UserService';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const users = await userService.getAll();
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1 className="page-title">Who are you?</h1>
      <Suspense fallback={null}>
        <LoginForm users={users.map(u => ({ id: u.id, name: u.name }))} />
      </Suspense>
    </div>
  );
}
```
(`fallback={null}` is fine here: `users` is already resolved server-side before `LoginForm` renders at
all, so `useSearchParams()`'s own client-side hydration is the only thing Suspense is guarding — there
is no meaningful loading state to show.)

Run: `npx tsc --noEmit` (confirms the file still typechecks; the actual Suspense-boundary requirement
itself is only enforced by `next build`, which is not part of this plan's per-task gate but is worth
running once manually — `npx next build` — after this step to confirm no build-time error, since a
missing Suspense boundary here would otherwise ship silently past every task's automated checks).

- [ ] **Step 7: Write a component test for the banner**

Create `test/loginForm.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LoginForm } from '@/app/login/LoginForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('reason=expired'),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LoginForm expired-session banner', () => {
  it('shows the expired banner when ?reason=expired is present and accounts exist', () => {
    render(<LoginForm users={[{ id: 'u1', name: 'Alice' }]} />);
    expect(screen.getByText(/your session expired/i)).toBeTruthy();
  });
});
```

- [ ] **Step 8: Run all new tests, then the full suite**

Run: `npx vitest run test/useCurrentUser.test.tsx test/loginForm.test.tsx`
Expected: PASS (4 tests total)
Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean, no regressions.

- [ ] **Step 9: Manual browser verification**

Start `npm run dev` in this worktree (if not already running), delete/expire a session cookie value in
devtools while `/dashboard` is open in another tab, navigate, and confirm the redirect to
`/login?reason=expired` with the banner visible. Also run `npx next build` once to confirm the Suspense
boundary added in Step 6 satisfies the build (this is the only point in the plan that actually exercises
`next build` — worth doing here since Step 6 exists specifically because the per-task automated gate
can't catch a missing Suspense boundary).

- [ ] **Step 10: Commit**

```bash
git add lib/hooks/useCurrentUser.ts app/login/LoginForm.tsx app/login/page.tsx test/useCurrentUser.test.tsx test/loginForm.test.tsx
git commit -m "fix: redirect to /login on a stale session instead of silently degrading"
```

---

### Task 2: Defense-in-depth for in-flight-submission stale-session errors

**Files:**
- Modify: `app/dashboard/styles/page.tsx`
- Modify: `app/api/drive/connect/route.ts`
- Test: `test/driveConnectRoute.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on.

Current `app/api/drive/connect/route.ts` (full file):
```ts
import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    try {
      return NextResponse.redirect(driveService.getAuthUrl());
    } catch (e) {
      console.error('Failed to build Google Drive auth URL:', e);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=not_configured', req.url));
    }
  } catch (e) {
    console.error('Unexpected error in Drive connect route:', e);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=server_error', req.url));
  }
}
```

- [ ] **Step 1: Write the failing test**

Create `test/driveConnectRoute.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: { getAuthUrl: vi.fn() },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('GET /api/drive/connect', () => {
  it('redirects to /login?reason=expired instead of returning raw JSON when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect');
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?reason=expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/driveConnectRoute.test.ts`
Expected: FAIL — current route returns a 401 JSON response, `res.status` is 401 not 307.

- [ ] **Step 3: Write minimal implementation**

In `app/api/drive/connect/route.ts`, replace:
```ts
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
```
with:
```ts
    if (!user) {
      return NextResponse.redirect(new URL('/login?reason=expired', req.url));
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/driveConnectRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Add the "Log in again" link to the Style Bibles create-error message**

Current `app/dashboard/styles/page.tsx` (relevant lines — `Link` is already imported at the top of this
file):
```tsx
import Link from 'next/link';
```
```tsx
      {createError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -16, marginBottom: 16 }}>{createError}</p>}
```

Replace with:
```tsx
      {createError && (
        <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -16, marginBottom: 16 }}>
          {createError} <Link href="/login">Log in again</Link>
        </p>
      )}
```

- [ ] **Step 6: Write a component test for the link**

Create `test/stylesPageCreateError.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import StylesPage from '@/app/dashboard/styles/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/styles',
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Style Bibles create-error link', () => {
  it('shows a Log in again link when creation fails with a Not logged in error', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/styles') {
        return Promise.resolve({ json: () => Promise.resolve({ success: false, error: 'Not logged in' }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StylesPage />);

    const input = await screen.findByPlaceholderText('New Style Bible name');
    fireEvent.change(input, { target: { value: 'My Style' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('Not logged in')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Log in again' })).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run test to verify it passes, then full suite**

Run: `npx vitest run test/stylesPageCreateError.test.tsx test/driveConnectRoute.test.ts`
Expected: PASS
Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add app/dashboard/styles/page.tsx app/api/drive/connect/route.ts test/driveConnectRoute.test.ts test/stylesPageCreateError.test.tsx
git commit -m "fix: surface a login link on stale-session errors instead of a dead end"
```

---

### Task 3: Add-another-account path on the login screen

**Files:**
- Modify: `app/api/auth/login/route.ts`
- Modify: `app/login/LoginForm.tsx`
- Test: `test/authLoginRoute.test.ts` (modify — check if it exists first with Glob; if not, create)
- Test: `test/loginForm.test.tsx` (modify — extend the file from Task 1)

**Interfaces:**
- Consumes: `LoginForm`'s existing `handleCreateFirst` shape from Task 1 (unmodified by that task).
- Produces: `POST /api/auth/login` accepts an optional `force: boolean` field on the `{name}` variant.

**Important — read before writing code:** `app/api/auth/login/route.ts` currently 403s any `{name}`
POST once `userService.getAll()` returns existing users, UNCONDITIONALLY. `test/loginPullRace.test.ts`
asserts this 403 for its own scenario (an unpulled git sync could be hiding a real existing admin — the
403 forces the user to pull first rather than risk creating a conflicting account). That test's
scenario must keep passing unchanged. This task adds a `force` flag that ONLY the new "add another
account" UI path sets — the original bootstrap flow (Task-1-untouched `handleCreateFirst`, used only in
the zero-users branch) never sends it, so `loginPullRace.test.ts`'s exact scenario is unaffected.

Current `app/api/auth/login/route.ts` (full file):
```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { SESSION_COOKIE_OPTIONS } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const LoginSchema = z.union([
  z.object({ userId: z.string().min(1) }),
  z.object({ name: z.string().min(1) }),
]);

export async function POST(req: NextRequest) {
  try {
    const input = LoginSchema.parse(await req.json());

    let user;
    if ('userId' in input) {
      user = await userService.getById(input.userId);
      if (!user) {
        return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
      }
    } else {
      const existing = await userService.getAll();
      if (existing.length > 0) {
        return NextResponse.json({
          success: false,
          error: 'An account already exists — pick your name from the list, or Pull from git first.',
        }, { status: 403 });
      }
      try {
        user = await userService.create({ name: input.name });
      } catch (e: any) {
        return NextResponse.json({ success: false, error: 'That name is already taken.' }, { status: 409 });
      }
    }

    const { token } = await sessionService.create(user.id);
    const res = NextResponse.json({
      success: true,
      data: { id: user.id, name: user.name, isAdmin: !!user.is_admin },
    });
    res.cookies.set('session', token, { ...SESSION_COOKIE_OPTIONS, maxAge: 60 * 60 * 24 * 90 });
    return res;
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 1: Write the failing test**

First check whether `test/authLoginRoute.test.ts` already exists:
```bash
ls test/authLoginRoute.test.ts 2>&1 || echo "does not exist"
```
If it exists, add the two `it` blocks below inside its existing `describe`. If not, create it with this
full content (adjust the mock shape to match `UserService`'s real exports if they differ — check
`lib/services/UserService.ts`'s exports first):
```ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/UserService', () => ({
  userService: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/services/SessionService', () => ({
  sessionService: {
    create: vi.fn().mockResolvedValue({ token: 'tok123' }),
  },
}));

function req(body: unknown) {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/auth/login — force flag', () => {
  it('still 403s a {name} POST with no force flag when users already exist (unpulled-git-sync guard)', async () => {
    const { userService } = await import('@/lib/services/UserService');
    vi.mocked(userService.getAll).mockResolvedValue([{ id: 'u1', name: 'Alice' }] as any);

    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req({ name: 'Bob' }));

    expect(res.status).toBe(403);
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('creates a new account when force:true is sent, even though users already exist', async () => {
    const { userService } = await import('@/lib/services/UserService');
    vi.mocked(userService.getAll).mockResolvedValue([{ id: 'u1', name: 'Alice' }] as any);
    vi.mocked(userService.create).mockResolvedValue({ id: 'u2', name: 'Bob', is_admin: 0 } as any);

    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req({ name: 'Bob', force: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Bob');
    expect(userService.create).toHaveBeenCalledWith({ name: 'Bob' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/authLoginRoute.test.ts`
Expected: FAIL — the second test fails (route currently 403s regardless of a `force` field, which the
schema doesn't even accept yet).

- [ ] **Step 3: Write minimal implementation**

In `app/api/auth/login/route.ts`, change the schema:
```ts
const LoginSchema = z.union([
  z.object({ userId: z.string().min(1) }),
  z.object({ name: z.string().min(1), force: z.boolean().optional() }),
]);
```

And change the `else` branch:
```ts
    } else {
      const existing = await userService.getAll();
      if (existing.length > 0 && !input.force) {
        return NextResponse.json({
          success: false,
          error: 'An account already exists — pick your name from the list, or Pull from git first.',
        }, { status: 403 });
      }
      try {
        user = await userService.create({ name: input.name });
      } catch (e: any) {
        return NextResponse.json({ success: false, error: 'That name is already taken.' }, { status: 409 });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/authLoginRoute.test.ts test/loginPullRace.test.ts`
Expected: PASS on both files — confirms the existing pull-race guard is untouched.

- [ ] **Step 5: Add the "add another account" UI toggle to LoginForm**

Extract the create-account form into a local helper and add a toggle button to the `users.length > 0`
branch. Replace the whole component body of `app/login/LoginForm.tsx` (starting from Task 1's version,
which already added `useSearchParams`/`expired`) with:

```tsx
'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface UserOption {
  id: string;
  name: string;
}

export function LoginForm({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const expired = searchParams.get('reason') === 'expired';
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);

  async function loginAs(userId: string) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not log in.');
        return;
      }
      router.push('/dashboard/generate');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePull() {
    if (pulling) return;
    setPulling(true);
    setPullError(null);
    try {
      const res = await fetch('/api/git/pull', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setPullError(body.error ?? body.message ?? 'Pull failed — no git remote configured yet?');
        return;
      }
      setPulled(true);
      router.refresh();
    } finally {
      setPulling(false);
    }
  }

  async function handleCreateAccount(e: React.FormEvent, force: boolean) {
    e.preventDefault();
    if (!newName.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), force }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not create your account.');
        return;
      }
      router.push('/dashboard/generate');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  function createAccountForm(force: boolean) {
    return (
      <>
        <form onSubmit={e => handleCreateAccount(e, force)} style={{ display: 'flex', gap: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Your name" />
          <button className="btn btn-primary" type="submit" disabled={submitting || !newName.trim()}>
            Create
          </button>
        </form>
        {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{error}</p>}
      </>
    );
  }

  if (users.length > 0) {
    return (
      <div>
        {expired && (
          <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
            Your session expired — pick your name again.
          </p>
        )}
        {users.map(u => (
          <button key={u.id} className="btn" style={{ display: 'block', width: '100%', marginBottom: 8 }} onClick={() => loginAs(u.id)} disabled={submitting}>
            {u.name}
          </button>
        ))}
        {!expired && !addingAccount && (
          <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => setAddingAccount(true)}>
            + Add another account
          </button>
        )}
        {addingAccount && (
          <div style={{ marginTop: 12 }}>
            <p className="page-subtitle">Create a new account on this machine:</p>
            {createAccountForm(true)}
          </div>
        )}
        {!addingAccount && error && <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p className="page-subtitle">No accounts found on this machine yet.</p>
      <button className="btn" onClick={handlePull} disabled={pulling} style={{ marginBottom: 16 }}>
        {pulling ? 'Pulling…' : 'Pull from git first'}
      </button>
      {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{pullError} You can still create the first account below.</p>}
      {pulled && <p style={{ fontSize: 13, marginBottom: 16 }}>Pull finished — refreshing…</p>}

      <p className="page-subtitle">This is a brand new project — create the first account (this makes you the admin):</p>
      {createAccountForm(false)}
    </div>
  );
}
```

(Note: this also folds in Task 1's `expired` banner and `useSearchParams` import, since Task 1 must
land first — if implementing Tasks 1-3 out of order for any reason, merge accordingly. `error` is now
rendered once per branch, inside `createAccountForm` for the empty-state path and separately for the
existing-accounts non-adding path, to avoid a duplicate render when `addingAccount` is true — check
this doesn't produce a lint/type issue with `error` being read but not always displayed.)

- [ ] **Step 6: Extend the LoginForm test with add-account coverage**

Add to `test/loginForm.test.tsx` (from Task 1):
```tsx
  it('reveals an add-account form when "+ Add another account" is clicked, and force:true is sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: { id: 'u2', name: 'Bob', isAdmin: false } }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginForm users={[{ id: 'u1', name: 'Alice' }]} />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add another account' }));
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      body: JSON.stringify({ name: 'Bob', force: true }),
    })));
  });
```
Add `fireEvent, waitFor` to the existing `@testing-library/react` import line in that file if not
already present.

- [ ] **Step 7: Run tests, then full suite**

Run: `npx vitest run test/authLoginRoute.test.ts test/loginPullRace.test.ts test/loginForm.test.tsx`
Expected: PASS
Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 8: Manual browser verification**

With one account already existing, log in, log out, click "+ Add another account" on the login screen,
create a second account, confirm both accounts now appear in the list on next visit to `/login`.

- [ ] **Step 9: Commit**

```bash
git add app/api/auth/login/route.ts app/login/LoginForm.tsx test/authLoginRoute.test.ts test/loginForm.test.tsx
git commit -m "feat: allow adding a second account from the login screen"
```

---

### Task 4: Scope NavRail and CopilotPanel off the login page

**Files:**
- Modify: `app/components/NavRail.tsx`
- Modify: `app/components/CopilotPanel.tsx`
- Test: `test/navRailLoginPage.test.tsx` (create)

**Interfaces:**
- Consumes: `useCurrentUser()` from Task 1 (unchanged signature).
- Produces: nothing later tasks depend on.

Current `app/components/NavRail.tsx` (full file):
```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES, type DashboardRoute } from '@/lib/dashboardRoutes';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';

export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { user: me } = useCurrentUser();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  function isActive(href: string): boolean {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  }

  function renderLink(link: DashboardRoute) {
    return (
      <Link
        key={link.href}
        href={link.href}
        className="rail-link"
        data-active={isActive(link.href) ? 'true' : 'false'}
      >
        {link.label}
      </Link>
    );
  }

  return (
    <nav className="rail">
      <div className="rail-brand">
        Game<span>Forge</span>
      </div>
      {renderLink(NAV_OVERVIEW_ROUTE)}
      {NAV_PRIMARY_ROUTES.map(renderLink)}
      <div className="rail-divider" />
      {renderLink(NAV_SETTINGS_HUB_ROUTE)}
      {me && (
        <div style={{ marginTop: 'auto', paddingTop: 16, fontSize: 13 }}>
          <div>Logged in as {me.name}{me.isAdmin ? ' (admin)' : ''}</div>
          <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      )}
    </nav>
  );
}
```

- [ ] **Step 1: Write the failing test**

Create `test/navRailLoginPage.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NavRail } from '@/app/components/NavRail';
import { CopilotPanel } from '@/app/components/CopilotPanel';

let currentPathname = '/login';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NavRail/CopilotPanel on /login', () => {
  it('NavRail renders only the brand mark on /login, no nav links', () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<NavRail />);

    expect(screen.getByText('Forge')).toBeTruthy();
    expect(screen.queryByText('Generate')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
  });

  it('NavRail renders full nav on /dashboard', () => {
    currentPathname = '/dashboard';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<NavRail />);

    expect(screen.getByText('Generate')).toBeTruthy();
  });

  it('CopilotPanel renders nothing on /login even with a logged-in user', () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { id: 'u1', name: 'Alice', isAdmin: false } }),
    }));

    const { container } = render(<CopilotPanel />);

    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/navRailLoginPage.test.tsx`
Expected: FAIL — first and third tests fail (nav links/copilot button still render on `/login` today).

- [ ] **Step 3: Write minimal implementation**

In `app/components/NavRail.tsx`, replace the `return (...)` block:
```tsx
  if (pathname === '/login') {
    return (
      <nav className="rail">
        <div className="rail-brand">
          Game<span>Forge</span>
        </div>
      </nav>
    );
  }

  return (
    <nav className="rail">
      <div className="rail-brand">
        Game<span>Forge</span>
      </div>
      {renderLink(NAV_OVERVIEW_ROUTE)}
      {NAV_PRIMARY_ROUTES.map(renderLink)}
      <div className="rail-divider" />
      {renderLink(NAV_SETTINGS_HUB_ROUTE)}
      {me && (
        <div style={{ marginTop: 'auto', paddingTop: 16, fontSize: 13 }}>
          <div>Logged in as {me.name}{me.isAdmin ? ' (admin)' : ''}</div>
          <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      )}
    </nav>
  );
```

In `app/components/CopilotPanel.tsx`, change the import line (currently only imports `useRouter`):
```tsx
import { usePathname, useRouter } from 'next/navigation';
```
Add `const pathname = usePathname();` alongside the existing `const { user } = useCurrentUser();` /
`const router = useRouter();` lines near the top of the component, and change:
```tsx
  if (!user) return null;
```
to:
```tsx
  if (!user || pathname === '/login') return null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/navRailLoginPage.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean, no regressions in any other `NavRail`/`CopilotPanel` consumer test.

- [ ] **Step 6: Manual browser verification**

Log out, land on `/login`, confirm only the "GameForge" brand mark shows in the sidebar (no nav links,
no copilot button), then log in and confirm both reappear on `/dashboard`.

- [ ] **Step 7: Commit**

```bash
git add app/components/NavRail.tsx app/components/CopilotPanel.tsx test/navRailLoginPage.test.tsx
git commit -m "fix: stop rendering the dashboard nav and copilot button on the login page"
```

---

### Task 5: Guard the two unhandled initial-fetch job-detail pages

**Files:**
- Modify: `app/dashboard/jobs/[id]/edit/page.tsx`
- Modify: `app/dashboard/jobs/[id]/edit-component/page.tsx`
- Test: `test/editThemePage.test.tsx` (create)
- Test: `test/editComponentPage.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `test/editThemePage.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import EditThemePage from '@/app/dashboard/jobs/[id]/edit/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EditThemePage load failure', () => {
  it('shows an error instead of hanging on Loading… when the initial fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<EditThemePage params={Promise.resolve({ id: 'job1' })} />);

    await waitFor(() => expect(screen.getByText('Could not reach the server.')).toBeTruthy());
  });
});
```

Create `test/editComponentPage.test.tsx` (identical shape, different import):
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import EditComponentPage from '@/app/dashboard/jobs/[id]/edit-component/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EditComponentPage load failure', () => {
  it('shows an error instead of hanging on Loading… when the initial fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<EditComponentPage params={Promise.resolve({ id: 'job1' })} />);

    await waitFor(() => expect(screen.getByText('Could not reach the server.')).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/editThemePage.test.tsx test/editComponentPage.test.tsx`
Expected: FAIL — both currently throw an unhandled rejection / stay stuck on "Loading…" (the assertion
times out).

- [ ] **Step 3: Write minimal implementation**

In `app/dashboard/jobs/[id]/edit/page.tsx`, replace the effect body:
```tsx
    useEffect(() => {
      let ignore = false;
      (async () => {
        const res = await fetch(`/api/jobs/${id}`);
        const body = await res.json();
        if (ignore) return;
        if (!body.success) {
          setError(body.error ?? 'Could not load this job.');
          return;
        }
        setJob(body.data);
        try {
          const css = await (await fetch(`/api/themes/${body.data.result_path}`)).text();
          if (ignore) return;
          setTokens(parseThemeCss(css));
        } catch {
          if (!ignore) setError('Could not read this theme\'s current values.');
        }
      })();
      return () => { ignore = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
```
with:
```tsx
    useEffect(() => {
      let ignore = false;
      (async () => {
        try {
          const res = await fetch(`/api/jobs/${id}`);
          const body = await res.json();
          if (ignore) return;
          if (!body.success) {
            setError(body.error ?? 'Could not load this job.');
            return;
          }
          setJob(body.data);
          try {
            const css = await (await fetch(`/api/themes/${body.data.result_path}`)).text();
            if (ignore) return;
            setTokens(parseThemeCss(css));
          } catch {
            if (!ignore) setError('Could not read this theme\'s current values.');
          }
        } catch {
          if (!ignore) setError('Could not reach the server.');
        }
      })();
      return () => { ignore = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
```

In `app/dashboard/jobs/[id]/edit-component/page.tsx`, apply the identical wrapping shape:
```tsx
    useEffect(() => {
      let ignore = false;
      (async () => {
        try {
          const res = await fetch(`/api/jobs/${id}`);
          const body = await res.json();
          if (ignore) return;
          if (!body.success) {
            setError(body.error ?? 'Could not load this job.');
            return;
          }
          setJob(body.data);
          try {
            const document = await (await fetch(`/api/components/${body.data.result_path}`)).text();
            if (ignore) return;
            setTokens(parseComponentHtml(document));
          } catch {
            if (!ignore) setError('Could not read this component\'s current values.');
          }
        } catch {
          if (!ignore) setError('Could not reach the server.');
        }
      })();
      return () => { ignore = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/editThemePage.test.tsx test/editComponentPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean, no regressions.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/jobs/[id]/edit/page.tsx app/dashboard/jobs/[id]/edit-component/page.tsx test/editThemePage.test.tsx test/editComponentPage.test.tsx
git commit -m "fix: show an error instead of hanging when a job-detail page's initial fetch fails"
```

---

### Task 6: Worker heartbeat + worker-status route + Overview indicator

**Files:**
- Modify: `lib/config.ts`
- Modify: `worker.ts`
- Create: `app/api/dashboard/worker-status/route.ts`
- Modify: `app/dashboard/page.tsx`
- Test: `test/workerStatusRoute.test.ts` (create)

**Interfaces:**
- Consumes: `settingsService.get(key)`/`.set(key, value)` from `lib/services/SettingsService.ts`
  (existing, unchanged).
- Produces: `GET /api/dashboard/worker-status` → `{ success: true, data: { alive: boolean } }`.

Current `lib/config.ts` (full file):
```ts
export const ASEPRITE_PATH_SETTING_KEY = 'aseprite_path';
export const GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY = 'google_drive_refresh_token';
export const OLLAMA_HOST_SETTING_KEY = 'ollama_host';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
```

Current `worker.ts` `scheduleNext` (lines 281-291):
```ts
function scheduleNext(): void {
  setTimeout(async () => {
    try {
      await processJobs();
    } catch (error) {
      console.error('❌ Worker tick failed:', error);
    } finally {
      scheduleNext();
    }
  }, POLL_INTERVAL_MS);
}
```

- [ ] **Step 1: Write the failing test**

Create `test/workerStatusRoute.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '@/lib/database';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { settingsService } from '@/lib/services/SettingsService';
import { WORKER_LAST_SEEN_SETTING_KEY } from '@/lib/config';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workerstatus-'));
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  DatabaseConnection.getInstance(); // runs migrations
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/dashboard/worker-status', () => {
  it('reports alive:true when the heartbeat is fresh', async () => {
    await settingsService.set(WORKER_LAST_SEEN_SETTING_KEY, String(Date.now()));

    const { GET } = await import('@/app/api/dashboard/worker-status/route');
    const res = await GET();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.alive).toBe(true);
  });

  it('reports alive:false when the heartbeat is stale', async () => {
    await settingsService.set(WORKER_LAST_SEEN_SETTING_KEY, String(Date.now() - 60_000));

    const { GET } = await import('@/app/api/dashboard/worker-status/route');
    const res = await GET();
    const body = await res.json();

    expect(body.data.alive).toBe(false);
  });

  it('reports alive:false when no heartbeat has ever been written', async () => {
    const { GET } = await import('@/app/api/dashboard/worker-status/route');
    const res = await GET();
    const body = await res.json();

    expect(body.data.alive).toBe(false);
  });
});
```
(If `setProjectRootForTests`/`DatabaseConnection.resetForTests()` live at different import paths than
guessed above, check `test/settingsService.test.ts` — mentioned by name in the research — for this
repo's actual real-temp-DB test setup and match its exact imports instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workerStatusRoute.test.ts`
Expected: FAIL — `app/api/dashboard/worker-status/route.ts` doesn't exist yet (import error), and
`WORKER_LAST_SEEN_SETTING_KEY` doesn't exist in `lib/config.ts` yet.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/config.ts`:
```ts
// Written by worker.ts on every poll tick (see WORKER_ALIVE_THRESHOLD_MS below); read by
// GET /api/dashboard/worker-status to show a health indicator in the Overview page — nothing
// else consumes this key.
export const WORKER_LAST_SEEN_SETTING_KEY = 'worker_last_seen';

// 3x worker.ts's own POLL_INTERVAL_MS (2000ms, defined locally in worker.ts — not exported, since
// worker.ts is a script entry point, not a module other code should import from). A missed tick or
// two shouldn't flip the indicator to "not detected"; three missed ticks in a row genuinely means
// the worker process isn't running.
export const WORKER_ALIVE_THRESHOLD_MS = 6000;
```

**Do not piggyback the heartbeat write on `scheduleNext`/`processJobs`.** `scheduleNext` only
reschedules itself in its `finally`, AFTER `processJobs()` resolves — so writing the heartbeat at the
start of that same tick and then awaiting a possibly-long `processJobs()` call would leave the
heartbeat stale for the entire duration of any job that takes longer than
`WORKER_ALIVE_THRESHOLD_MS` (6000ms), falsely reporting "not detected" while the worker is actively,
correctly busy — real generation jobs (Pixellab/Claude API calls) routinely take far longer than 6
seconds. The heartbeat needs its own timer, independent of how long any individual job takes.

Add to `worker.ts`, near the top imports:
```ts
import { settingsService } from '@/lib/services/SettingsService';
import { WORKER_LAST_SEEN_SETTING_KEY } from '@/lib/config';
```

Leave `scheduleNext` itself completely unchanged. Instead, add a separate heartbeat function and start
it alongside `scheduleNext()` in the `isMainModule` block. Current `worker.ts` end (lines 293-305):
```ts
// Only run the actual worker loop (lock file, signal handlers, polling)
// when this file is the process entry point (`tsx worker.ts`) — not when
// a test imports processJob() to exercise it directly.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log(`🚀 GameForge worker started (pid ${process.pid}, batch size ${WORKER_BATCH_SIZE}).`);
  scheduleNext();
}
```
Replace with:
```ts
// Independent of scheduleNext/processJobs on purpose -- see the heartbeat
// note above Task 6's worker.ts changes in the plan this came from: a
// heartbeat gated behind a slow job's completion would falsely read "dead"
// while the worker is busy with real, long-running work.
function startHeartbeat(): void {
  setInterval(() => {
    settingsService.set(WORKER_LAST_SEEN_SETTING_KEY, String(Date.now())).catch(error => {
      console.error('❌ Worker heartbeat write failed:', error);
    });
  }, POLL_INTERVAL_MS);
}

// Only run the actual worker loop (lock file, signal handlers, polling)
// when this file is the process entry point (`tsx worker.ts`) — not when
// a test imports processJob() to exercise it directly.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log(`🚀 GameForge worker started (pid ${process.pid}, batch size ${WORKER_BATCH_SIZE}).`);
  startHeartbeat();
  scheduleNext();
}
```
(The heartbeat's own `.catch()` means a transient `settings` write failure never affects job
processing — the two are now fully independent, which also resolves the original design's other flaw:
a heartbeat-write failure no longer aborts that tick's `processJobs()` call, since they're not in the
same try/catch anymore.)

Create `app/api/dashboard/worker-status/route.ts` (matching `app/api/dashboard/activity/route.ts`'s
sibling shape — no auth check, same as that file):
```ts
import { NextResponse } from 'next/server';
import { settingsService } from '@/lib/services/SettingsService';
import { WORKER_LAST_SEEN_SETTING_KEY, WORKER_ALIVE_THRESHOLD_MS } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const lastSeen = await settingsService.get(WORKER_LAST_SEEN_SETTING_KEY);
    const alive = lastSeen !== null && Date.now() - Number(lastSeen) < WORKER_ALIVE_THRESHOLD_MS;
    return NextResponse.json({ success: true, data: { alive } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workerStatusRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the indicator to the Overview page**

This task touches ONLY the mount effect (add the worker-status fetch) and the stat-cards row (add a
4th card) in `app/dashboard/page.tsx`. It deliberately leaves the "Recent activity" block's loading
state and row markup untouched — those belong to Tasks 8 and 12 respectively, so each task's diff to
this shared file stays scoped to what it's actually named after.

Replace the mount effect:
```tsx
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [contextRes, activityRes] = await Promise.all([
          fetch('/api/context'),
          fetch('/api/dashboard/activity'),
        ]);
        const contextBody = await contextRes.json();
        const activityBody = await activityRes.json();
        if (!ignore) {
          if (contextBody.success) setContext(contextBody.data);
          if (activityBody.success) setActivity(activityBody.data);
        }
      } catch {
        // Non-fatal -- the page just shows zeros/an empty activity list.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);
```
with:
```tsx
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [contextRes, activityRes, workerRes] = await Promise.all([
          fetch('/api/context'),
          fetch('/api/dashboard/activity'),
          fetch('/api/dashboard/worker-status'),
        ]);
        const contextBody = await contextRes.json();
        const activityBody = await activityRes.json();
        const workerBody = await workerRes.json();
        if (!ignore) {
          if (contextBody.success) setContext(contextBody.data);
          if (activityBody.success) setActivity(activityBody.data);
          if (workerBody.success) setWorkerAlive(workerBody.data.alive);
        }
      } catch {
        // Non-fatal -- the page just shows zeros/an empty activity list.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);
```
Add the new state declaration alongside the existing `context`/`activity`/`loading` ones:
```tsx
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);
```

Replace the 3-card `.stat-cards` block:
```tsx
      <div className="stat-cards">
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Active styles</div>
          <div className="stat-card-value">{loading ? '—' : context?.styles.length ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Total assets</div>
          <div className="stat-card-value">{loading ? '—' : context?.totalActiveAssets ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Jobs in flight</div>
          <div className="stat-card-value">{loading ? '—' : context?.inFlightJobs ?? 0}</div>
        </div>
      </div>
```
with:
```tsx
      <div className="stat-cards">
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Active styles</div>
          <div className="stat-card-value">{loading ? '—' : context?.styles.length ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Total assets</div>
          <div className="stat-card-value">{loading ? '—' : context?.totalActiveAssets ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Jobs in flight</div>
          <div className="stat-card-value">{loading ? '—' : context?.inFlightJobs ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Worker</div>
          <div className="stat-card-value" style={{ fontSize: 15 }}>
            {loading || workerAlive === null
              ? '—'
              : workerAlive
                ? <span style={{ color: 'var(--accept, #3fb950)' }}>● running</span>
                : <span style={{ color: 'var(--reject)' }}>○ not detected</span>}
          </div>
        </div>
      </div>
```

Check `app/globals.css` for whether `--accept` is already a defined custom property (grep for
`--accept`) — if it isn't, use a literal green hex instead of `var(--accept, #3fb950)` (the fallback
syntax above already handles either case safely, but confirm during implementation rather than leaving
an unused fallback).

- [ ] **Step 6: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 7: Manual browser verification**

With `npm run dev:worker` running, reload the Overview page and confirm "● running" shows. Stop the
worker process, wait ~6 seconds, reload, and confirm it flips to "○ not detected".

- [ ] **Step 8: Commit**

```bash
git add lib/config.ts worker.ts app/api/dashboard/worker-status/route.ts app/dashboard/page.tsx test/workerStatusRoute.test.ts
git commit -m "feat: surface a worker-health indicator on the Overview page"
```

---

### Task 7: Export page empty state

**Files:**
- Modify: `app/dashboard/export/page.tsx`
- Test: `test/exportPageEmptyState.test.tsx` (create)

**Interfaces:**
- Consumes: `useStyles()` (existing, unchanged).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `test/exportPageEmptyState.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ExportPage from '@/app/dashboard/export/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Export page empty state', () => {
  it('shows an empty-state message instead of the form when there are no Style Bibles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: [] }) }));

    render(<ExportPage />);

    expect(await screen.findByText(/no style bibles yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export to Godot' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/exportPageEmptyState.test.tsx`
Expected: FAIL — the form renders unconditionally today, so `queryByRole` finds the button.

- [ ] **Step 3: Write minimal implementation**

Replace `app/dashboard/export/page.tsx` in full:
```tsx
'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';

export default function ExportPage() {
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
  const [selectedStyleId, setSelectedStyleId] = useState('');
  const styleId = selectedStyleId || styles[0]?.id || '';
  const [subdir, setSubdir] = useState('godot');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ exported: number; skipped: number; targetDir: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(e: React.FormEvent) {
    e.preventDefault();
    if (running || !styleId || !subdir.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleId, subdir: subdir.trim() }),
      });
      const body = await res.json();
      if (body.success) {
        setResult(body.data);
      } else {
        setError(body.error ?? 'Export failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Export</h1>
      <p className="page-subtitle">
        Copy one Style Bible&apos;s active asset images into <code>storage/exports/</code> for your Godot
        project (2D only for V1).
      </p>

      {!stylesLoading && !stylesError && styles.length === 0 ? (
        <div className="empty-state">
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page before exporting.
        </div>
      ) : (
        <form className="card" onSubmit={handleExport} style={{ maxWidth: 420 }}>
          <StyleBiblePicker styles={styles} value={styleId} onChange={setSelectedStyleId} />

          {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 14 }}>{stylesError}</p>}

          <div className="field">
            <label htmlFor="subdir">Export folder name</label>
            <input id="subdir" value={subdir} onChange={e => setSubdir(e.target.value)} placeholder="godot" />
          </div>

          <button className="btn btn-primary" type="submit" disabled={running || !styleId || !subdir.trim() || stylesLoading}>
            {running ? 'Exporting…' : 'Export to Godot'}
          </button>

          {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 14 }}>{error}</p>}

          {result && (
            <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginTop: 14 }}>
              Exported {result.exported} asset{result.exported === 1 ? '' : 's'}
              {result.skipped > 0 ? ` (${result.skipped} skipped)` : ''} to <code>{result.targetDir}</code>.
            </p>
          )}
        </form>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/exportPageEmptyState.test.tsx`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/export/page.tsx test/exportPageEmptyState.test.tsx
git commit -m "fix: show an empty state on the Export page when there are no Style Bibles"
```

---

### Task 8: Loading indicators for the Assets grid and Overview activity

**Files:**
- Modify: `app/dashboard/assets/page.tsx`
- Modify: `app/dashboard/page.tsx`
- Test: `test/assetsPageLoading.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `test/assetsPageLoading.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import AssetsPage from '@/app/dashboard/assets/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Assets page loading state', () => {
  it('shows a loading indicator, not an empty grid, while the initial fetch is in flight', () => {
    // A fetch that never resolves during this test's lifetime.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    render(<AssetsPage />);

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/nothing promoted yet/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assetsPageLoading.test.tsx`
Expected: FAIL — no "Loading…" text exists today; the grid renders (empty) instead.

- [ ] **Step 3: Write minimal implementation**

In `app/dashboard/assets/page.tsx`, replace:
```tsx
      {!loading && !error && assets.length === 0 ? (
        <div className="empty-state">
          Nothing promoted yet. Review completed jobs on the <strong>Jobs</strong> page.
        </div>
      ) : (
```
with:
```tsx
      {loading ? (
        <p className="page-subtitle">Loading…</p>
      ) : !error && assets.length === 0 ? (
        <div className="empty-state">
          Nothing promoted yet. Review completed jobs on the <strong>Jobs</strong> page.
        </div>
      ) : (
```
(Dropped the redundant `!loading &&` from the middle clause since the outer `loading ?` branch now
handles that case first.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assetsPageLoading.test.tsx`
Expected: PASS

- [ ] **Step 5: Add the Overview activity loading branch**

In `app/dashboard/page.tsx`, replace:
```tsx
      {!loading && activity.length === 0 ? (
        <div className="empty-state">No recent activity yet. Generate something to see it here.</div>
      ) : (
```
with:
```tsx
      {loading ? (
        <p className="page-subtitle">Loading…</p>
      ) : activity.length === 0 ? (
        <div className="empty-state">No recent activity yet. Generate something to see it here.</div>
      ) : (
```

- [ ] **Step 6: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/assets/page.tsx app/dashboard/page.tsx test/assetsPageLoading.test.tsx
git commit -m "fix: show a loading indicator instead of a blank grid/list during initial fetch"
```

---

### Task 9: Real labels on the four placeholder-only inputs

**Files:**
- Modify: `app/dashboard/styles/page.tsx`
- Modify: `app/login/LoginForm.tsx`
- Modify: `app/dashboard/assets/[id]/page.tsx`
- Test: `test/inputLabels.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `test/inputLabels.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StylesPage from '@/app/dashboard/styles/page';
import { LoginForm } from '@/app/login/LoginForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/styles',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Input labeling', () => {
  // getByLabelText, not getByRole('textbox', {name}) -- Testing Library's
  // accessible-name computation falls back to the placeholder attribute for
  // an unlabeled text input, so a getByRole name-match could pass BEFORE
  // the fix (a false-green RED step). getByLabelText specifically requires
  // a real <label> association (htmlFor, aria-labelledby, or wrapping) and
  // does not fall back to placeholder, so it only passes once the label
  // actually exists.
  it('New Style Bible name input has a real label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: [] }) }));
    render(<StylesPage />);
    expect(await screen.findByLabelText('New Style Bible name')).toBeTruthy();
  });

  it('Inspo search input has a real label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: [] }) }));
    render(<StylesPage />);
    expect(await screen.findByLabelText('Inspo search')).toBeTruthy();
  });

  it('LoginForm "Your name" input has a real label', () => {
    render(<LoginForm users={[]} />);
    expect(screen.getByLabelText('Your name')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inputLabels.test.tsx`
Expected: FAIL on all 3 — `getByLabelText(...)` finds nothing since none of these three inputs has a
real `<label>` yet.

- [ ] **Step 3: Write minimal implementation**

In `app/dashboard/styles/page.tsx`, replace:
```tsx
      <form className="card" onSubmit={handleCreate} style={{ marginBottom: 32, maxWidth: 420, display: 'flex', gap: 10 }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="New Style Bible name"
          style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
        />
        <button className="btn btn-primary" type="submit" disabled={creating || !name.trim()}>
```
with:
```tsx
      <form className="card" onSubmit={handleCreate} style={{ marginBottom: 32, maxWidth: 420, display: 'flex', gap: 10 }}>
        <label htmlFor="newStyleName" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>New Style Bible name</label>
        <input
          id="newStyleName"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="New Style Bible name"
          style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
        />
        <button className="btn btn-primary" type="submit" disabled={creating || !name.trim()}>
```
(Uses the visually-hidden pattern here, not the plain-visible `.field` pattern, because this input's
existing layout is the inline flex-row shape with no room for a visible label above it — matching the
Inspo search input's identical layout shape just below it, treated the same way for consistency within
this one file's two identically-shaped inputs.)

And replace:
```tsx
              <form onSubmit={handleInspoSearch} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <input
                  value={inspoQuery}
                  onChange={e => setInspoQuery(e.target.value)}
                  placeholder="e.g. warm editorial SaaS"
                  style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
                />
                <button className="btn btn-primary" type="submit" disabled={inspoSearching || !inspoQuery.trim()}>
```
with:
```tsx
              <form onSubmit={handleInspoSearch} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <label htmlFor="inspoSearch" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Inspo search</label>
                <input
                  id="inspoSearch"
                  value={inspoQuery}
                  onChange={e => setInspoQuery(e.target.value)}
                  placeholder="e.g. warm editorial SaaS"
                  style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
                />
                <button className="btn btn-primary" type="submit" disabled={inspoSearching || !inspoQuery.trim()}>
```

In `app/login/LoginForm.tsx`, inside the `createAccountForm` helper (from Task 3 — if Task 3 hasn't
landed yet, apply this to both the `handleCreateFirst` form in the `users.length === 0` branch), replace:
```tsx
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Your name" />
```
with:
```tsx
          <label htmlFor="newAccountName" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>Your name</label>
          <input id="newAccountName" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Your name" />
```

In `app/dashboard/assets/[id]/page.tsx`, replace:
```tsx
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={newState} onChange={e => setNewState(e.target.value)} placeholder="hover" onKeyDown={e => e.key === 'Enter' && addState()} />
                <button className="btn" onClick={addState}>Add</button>
              </div>
```
with:
```tsx
              <div style={{ display: 'flex', gap: 8 }}>
                <label htmlFor="newStateName" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}>New state name</label>
                <input id="newStateName" value={newState} onChange={e => setNewState(e.target.value)} placeholder="hover" onKeyDown={e => e.key === 'Enter' && addState()} />
                <button className="btn" onClick={addState}>Add</button>
              </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/inputLabels.test.tsx`
Expected: PASS (all 3)

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/styles/page.tsx app/login/LoginForm.tsx app/dashboard/assets/[id]/page.tsx test/inputLabels.test.tsx
git commit -m "fix: add accessible labels to four placeholder-only inputs"
```

---

### Task 10: Dialog semantics on the two custom modals

**Files:**
- Modify: `app/dashboard/presets/page.tsx`
- Modify: `app/dashboard/drive/DriveBrowser.tsx`
- Test: `test/modalAccessibility.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `test/modalAccessibility.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import PresetsPage from '@/app/dashboard/presets/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Apply-preset modal accessibility', () => {
  it('has dialog semantics and closes on Escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: [{ id: 'p1', name: 'My Preset' }] }),
    }));

    render(<PresetsPage />);

    const applyButton = await screen.findByRole('button', { name: 'Apply' });
    fireEvent.click(applyButton);

    const dialog = screen.getByRole('dialog', { name: 'Apply preset' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
```
(Uses `PresetsPage` as the representative case for both modals, since they share the exact same
structural fix — `DriveBrowser`'s move-modal gets the identical treatment without a separate test file,
per this task's Step 5 below; a second full RTL test for `DriveBrowser`'s modal would need to mock its
polling hook and Drive service just to reach the same assertion shape, which is disproportionate
duplication for an identical fix — covered instead by the manual browser check in Step 7.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/modalAccessibility.test.tsx`
Expected: FAIL — `getByRole('dialog', ...)` finds nothing today (no `role="dialog"` exists).

- [ ] **Step 3: Write minimal implementation**

In `app/dashboard/presets/page.tsx`, add `useEffect, useRef` to the existing React import if not
already present, then replace the modal block:
```tsx
      {applyingId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Apply preset</strong>
              <button className="btn" onClick={() => setApplyingId(null)}>Cancel</button>
            </div>
```
with:
```tsx
      {applyingId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Apply preset"
          onKeyDown={e => { if (e.key === 'Escape') setApplyingId(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
        >
          <div className="card" style={{ width: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Apply preset</strong>
              <button className="btn" ref={cancelButtonRef} onClick={() => setApplyingId(null)}>Cancel</button>
            </div>
```
Add a ref and two focus-management effects near the top of the component (after the existing state
declarations):
```tsx
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const applyTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (applyingId) {
      applyTriggerRef.current = document.activeElement as HTMLElement;
      cancelButtonRef.current?.focus();
    } else {
      applyTriggerRef.current?.focus();
    }
  }, [applyingId]);
```

In `app/dashboard/drive/DriveBrowser.tsx` (already imports `useRef`), apply the identical shape to its
modal:
```tsx
      {movingItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Move &quot;{movingItem.name}&quot;</strong>
              <button className="btn" onClick={() => setMovingItem(null)}>Cancel</button>
            </div>
```
becomes:
```tsx
      {movingItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Move ${movingItem.name}`}
          onKeyDown={e => { if (e.key === 'Escape') setMovingItem(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
        >
          <div className="card" style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Move &quot;{movingItem.name}&quot;</strong>
              <button className="btn" ref={moveCancelButtonRef} onClick={() => setMovingItem(null)}>Cancel</button>
            </div>
```
with the same ref/effect pair added near its state declarations:
```tsx
  const moveCancelButtonRef = useRef<HTMLButtonElement>(null);
  const moveTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (movingItem) {
      moveTriggerRef.current = document.activeElement as HTMLElement;
      moveCancelButtonRef.current?.focus();
    } else {
      moveTriggerRef.current?.focus();
    }
  }, [movingItem]);
```
(`DriveBrowser` already imports `useEffect`; only the two new refs and one new effect are added.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/modalAccessibility.test.tsx`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 6: Manual browser verification**

Open the apply-preset modal, confirm focus lands on Cancel, press Escape (modal closes, focus returns
to the Apply button that opened it). This fix adds initial-focus placement, `role="dialog"`, and
Escape-to-close — it does NOT add a full focus trap, so Tab can still reach elements behind the modal;
that's consistent with the spec's actual scope, not a gap to check for here. Repeat for Drive's
move-file modal.

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/presets/page.tsx app/dashboard/drive/DriveBrowser.tsx test/modalAccessibility.test.tsx
git commit -m "fix: add dialog semantics, Escape-to-close, and focus management to the two custom modals"
```

---

### Task 11: Keyboard support for the sprite-sheet crop-box editor

**Files:**
- Modify: `lib/hooks/useDraggableBoxes.ts`
- Modify: `app/dashboard/jobs/[id]/split/page.tsx`
- Modify: `app/dashboard/ui-sheets/page.tsx`
- Test: `test/draggableBoxKeyboard.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `boxKeyboardDelta(key: string, shiftKey: boolean, box: {w:number,h:number}) =>
  Partial<{x,y,w,h}> | null` and `MIN_SIZE` (both newly exported from `lib/hooks/useDraggableBoxes.ts`)
  — both real consumer pages import and call this exact function from their `onKeyDown` handlers, and
  the test exercises this same exported function directly, not a reimplementation of it. This is a
  deliberate change from treating this as pointer-vs-keyboard-are-separate-concerns: a keyboard input
  handler is real interaction logic, not static JSX, and this codebase's own bar for extracting a
  shared helper ("on sight for safety-critical logic," `AGENTS.md`) is better served by one tested
  function than by two hand-copied `onKeyDown` blocks that could silently drift apart.

Current `lib/hooks/useDraggableBoxes.ts` (full file):
```ts
'use client';

import { useCallback, useRef, useState } from 'react';

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 8;

export function useDraggableBoxes<T extends Box>(initial: T[]) {
  const [boxes, setBoxes] = useState<T[]>(initial);
  const dragState = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; startBox: Box } | null>(null);

  const updateBox = useCallback((id: string, patch: Partial<T>) => {
    setBoxes(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const addBox = useCallback((box: T) => {
    setBoxes(prev => [...prev, box]);
  }, []);

  const removeBox = useCallback((id: string) => {
    setBoxes(prev => prev.filter(b => b.id !== id));
  }, []);

  const startDrag = useCallback((id: string, mode: 'move' | 'resize', clientX: number, clientY: number) => {
    const box = boxes.find(b => b.id === id);
    if (!box) return;
    dragState.current = { id, mode, startX: clientX, startY: clientY, startBox: { ...box } };

    function onMove(e: MouseEvent) {
      const state = dragState.current;
      if (!state) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (state.mode === 'move') {
        updateBox(state.id, { x: state.startBox.x + dx, y: state.startBox.y + dy } as Partial<T>);
      } else {
        updateBox(state.id, {
          w: Math.max(MIN_SIZE, state.startBox.w + dx),
          h: Math.max(MIN_SIZE, state.startBox.h + dy),
        } as Partial<T>);
      }
    }

    function onUp() {
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [boxes, updateBox]);

  return { boxes, addBox, updateBox, removeBox, startDrag };
}
```

- [ ] **Step 1: Write the failing test**

Create `test/draggableBoxKeyboard.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { boxKeyboardDelta, MIN_SIZE } from '@/lib/hooks/useDraggableBoxes';

describe('boxKeyboardDelta', () => {
  const box = { w: 20, h: 20 };

  it('moves right by 4px on ArrowRight', () => {
    expect(boxKeyboardDelta('ArrowRight', false, box)).toEqual({ x: 4 });
  });

  it('moves left by 4px on ArrowLeft', () => {
    expect(boxKeyboardDelta('ArrowLeft', false, box)).toEqual({ x: -4 });
  });

  it('moves down/up by 4px on ArrowDown/ArrowUp', () => {
    expect(boxKeyboardDelta('ArrowDown', false, box)).toEqual({ y: 4 });
    expect(boxKeyboardDelta('ArrowUp', false, box)).toEqual({ y: -4 });
  });

  it('grows width by 4px on Shift+ArrowRight', () => {
    expect(boxKeyboardDelta('ArrowRight', true, box)).toEqual({ w: 24 });
  });

  it('shrinks width on Shift+ArrowLeft, floored at MIN_SIZE', () => {
    expect(boxKeyboardDelta('ArrowLeft', true, { w: 10, h: 20 })).toEqual({ w: MIN_SIZE });
  });

  it('returns null for an unhandled key', () => {
    expect(boxKeyboardDelta('Enter', false, box)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/draggableBoxKeyboard.test.tsx`
Expected: FAIL — `boxKeyboardDelta` and the exported `MIN_SIZE` don't exist yet (import error).

- [ ] **Step 3: Write minimal implementation**

Replace `lib/hooks/useDraggableBoxes.ts` in full:
```ts
'use client';

import { useCallback, useRef, useState } from 'react';

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SIZE = 8;
const KEYBOARD_STEP = 4;

// Pure and exported so both real consumer pages (split/page.tsx,
// ui-sheets/page.tsx) call this exact function from their onKeyDown
// handlers instead of each hand-copying the same logic, and so a test can
// exercise the real behavior directly rather than a reimplementation of it.
export function boxKeyboardDelta(
  key: string,
  shiftKey: boolean,
  box: { w: number; h: number },
): { x: number } | { y: number } | { w: number } | { h: number } | null {
  if (key === 'ArrowRight') return shiftKey ? { w: Math.max(MIN_SIZE, box.w + KEYBOARD_STEP) } : { x: KEYBOARD_STEP };
  if (key === 'ArrowLeft') return shiftKey ? { w: Math.max(MIN_SIZE, box.w - KEYBOARD_STEP) } : { x: -KEYBOARD_STEP };
  if (key === 'ArrowDown') return shiftKey ? { h: Math.max(MIN_SIZE, box.h + KEYBOARD_STEP) } : { y: KEYBOARD_STEP };
  if (key === 'ArrowUp') return shiftKey ? { h: Math.max(MIN_SIZE, box.h - KEYBOARD_STEP) } : { y: -KEYBOARD_STEP };
  return null;
}

export function useDraggableBoxes<T extends Box>(initial: T[]) {
  const [boxes, setBoxes] = useState<T[]>(initial);
  const dragState = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; startBox: Box } | null>(null);

  const updateBox = useCallback((id: string, patch: Partial<T>) => {
    setBoxes(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const addBox = useCallback((box: T) => {
    setBoxes(prev => [...prev, box]);
  }, []);

  const removeBox = useCallback((id: string) => {
    setBoxes(prev => prev.filter(b => b.id !== id));
  }, []);

  const startDrag = useCallback((id: string, mode: 'move' | 'resize', clientX: number, clientY: number) => {
    const box = boxes.find(b => b.id === id);
    if (!box) return;
    dragState.current = { id, mode, startX: clientX, startY: clientY, startBox: { ...box } };

    function onMove(e: MouseEvent) {
      const state = dragState.current;
      if (!state) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (state.mode === 'move') {
        updateBox(state.id, { x: state.startBox.x + dx, y: state.startBox.y + dy } as Partial<T>);
      } else {
        updateBox(state.id, {
          w: Math.max(MIN_SIZE, state.startBox.w + dx),
          h: Math.max(MIN_SIZE, state.startBox.h + dy),
        } as Partial<T>);
      }
    }

    function onUp() {
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [boxes, updateBox]);

  return { boxes, addBox, updateBox, removeBox, startDrag };
}
```
Note: `boxKeyboardDelta`'s ArrowRight/Down "move" branches return a fixed `+KEYBOARD_STEP` delta, not
`box.x + KEYBOARD_STEP` — the caller (Step 4 below) applies it as `x: box.x + delta.x`, keeping the
pure function's contract as "how far and which direction," independent of the box's current absolute
position. This matters for the test above: `{ x: 4 }` is the delta, not the new absolute x.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/draggableBoxKeyboard.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Wire the real function into both consumer pages**

In `app/dashboard/jobs/[id]/split/page.tsx`, add `boxKeyboardDelta` to the existing
`useDraggableBoxes` import, then replace the box wrapper `<div>`:
```tsx
            <div
              key={box.id}
              style={{
                position: 'absolute',
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
                border: `1px solid ${box.included ? 'var(--accent)' : 'var(--ink-faint)'}`,
                opacity: box.included ? 1 : 0.4,
                cursor: 'move',
              }}
              onMouseDown={e => draggable.startDrag(box.id, 'move', e.clientX, e.clientY)}
            >
```
with:
```tsx
            <div
              key={box.id}
              tabIndex={0}
              role="group"
              aria-label={`Piece: ${box.label || 'unlabeled'}`}
              style={{
                position: 'absolute',
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
                border: `1px solid ${box.included ? 'var(--accent)' : 'var(--ink-faint)'}`,
                opacity: box.included ? 1 : 0.4,
                cursor: 'move',
                outline: 'none',
              }}
              onMouseDown={e => draggable.startDrag(box.id, 'move', e.clientX, e.clientY)}
              onKeyDown={e => {
                const delta = boxKeyboardDelta(e.key, e.shiftKey, box);
                if (!delta) return;
                if ('x' in delta) draggable.updateBox(box.id, { x: box.x + delta.x });
                else if ('y' in delta) draggable.updateBox(box.id, { y: box.y + delta.y });
                else draggable.updateBox(box.id, delta);
                e.preventDefault();
              }}
              onFocus={e => { e.currentTarget.style.outline = '2px solid var(--accent)'; }}
              onBlur={e => { e.currentTarget.style.outline = 'none'; }}
            >
```

In `app/dashboard/ui-sheets/page.tsx`, add `boxKeyboardDelta` to its existing `useDraggableBoxes`
import (this file destructures `updateBox` directly, not via a `draggable.` object), then apply the
identical shape:
```tsx
                <div
                  key={box.id}
                  tabIndex={0}
                  role="group"
                  aria-label={`Piece: ${box.label || 'unlabeled'}`}
                  style={{
                    position: 'absolute',
                    left: box.x,
                    top: box.y,
                    width: box.w,
                    height: box.h,
                    border: '1px solid var(--accent)',
                    borderRadius: box.kind === 'circle' ? '50%' : 4,
                    cursor: 'move',
                    outline: 'none',
                  }}
                  onMouseDown={e => startDrag(box.id, 'move', e.clientX, e.clientY)}
                  onKeyDown={e => {
                    const delta = boxKeyboardDelta(e.key, e.shiftKey, box);
                    if (!delta) return;
                    if ('x' in delta) updateBox(box.id, { x: box.x + delta.x });
                    else if ('y' in delta) updateBox(box.id, { y: box.y + delta.y });
                    else updateBox(box.id, delta);
                    e.preventDefault();
                  }}
                  onFocus={e => { e.currentTarget.style.outline = '2px solid var(--accent)'; }}
                  onBlur={e => { e.currentTarget.style.outline = 'none'; }}
                >
```

- [ ] **Step 6: Run full suite**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean, no regressions in `test/pieceShapes.test.ts` or other split/ui-sheets-adjacent
tests.

- [ ] **Step 7: Manual browser verification**

On the "Split into elements" page, Tab to a piece box, confirm a visible focus outline appears, use
arrow keys to move it and Shift+arrow keys to resize it, confirm the label input and resize handle
inside the box still work with mouse as before. Repeat on the UI Sheets page.

- [ ] **Step 8: Commit**

```bash
git add lib/hooks/useDraggableBoxes.ts "app/dashboard/jobs/[id]/split/page.tsx" app/dashboard/ui-sheets/page.tsx test/draggableBoxKeyboard.test.tsx
git commit -m "fix: add keyboard move/resize support to the sprite-sheet crop-box editor"
```

---

### Task 12: Clickable activity rows

**Files:**
- Modify: `app/dashboard/page.tsx`
- Test: `test/overviewActivityLinks.test.tsx` (create)

**Interfaces:**
- Consumes: `ActivityItem` type from `lib/services/recentActivity.ts` (existing — has `id`, `kind:
  'job' | 'style'`, `label`, `timestamp`; unchanged).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `test/overviewActivityLinks.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import OverviewPage from '@/app/dashboard/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Overview activity row links', () => {
  it('links a job-kind activity row to /dashboard/jobs and a style-kind row to its style detail page', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/dashboard/activity') {
        return Promise.resolve({ json: () => Promise.resolve({
          success: true,
          data: [
            { id: 'job1', kind: 'job', label: 'Generation failed: "Button"', timestamp: 1 },
            { id: 'style1', kind: 'style', label: 'Created Style Bible "ecologi-com"', timestamp: 2 },
          ],
        }) });
      }
      // Covers both /api/context and /api/dashboard/worker-status with one
      // shape that satisfies both consumers -- context?.styles.length (etc.)
      // in the real component would throw on {} here, since {}.styles is
      // undefined; this must be a realistic ProjectContextSummary-shaped
      // object, not an empty one.
      return Promise.resolve({ json: () => Promise.resolve({
        success: true,
        data: { styles: [], totalActiveAssets: 0, inFlightJobs: 0, alive: false },
      }) });
    }));

    render(<OverviewPage />);

    const jobLink = await screen.findByRole('link', { name: /generation failed/i });
    expect(jobLink.getAttribute('href')).toBe('/dashboard/jobs');

    const styleLink = screen.getByRole('link', { name: /created style bible/i });
    expect(styleLink.getAttribute('href')).toBe('/dashboard/styles/style1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then write minimal implementation**

Run: `npx vitest run test/overviewActivityLinks.test.tsx`
Expected: FAIL — activity rows are plain `<div>`s today, no `link` role exists.

In `app/dashboard/page.tsx`, replace:
```tsx
        <div>
          {activity.map(item => (
            <div key={item.id} className="activity-row">
              <div>{item.label}</div>
              <div className="activity-row-meta">{new Date(item.timestamp).toLocaleString()}</div>
            </div>
          ))}
        </div>
```
with:
```tsx
        <div>
          {activity.map(item => (
            <Link
              key={item.id}
              href={item.kind === 'job' ? '/dashboard/jobs' : `/dashboard/styles/${item.id}`}
              className="activity-row"
            >
              <div>{item.label}</div>
              <div className="activity-row-meta">{new Date(item.timestamp).toLocaleString()}</div>
            </Link>
          ))}
        </div>
```
(`Link` from `next/link` is already imported in this file for the Quick Actions buttons above.)

- [ ] **Step 3: Run test to verify it passes, then full suite**

Run: `npx vitest run test/overviewActivityLinks.test.tsx`
Expected: PASS
Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/page.tsx test/overviewActivityLinks.test.tsx
git commit -m "fix: make Overview activity rows clickable links to the relevant job/style page"
```

---

### Task 13: Favicon

**Files:**
- Create: `app/icon.tsx`
- Test: manual only (a generated-icon route has no meaningful unit-test surface — see Step 2)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

No existing GameForge logo/mark asset exists anywhere in the repo (confirmed — `public/` has only
font files). Per Next.js's file-based icon convention (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md`),
`app/icon.tsx` default-exporting a function returning an `ImageResponse` from `next/og` is a fully
supported, code-generated alternative to a static file — no image-editing tooling needed for this
fix.

- [ ] **Step 1: Write the implementation**

Create `app/icon.tsx`:
```tsx
import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0A0A0A',
          color: '#FF4F00',
          fontSize: 20,
          fontWeight: 700,
          fontFamily: 'sans-serif',
        }}
      >
        GF
      </div>
    ),
    size,
  );
}
```
(`#0A0A0A`/`#FF4F00` are this app's actual `--accent-ink`/`--accent` custom-property values, per
`app/globals.css` — not approximate colors.)

- [ ] **Step 2: Verify — no unit test applies**

This is a Next.js file-convention route with no exported logic to unit-test beyond "does it render
without throwing," which `npx tsc --noEmit` and a manual browser load already cover; adding a
synthetic test here would just re-assert that `ImageResponse` (a Next.js/Vercel-maintained API) works,
not anything this codebase owns.

- [ ] **Step 3: Run typecheck/lint, then manual browser verification**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: clean.
Start `npm run dev` (if not already running), load any page, open browser devtools' Network tab,
confirm no 404 for a favicon-shaped request and that the tab shows the new "GF" icon.

- [ ] **Step 4: Commit**

```bash
git add app/icon.tsx
git commit -m "fix: add a generated favicon instead of 404ing on every page load"
```

---

### Task 14: Asset-type field — fixed dropdown instead of free text

**Files:**
- Modify: `app/dashboard/generate/page.tsx`
- Test: `test/generatePageAssetType.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new. `assetType` state (existing `useState('sprite')`) is unchanged in type
  (`string`) — only the input element changes from `<input>` to `<select>`.
- Produces: nothing later tasks depend on.

Confirmed during research: `assetType` is genuinely unconstrained server-side
(`z.string().min(1)` in both `app/api/generate/route.ts`'s `GenerateSchema` and
`lib/database/schema.ts`'s `AssetSchema`/`JobSchema` — no enum). The only two values used anywhere in
the app today are `'sprite'` (this page's hardcoded default) and `'ui_sheet'` (a different page,
hardcoded, not user-facing). There is no real list of valid values to build a multi-option dropdown
from — the fix is a disabled/fixed single-option `<select>`, matching this page's own Size dropdown's
element type so the two fields look consistent, not a fabricated set of choices.

- [ ] **Step 1: Write the failing test**

Create `test/generatePageAssetType.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import GeneratePage from '@/app/dashboard/generate/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Generate page Asset type field', () => {
  it('renders Asset type as a select, not a free-text input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: [{ id: 's1', name: 'My Style' }] }),
    }));

    render(<GeneratePage />);

    const field = await screen.findByLabelText('Asset type');
    expect(field.tagName).toBe('SELECT');
    expect((field as HTMLSelectElement).value).toBe('sprite');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/generatePageAssetType.test.tsx`
Expected: FAIL — `field.tagName` is currently `INPUT`, not `SELECT`.

- [ ] **Step 3: Write minimal implementation**

In `app/dashboard/generate/page.tsx`, replace:
```tsx
            <div className="field">
              <label htmlFor="assetType">Asset type</label>
              <input id="assetType" value={assetType} onChange={e => setAssetType(e.target.value)} placeholder="sprite" />
            </div>
```
with:
```tsx
            <div className="field">
              <label htmlFor="assetType">Asset type</label>
              <select id="assetType" value={assetType} onChange={e => setAssetType(e.target.value)}>
                <option value="sprite">sprite</option>
              </select>
            </div>
```
(`setAssetType`/`assetType` state itself is untouched — still a plain `string`, default `'sprite'`,
same as before; only the rendered control changes. If this app ever gains a second real asset-type
value server-side, add a second `<option>` here then — not before, per YAGNI.)

- [ ] **Step 4: Run test to verify it passes, then full suite**

Run: `npx vitest run test/generatePageAssetType.test.tsx`
Expected: PASS
Run: `npx tsc --noEmit && npx eslint app lib worker.ts && npx vitest run`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/generate/page.tsx test/generatePageAssetType.test.tsx
git commit -m "fix: replace Generate page's free-text Asset type input with a fixed dropdown"
```

---

## Post-plan: final review

After all 14 tasks are complete, dispatch the final whole-branch code reviewer
(`superpowers:requesting-code-review`'s `code-reviewer.md`, most capable available model), then run a
DeepSeek Mode 2 review of the full branch diff (`git diff main...HEAD`) as a second, cross-model pass —
per this project's standing per-task-AND-final-review DeepSeek mandate. Fix any findings from both,
scoped re-review the fix diff, then proceed to push/PR/CI/merge per this project's established
autonomous-once-clean practice.
