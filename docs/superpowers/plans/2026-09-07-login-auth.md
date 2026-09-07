# Login / Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GameForge's fully client-spoofable `createdBy`/`requestingUserId` identity pattern with real server-verified sessions (named accounts, no passwords), plus an admin bypass on Style Bible ownership.

**Architecture:** Two new SQLite tables (`users`, `sessions`) behind two new services. A random-token cookie, read via `NextRequest.cookies`/`NextResponse.cookies` (never `next/headers`'s `cookies()` — keeps every route unit-testable the same way this codebase's existing route tests already work). `users` joins GitService's existing JSON export/import sync (`sessions` never does — it's local-machine-only). A `proxy.ts` (Next.js 16 renamed `middleware.ts` → `proxy.ts`) does an optimistic cookie-presence redirect to `/login`; every route that creates or gates content does the real, DB-backed check itself via one shared `getCurrentUser()` helper.

**Tech Stack:** Next.js 16.3.4 (App Router, Route Handlers, Proxy), better-sqlite3, Zod, Vitest. No new dependencies — no JWT/session library, per AGENTS.md's "no utility libraries, simplest thing that works" and the spec's own reasoning (a random unguessable token needs no signature; the server is the only party that ever reads it).

**Spec:** `docs/superpowers/specs/2026-09-07-login-auth-design.md`

## Global Constraints

- AGENTS.md FORBIDDEN list applies to every task: no wrapper classes around existing services, no DTOs (use Zod directly), no factory patterns, no repository patterns (use DataStore/service singletons directly), no custom error classes (use standard `Error`), no utility libraries, never store URLs in the DB (filenames only — N/A here, no files), never alias a single `fs` import for both sync and async (`import fs from 'fs'` and `import fsPromises from 'fs/promises'` as separate names where both are needed).
- AGENTS.md REQUIRED list applies to every task: flat procedural logic over deep nesting; direct SQL over an ORM; direct Zod validation over DTOs; `try/catch` around every filesystem operation, with `console.error` logging; `fs.mkdir(dir, { recursive: true })` before every file write (N/A — this feature writes no files); `path.join(getProjectRoot(), ...)` for all physical paths (N/A — no physical paths); check `signal?.aborted` immediately in async generators (N/A — no generators here); disable UI buttons on submission to prevent double-click; extract a shared helper for safety-critical logic on sight — this is exactly why `getCurrentUser()` is one shared helper (Task 4) rather than copy-pasted per route.
- **Cookies:** every Route Handler and `proxy.ts` reads the session via `request.cookies.get('session')?.value` and sets/clears it via `NextResponse`'s `.cookies.set(...)` — never `next/headers`'s `cookies()`. This codebase's existing route tests (e.g. `test/fromCrop.test.ts`) construct a raw `NextRequest` and call the exported route function directly, bypassing Next's real server dispatch; `next/headers`'s `cookies()` depends on request-scoped context that only exists during real dispatch, so it does not work reliably in that test pattern. `NextRequest`/`NextResponse`'s built-in `.cookies` accessor has no such dependency.
- **Service-layer signatures do not change.** `StyleService.create/update/fork`, `AssetService.create`, `JobService.create` all keep their existing `createdBy`/`requestingUserId`/`newOwnerId` parameter names and types. Only the ROUTE layer's *source* of that value changes, from `await req.json()` to `getCurrentUser(req)`.
- **Cookie options, exact values, every place a session cookie is set:** `{ httpOnly: true, secure: false, sameSite: 'lax', maxAge: 60 * 60 * 24 * 90, path: '/' }`. `secure: false` is deliberate (see spec) — this app is never served over HTTPS, and `secure: true` would silently break every login by preventing the cookie from ever being sent back over plain HTTP.
- **No new npm dependencies.** `crypto` (Node builtin, already used elsewhere in this codebase — e.g. `app/api/assets/from-crop/route.ts:5`) covers both `crypto.randomUUID()` (ids) and `crypto.randomBytes(32).toString('hex')` (session tokens).
- **Sequencing note, not a bug:** Tasks 12-15 change 6 API routes and 6 client pages to require a session cookie instead of a `createdBy`/`requestingUserId` body field. The 14 existing test files that construct requests with that body field (listed in Task 17) will fail from the moment Task 12 lands until Task 17 completes — this is expected, interdependent-task breakage within one plan, not a regression to chase down mid-plan. Each of Tasks 12-15 is still reviewed and merged on its own commit; the full suite is only required to be green again after Task 17. Do not "fix" this by reordering — the tests must change after the routes, since they're asserting on the new contract.

---

### Task 1: `users`/`sessions` tables + `UserSchema`

**Files:**
- Create: `lib/database/migrations/011_add_users_and_sessions.sql`
- Modify: `lib/database/schema.ts` (append after `JobSchema`/`export type Job`, i.e. after the current final line, line 67)
- Test: `test/userSchema.test.ts`

**Interfaces:**
- Produces: `UserSchema` (Zod) and `type User = z.infer<typeof UserSchema>`, exported from `lib/database/schema.ts`. Fields: `id: string` (uuid), `name: string` (min 1), `is_admin: 0 | 1`, `created_at: number` (int). Every later task that touches a user row uses this exact shape.
- Produces: the `users` table (`id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `is_admin INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER NOT NULL`) and `sessions` table (`token TEXT PRIMARY KEY`, `user_id TEXT NOT NULL REFERENCES users(id)`, `expires_at INTEGER NOT NULL`, `created_at INTEGER NOT NULL`). `name` was originally specified `UNIQUE`; the final whole-branch review found this could permanently break git sync (two machines independently creating a same-named first account), so the constraint was dropped before merge — see the fix-round commit and the ledger.

- [ ] **Step 1: Write the migration file**

```sql
-- lib/database/migrations/011_add_users_and_sessions.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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

No `foreign_keys` handling is needed here (unlike migration 010) — this creates two brand-new tables with no `DROP TABLE` involved, so there's no implicit-delete FK hazard.

- [ ] **Step 2: Add `UserSchema` to `lib/database/schema.ts`**

Append at the end of the file (after the existing `export type Job = z.infer<typeof JobSchema>;` on line 66):

```ts

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  is_admin: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;
```

- [ ] **Step 3: Write a failing test proving the migration runs and the schema parses a real row**

```ts
// test/userSchema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { UserSchema } from '@/lib/database/schema';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-userschema-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('users/sessions tables', () => {
  it('creates a user row and parses it with UserSchema', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run('11111111-1111-1111-1111-111111111111', 'Alice', 1, Date.now());
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('11111111-1111-1111-1111-111111111111');
    expect(() => UserSchema.parse(row)).not.toThrow();
  });

  // Superseded by the final whole-branch review: `name` is deliberately NOT
  // unique (a cross-machine name collision must not abort git sync) — see
  // test/userSchema.test.ts's actual "allows duplicate names" test for the
  // shipped behavior.

  it('creates a session row referencing a user', () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run('11111111-1111-1111-1111-111111111111', 'Alice', 1, Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('sometoken', '11111111-1111-1111-1111-111111111111', Date.now() + 1000, Date.now());
    const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get('sometoken');
    expect(row).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the test to confirm it fails before the migration exists**

Run: `npx vitest run test/userSchema.test.ts`
Expected: FAIL — `no such table: users`

- [ ] **Step 5: Create the migration file and schema addition from Steps 1-2, then re-run**

Run: `npx vitest run test/userSchema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: all existing tests still pass, plus these 3 new ones (332 total)

- [ ] **Step 7: Commit**

```bash
git add lib/database/migrations/011_add_users_and_sessions.sql lib/database/schema.ts test/userSchema.test.ts
git commit -m "feat: add users and sessions tables"
```

---

### Task 2: `UserService`

**Files:**
- Create: `lib/services/UserService.ts`
- Test: `test/userService.test.ts`

**Interfaces:**
- Consumes: `UserSchema`, `type User` from Task 1.
- Produces: `userService` singleton with `getAll(): Promise<User[]>`, `getActiveUsers(): Promise<User[]>` (identical to `getAll()` for now — no soft-delete concept for users, exists so call sites read intent the same way `StyleService.getActiveStyles()` does), `getById(id: string): Promise<User | null>`, `getByName(name: string): Promise<User | null>`, `create(input: { name: string }): Promise<User>`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/userService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-userservice-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('userService.create', () => {
  it('makes the first-ever user an admin', async () => {
    const alice = await userService.create({ name: 'Alice' });
    expect(alice.is_admin).toBe(1);
  });

  it('does not make the second user an admin', async () => {
    await userService.create({ name: 'Alice' });
    const bob = await userService.create({ name: 'Bob' });
    expect(bob.is_admin).toBe(0);
  });

  // Superseded by the final whole-branch review: duplicate names are
  // deliberately allowed now — see test/userService.test.ts's actual test
  // proving two same-named users can both be created successfully.
});

describe('userService reads', () => {
  it('getAll returns every user, getById/getByName find one', async () => {
    const alice = await userService.create({ name: 'Alice' });
    await userService.create({ name: 'Bob' });

    expect((await userService.getAll()).length).toBe(2);
    expect((await userService.getActiveUsers()).length).toBe(2);
    expect((await userService.getById(alice.id))?.name).toBe('Alice');
    expect((await userService.getByName('Bob'))?.name).toBe('Bob');
    expect(await userService.getById('nonexistent-id')).toBeNull();
    expect(await userService.getByName('Nobody')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/userService.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/UserService'`

- [ ] **Step 3: Implement `UserService.ts`**

Mirror `lib/services/StyleService.ts`'s exact class-singleton shape:

```ts
// lib/services/UserService.ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { UserSchema, type User } from '@/lib/database/schema';

class UserServiceImpl {
  async getAll(): Promise<User[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
    return rows.map(row => UserSchema.parse(row));
  }

  /** No soft-delete concept for users (unlike styles/assets) — this exists
   *  so call sites can express "the users I'd show someone" without
   *  assuming getAll()'s ordering/shape is stable long-term. */
  async getActiveUsers(): Promise<User[]> {
    return this.getAll();
  }

  async getById(id: string): Promise<User | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? UserSchema.parse(row) : null;
  }

  async getByName(name: string): Promise<User | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    return row ? UserSchema.parse(row) : null;
  }

  /** The first user ever created (globally, via the synced `users` table —
   *  see the spec's "First-run and the git-sync race" section for why this
   *  check alone is not sufficient at the route layer) becomes admin. */
  async create(input: { name: string }): Promise<User> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    const existingCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
    const isAdmin = existingCount === 0 ? 1 : 0;
    db.prepare('INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name, isAdmin, now);
    return (await this.getById(id))!;
  }
}

export const userService = new UserServiceImpl();
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/userService.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/UserService.ts test/userService.test.ts
git commit -m "feat: add UserService"
```

---

### Task 3: `SessionService`

**Files:**
- Create: `lib/services/SessionService.ts`
- Test: `test/sessionService.test.ts`

**Interfaces:**
- Consumes: `userService` from Task 2 (to seed a user to attach sessions to in tests).
- Produces: `sessionService` singleton with `create(userId: string): Promise<{ token: string; expiresAt: number }>`, `getUserByToken(token: string): Promise<User | null>`, `destroy(token: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/sessionService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-sessionservice-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('sessionService', () => {
  it('creates a session and resolves it back to the right user', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    const resolved = await sessionService.getUserByToken(token);
    expect(resolved?.id).toBe(alice.id);
  });

  it('returns null for an unknown token', async () => {
    expect(await sessionService.getUserByToken('not-a-real-token')).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const db = DatabaseConnection.getInstance();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('expired-token', alice.id, Date.now() - 1000, Date.now() - 2000);
    expect(await sessionService.getUserByToken('expired-token')).toBeNull();
  });

  it('destroy() removes the session so it no longer resolves', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    await sessionService.destroy(token);
    expect(await sessionService.getUserByToken(token)).toBeNull();
  });

  it('produces a token with real entropy, not a predictable value', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const a = await sessionService.create(alice.id);
    const b = await sessionService.create(alice.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(64); // 32 bytes hex-encoded
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/sessionService.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/SessionService'`

- [ ] **Step 3: Implement `SessionService.ts`**

```ts
// lib/services/SessionService.ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { UserSchema, type User } from '@/lib/database/schema';

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

class SessionServiceImpl {
  async create(userId: string): Promise<{ token: string; expiresAt: number }> {
    const db = DatabaseConnection.getInstance();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + SESSION_LIFETIME_MS;
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, expiresAt, now);
    return { token, expiresAt };
  }

  async getUserByToken(token: string): Promise<User | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare(`
      SELECT users.* FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `).get(token, Date.now());
    return row ? UserSchema.parse(row) : null;
  }

  async destroy(token: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
}

export const sessionService = new SessionServiceImpl();
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/sessionService.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/SessionService.ts test/sessionService.test.ts
git commit -m "feat: add SessionService"
```

---

### Task 4: `getCurrentUser()` shared helper

**Files:**
- Create: `lib/utils/session.ts`
- Test: `test/getCurrentUser.test.ts`

**Interfaces:**
- Consumes: `sessionService.getUserByToken` from Task 3.
- Produces: `getCurrentUser(req: NextRequest): Promise<User | null>`, imported by every route touched in Tasks 6-8 and 12-13.

- [ ] **Step 1: Write the failing tests**

```ts
// test/getCurrentUser.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { getCurrentUser } from '@/lib/utils/session';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-getcurrentuser-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('getCurrentUser', () => {
  it('returns the user for a valid session cookie', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    const req = new NextRequest('http://localhost/x', { headers: { Cookie: `session=${token}` } });
    const user = await getCurrentUser(req);
    expect(user?.id).toBe(alice.id);
  });

  it('returns null when there is no session cookie at all', async () => {
    const req = new NextRequest('http://localhost/x');
    expect(await getCurrentUser(req)).toBeNull();
  });

  it('returns null for a session cookie that does not match any session', async () => {
    const req = new NextRequest('http://localhost/x', { headers: { Cookie: 'session=bogus' } });
    expect(await getCurrentUser(req)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/getCurrentUser.test.ts`
Expected: FAIL — `Cannot find module '@/lib/utils/session'`

- [ ] **Step 3: Implement `lib/utils/session.ts`**

```ts
// lib/utils/session.ts
import type { NextRequest } from 'next/server';
import { sessionService } from '@/lib/services/SessionService';
import type { User } from '@/lib/database/schema';

// Reads request.cookies (NextRequest's own header-backed accessor), never
// next/headers's cookies() — see this plan's Global Constraints for why:
// this codebase's route tests construct a raw NextRequest and call the
// route function directly, without the request-scoped context next/headers
// depends on.
export async function getCurrentUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get('session')?.value;
  if (!token) return null;
  return sessionService.getUserByToken(token);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/getCurrentUser.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/utils/session.ts test/getCurrentUser.test.ts
git commit -m "feat: add getCurrentUser session helper"
```

---

### Task 5: Git-sync `users` (not `sessions`)

**Files:**
- Modify: `lib/services/GitService.ts`
- Test: `test/gitServiceUsers.test.ts`

**Interfaces:**
- Consumes: `userService` (Task 2), `UserSchema` (Task 1).
- Produces: `data/users/user-<id>.json` files, round-tripped through `exportToJson()`/`importFromJson()` the same as styles/assets. `sessions` is never touched by either function.

Read the current exact file first — it may have shifted since the spec was written. As of this plan, the relevant lines are:

- Line 11: `import { StyleSchema, AssetSchema } from '@/lib/database/schema';`
- Line 22: `const DATA_DIRS = ['data/styles', 'data/assets'] as const;`
- `exportToJson()`: lines 38-56
- `importFromJson()`: lines 58-110

- [ ] **Step 1: Write the failing test**

```ts
// test/gitServiceUsers.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { gitService } from '@/lib/services/GitService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gitusers-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GitService users sync', () => {
  it('exportToJson() writes one JSON file per user under data/users/', async () => {
    const alice = await userService.create({ name: 'Alice' });
    await gitService.exportToJson();
    const filePath = path.join(tempRoot, 'data', 'users', `user-${alice.id}.json`);
    const content = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
    expect(content.name).toBe('Alice');
    expect(content.is_admin).toBe(1);
  });

  it('importFromJson() brings an exported user into a fresh database', async () => {
    const alice = await userService.create({ name: 'Alice' });
    await gitService.exportToJson();

    // Simulate a second machine: fresh DB, same exported data/ directory.
    DatabaseConnection.resetForTests();
    await gitService.importFromJson();

    const imported = await userService.getById(alice.id);
    expect(imported?.name).toBe('Alice');
    expect(imported?.is_admin).toBe(1);
  });

  it('does not export a sessions table into data/', async () => {
    await userService.create({ name: 'Alice' });
    await gitService.exportToJson();
    const dataDir = path.join(tempRoot, 'data');
    const entries = await fsPromises.readdir(dataDir);
    expect(entries).not.toContain('sessions');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/gitServiceUsers.test.ts`
Expected: FAIL — `data/users/user-<id>.json` is never written (ENOENT)

- [ ] **Step 3: Modify `GitService.ts`**

Change line 11:

```ts
import { StyleSchema, AssetSchema, UserSchema } from '@/lib/database/schema';
```

Add the userService import right after the existing `styleService` import (currently line 8):

```ts
import { userService } from '@/lib/services/UserService';
```

Change line 22:

```ts
const DATA_DIRS = ['data/styles', 'data/assets', 'data/users'] as const;
```

In `ensureDirectoriesExist()` (currently lines 29-36), the existing `for (const dir of DATA_DIRS)` loop already creates every directory in `DATA_DIRS` via `mkdir(..., { recursive: true })` — no change needed there; adding `'data/users'` to `DATA_DIRS` is sufficient.

In `exportToJson()` (currently lines 38-56), add a users loop. Insert it before the closing brace, after the existing assets loop:

```ts
  async exportToJson(): Promise<void> {
    await this.ensureDirectoriesExist();

    const styles = await styleService.getAll();
    const assets = await assetService.getAll();
    const users = await userService.getAll();

    const stylesDir = path.join(getProjectRoot(), 'data', 'styles');
    const assetsDir = path.join(getProjectRoot(), 'data', 'assets');
    const usersDir = path.join(getProjectRoot(), 'data', 'users');

    for (const style of styles) {
      const filePath = path.join(stylesDir, `style-${style.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(style, null, 2), 'utf-8');
    }

    for (const asset of assets) {
      const filePath = path.join(assetsDir, `asset-${asset.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(asset, null, 2), 'utf-8');
    }

    for (const user of users) {
      const filePath = path.join(usersDir, `user-${user.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(user, null, 2), 'utf-8');
    }
  }
```

In `importFromJson()` (currently lines 58-110), add a users loop. Insert it at the START, before the existing styles loop, so identities exist in the DB before anything that names them as a creator gets imported (no enforced FK requires this ordering — `created_by` is a plain string column — but it's the logical order and costs nothing):

```ts
  async importFromJson(): Promise<void> {
    const db = DatabaseConnection.getInstance();

    const usersDir = path.join(getProjectRoot(), 'data', 'users');
    const userFiles = await this.readJsonFiles(usersDir);
    for (const { filePath, content } of userFiles) {
      if (CONFLICT_MARKER_REGEX.test(content)) {
        throw new Error(`Conflict markers found in ${filePath}. Please resolve manually.`);
      }
      const data = UserSchema.parse(JSON.parse(content));
      db.prepare(`
        INSERT INTO users (id, name, is_admin, created_at)
        VALUES (@id, @name, @is_admin, @created_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          is_admin = excluded.is_admin,
          created_at = excluded.created_at
      `).run(data);
    }

    const stylesDir = path.join(getProjectRoot(), 'data', 'styles');
    // ... existing styles loop, unchanged ...
```

(The rest of `importFromJson()` — the existing styles and assets loops — stays exactly as it is today; only the new users loop is prepended.)

`stageFilesForCommit()` needs no change: its `git.add('data/')` call already stages everything under `data/`, `data/users/` included, once that directory exists.

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/gitServiceUsers.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite (existing GitService tests must still pass unchanged)**

Run: `npx vitest run`
Expected: all passing, including `test/gitServiceThemes.test.ts` and `test/push.test.ts`

- [ ] **Step 6: Commit**

```bash
git add lib/services/GitService.ts test/gitServiceUsers.test.ts
git commit -m "feat: sync users table via git export/import"
```

---

### Task 6: `POST /api/auth/login`

**Files:**
- Create: `app/api/auth/login/route.ts`
- Test: `test/authLoginRoute.test.ts`

**Interfaces:**
- Consumes: `userService` (Task 2), `sessionService` (Task 3).
- Produces: `POST /api/auth/login` — body `{ userId: string }` (existing-user login) or `{ name: string }` (create-first-account, server-enforced to only work when `userService.getAll()` is currently empty). On success: sets the `session` cookie, returns `{ success: true, data: { id, name, isAdmin } }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/authLoginRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { POST } from '@/app/api/auth/login/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-authlogin-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/login', () => {
  it('creates the first account and marks it admin when no users exist yet', async () => {
    const res = await POST(postRequest({ name: 'Alice' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.isAdmin).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  it('rejects the name/create path once a user already exists', async () => {
    await userService.create({ name: 'Alice' });
    const res = await POST(postRequest({ name: 'Bob' }));
    expect(res.status).toBe(403);
  });

  it('logs an existing user in by userId', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const res = await POST(postRequest({ userId: alice.id }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.id).toBe(alice.id);
    expect(res.headers.get('set-cookie')).toContain('session=');
  });

  it('returns 404 for an unknown userId', async () => {
    const res = await POST(postRequest({ userId: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed body', async () => {
    const res = await POST(postRequest({ nonsense: true }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/authLoginRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/auth/login/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';

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
    res.cookies.set('session', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
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

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/authLoginRoute.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/login/route.ts test/authLoginRoute.test.ts
git commit -m "feat: add POST /api/auth/login"
```

---

### Task 7: `POST /api/auth/logout`

**Files:**
- Create: `app/api/auth/logout/route.ts`
- Test: `test/authLogoutRoute.test.ts`

**Interfaces:**
- Consumes: `sessionService.destroy` (Task 3).
- Produces: `POST /api/auth/logout` — clears the session cookie and deletes the server-side session row.

- [ ] **Step 1: Write the failing tests**

```ts
// test/authLogoutRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { POST } from '@/app/api/auth/logout/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-authlogout-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('POST /api/auth/logout', () => {
  it('destroys the session so the cookie no longer resolves to a user', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);

    const req = new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${token}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await sessionService.getUserByToken(token)).toBeNull();
  });

  it('succeeds even with no session cookie present', async () => {
    const req = new NextRequest('http://localhost/api/auth/logout', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/authLogoutRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/auth/logout/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/auth/logout/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sessionService } from '@/lib/services/SessionService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get('session')?.value;
    if (token) await sessionService.destroy(token);

    const res = NextResponse.json({ success: true });
    res.cookies.set('session', '', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return res;
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/authLogoutRoute.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/logout/route.ts test/authLogoutRoute.test.ts
git commit -m "feat: add POST /api/auth/logout"
```

---

### Task 8: `GET /api/auth/me`

**Files:**
- Create: `app/api/auth/me/route.ts`
- Test: `test/authMeRoute.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (Task 4).
- Produces: `GET /api/auth/me` — `{ success: true, data: { id, name, isAdmin } | null }`. Always 200; `data: null` means logged out (deliberately not a 401 — this route exists purely so client UI can conditionally render, not as an access gate).

- [ ] **Step 1: Write the failing tests**

```ts
// test/authMeRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { GET } from '@/app/api/auth/me/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-authme-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/auth/me', () => {
  it('returns the logged-in user', async () => {
    const alice = await userService.create({ name: 'Alice' });
    const { token } = await sessionService.create(alice.id);
    const req = new NextRequest('http://localhost/api/auth/me', { headers: { Cookie: `session=${token}` } });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Alice');
  });

  it('returns null data when logged out', async () => {
    const req = new NextRequest('http://localhost/api/auth/me');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/authMeRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/auth/me/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/auth/me/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: true, data: null });
  }
  return NextResponse.json({
    success: true,
    data: { id: user.id, name: user.name, isAdmin: !!user.is_admin },
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/authMeRoute.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/me/route.ts test/authMeRoute.test.ts
git commit -m "feat: add GET /api/auth/me"
```

---

### Task 9: `/login` page (picker + first-run Pull-first flow)

**Files:**
- Create: `app/login/page.tsx` (Server Component)
- Create: `app/login/LoginForm.tsx` (Client Component)
- Manual/browser test only (no automated test — this task is a page composed of already-tested routes; see Step 4)

**Interfaces:**
- Consumes: `userService.getActiveUsers()` (Task 2, called directly since this is a Server Component), `POST /api/auth/login` (Task 6), `POST /api/git/pull` (existing, `app/api/git/pull/route.ts`).

- [ ] **Step 1: Implement the Server Component page**

```tsx
// app/login/page.tsx
import { userService } from '@/lib/services/UserService';
import { LoginForm } from './LoginForm';

export default async function LoginPage() {
  const users = await userService.getActiveUsers();
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1 className="page-title">Who are you?</h1>
      <LoginForm users={users.map(u => ({ id: u.id, name: u.name }))} />
    </div>
  );
}
```

- [ ] **Step 2: Implement the client form**

```tsx
// app/login/LoginForm.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface UserOption {
  id: string;
  name: string;
}

export function LoginForm({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setPullError(body.message ?? 'Pull failed — no git remote configured yet?');
        return;
      }
      setPulled(true);
      router.refresh();
    } finally {
      setPulling(false);
    }
  }

  async function handleCreateFirst(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
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

  return (
    <div>
      <p className="page-subtitle">No accounts found on this machine yet.</p>
      <button className="btn" onClick={handlePull} disabled={pulling} style={{ marginBottom: 16 }}>
        {pulling ? 'Pulling…' : 'Pull from git first'}
      </button>
      {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{pullError} You can still create the first account below.</p>}
      {pulled && <p style={{ fontSize: 13, marginBottom: 16 }}>Pull finished — refreshing…</p>}

      <p className="page-subtitle">This is a brand new project — create the first account (this makes you the admin):</p>
      <form onSubmit={handleCreateFirst} style={{ display: 'flex', gap: 8 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Your name" />
        <button className="btn btn-primary" type="submit" disabled={submitting || !newName.trim()}>
          Create
        </button>
      </form>
      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Run the full suite (this task adds no new automated tests, but must not break existing ones)**

Run: `npx vitest run`
Expected: all passing

- [ ] **Step 4: Manual verification via dev server**

Run `npm run dev`, visit `http://localhost:3000/login` with an empty database. Confirm: the empty-state Pull/create-first-account UI renders; clicking Create with a name logs you in and redirects to `/dashboard/generate`; reloading `/login` after that now shows the picker with your name as a button.

- [ ] **Step 5: Commit**

```bash
git add app/login/page.tsx app/login/LoginForm.tsx
git commit -m "feat: add /login page"
```

---

### Task 10: `proxy.ts` — optimistic redirect to `/login`

**Files:**
- Create: `proxy.ts` (project root, next to `package.json` — NOT `middleware.ts`, which Next.js 16.0.0 deprecated and renamed; confirmed against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`)
- Test: `test/proxyAuth.test.ts`

**Interfaces:**
- Produces: a page-level redirect to `/login` when the `session` cookie is entirely absent. Does NOT validate the token (optimistic check only, per Next's own guidance on Proxy performance — the real check is `getCurrentUser` inside each route/page). Excludes `/login`, `/api/*`, and Next's internal static/image paths from the matcher.

- [ ] **Step 1: Write the failing test**

Next.js 15.1+ ships `unstable_doesProxyMatch` for testing a proxy's matcher without running the dev server. Use it to test the matcher logic directly:

```ts
// test/proxyAuth.test.ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

describe('proxy.ts auth redirect', () => {
  it('redirects to /login when there is no session cookie', async () => {
    const req = new NextRequest('http://localhost/dashboard/generate');
    const res = proxy(req);
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toContain('/login');
  });

  it('does not redirect when a session cookie is present (even an invalid one — optimistic check only)', async () => {
    const req = new NextRequest('http://localhost/dashboard/generate', {
      headers: { Cookie: 'session=whatever' },
    });
    const res = proxy(req);
    expect(res).toBeUndefined();
  });

  it('matcher excludes /login, /api, and Next internals', () => {
    expect(config.matcher).toEqual(['/((?!login|api|_next/static|_next/image|favicon.ico).*)']);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/proxyAuth.test.ts`
Expected: FAIL — `Cannot find module '@/proxy'`

- [ ] **Step 3: Implement `proxy.ts`**

```ts
// proxy.ts
import { NextResponse, type NextRequest } from 'next/server';

// Optimistic check ONLY — presence of a session cookie, not validity. Proxy
// runs on every request including prefetches; a DB-backed check belongs at
// the route/page layer (getCurrentUser), not here. See the design spec's
// "Proxy-level redirect" section.
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

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/proxyAuth.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add proxy.ts test/proxyAuth.test.ts
git commit -m "feat: redirect unauthenticated page visits to /login"
```

---

### Task 11: "Logged in as X" + logout, wired into `NavRail`

**Files:**
- Modify: `app/components/NavRail.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/me` (Task 8), `POST /api/auth/logout` (Task 7).

`NavRail.tsx` is the one persistent shell component (`app/layout.tsx` has no nested dashboard layout — `NavRail` renders on every page, `/login` included, since Next.js's root layout wraps everything).

- [ ] **Step 1: Modify `NavRail.tsx`**

```tsx
// app/components/NavRail.tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const LINKS = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/themes', label: 'Themes' },
  { href: '/dashboard/components', label: 'Components' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
];

export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<{ name: string; isAdmin: boolean } | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        const body = await res.json();
        if (!ignore && body.success) setMe(body.data);
      } catch {
        // Purely informational — a failed fetch just means no identity shows.
      }
    })();
    return () => { ignore = true; };
  }, [pathname]);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <nav className="rail">
      <div className="rail-brand">
        Game<span>Forge</span>
      </div>
      {LINKS.map(link => (
        <Link
          key={link.href}
          href={link.href}
          className="rail-link"
          data-active={pathname.startsWith(link.href) ? 'true' : 'false'}
        >
          {link.label}
        </Link>
      ))}
      {me && (
        <div style={{ marginTop: 'auto', paddingTop: 16, fontSize: 13 }}>
          <div>Logged in as {me.name}{me.isAdmin ? ' (admin)' : ''}</div>
          <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </nav>
  );
}
```

(The `pathname` dependency on the `useEffect` re-fetches identity on navigation — cheap, and means a fresh login on `/login` immediately reflects in the rail on redirect without a hard reload being required for correctness, only for polish.)

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: all passing (this component has no dedicated unit test — it's a thin fetch + render, matches the existing codebase's convention of not unit-testing purely presentational client components like `JobCard`/`AssetCard`)

- [ ] **Step 3: Manual verification via dev server**

`npm run dev`, log in, confirm "Logged in as {name}" + Log out button appear in the rail; click Log out, confirm redirect to `/login`.

- [ ] **Step 4: Commit**

```bash
git add app/components/NavRail.tsx
git commit -m "feat: show logged-in identity and logout in the nav rail"
```

---

### Task 12: Migrate 5 API routes to `getCurrentUser` (simple cases)

**Files:**
- Modify: `app/api/assets/route.ts`
- Modify: `app/api/assets/from-crop/route.ts`
- Modify: `app/api/styles/route.ts`
- Modify: `app/api/styles/[id]/fork/route.ts`
- Modify: `app/api/generate/route.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (Task 4).
- Produces: no change to any exported function signature — same `POST(req)` shape, same success/error response shape. The only behavior change: a request with no valid session now gets 401 instead of trusting a body field.

These 5 routes share one shape of change: remove the client-submitted identity field from the Zod body schema, call `getCurrentUser(req)`, 401 if `null`, use `user.id` wherever the removed field used to be read.

- [ ] **Step 1: `app/api/assets/route.ts`**

Replace lines 1-3 (imports) and lines 33-52 (schema + POST body):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { getCurrentUser } from '@/lib/utils/session';
```

```ts
const CreateAssetSchema = z.object({
  styleId: z.string().uuid(),
  assetType: z.string().min(1),
  prompt: z.string().min(1),
  imagePath: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json();
    const input = CreateAssetSchema.parse(body);

    const asset = await assetService.create({
      styleId: input.styleId,
      createdBy: user.id,
      assetType: input.assetType,
      prompt: input.prompt,
      imagePath: input.imagePath ?? null,
    });

    return NextResponse.json({ success: true, data: asset });
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

(`GET` is unchanged — reads need no identity.)

- [ ] **Step 2: `app/api/assets/from-crop/route.ts`**

Add the import and swap `createdBy` for the session lookup:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const FromCropSchema = z.object({
  styleId: z.string().uuid(),
  jobId: z.string().uuid(),
  label: z.string().min(1),
  imageDataUrl: z.string().startsWith('data:image/'),
});

function decodeDataUrl(dataUrl: string): { bytes: Buffer; extension: string } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) throw new Error('Malformed image data URL');
  const [, format, base64] = match;
  return { bytes: Buffer.from(base64, 'base64'), extension: format === 'jpeg' ? 'jpg' : format };
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = FromCropSchema.parse(await req.json());
    const { bytes, extension } = decodeDataUrl(input.imageDataUrl);

    const filename = `split-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    try {
      await fsPromises.mkdir(imagesDir, { recursive: true });
      await fsPromises.writeFile(path.join(imagesDir, filename), bytes);
    } catch (e) {
      console.error(`Failed to write split element image ${filename}:`, e);
      throw e;
    }

    const asset = await assetService.create({
      styleId: input.styleId,
      createdBy: user.id,
      assetType: 'ui_element',
      prompt: input.label,
      imagePath: filename,
      sourceJobId: input.jobId,
    });

    return NextResponse.json({ success: true, data: asset });
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

- [ ] **Step 3: `app/api/styles/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { styleService } from '@/lib/services/StyleService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const styles = await styleService.getActiveStyles();
    return NextResponse.json({ success: true, data: styles });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

const CreateStyleSchema = z.object({
  name: z.string().min(1),
  parameters: z.string().default('{}'),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = CreateStyleSchema.parse(await req.json());
    const style = await styleService.create({ ...input, createdBy: user.id });
    return NextResponse.json({ success: true, data: style });
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

- [ ] **Step 4: `app/api/styles/[id]/fork/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { styleService } from '@/lib/services/StyleService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const result = await styleService.fork(id, user.id);
    if ('error' in result) {
      return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result });
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

(The `ForkSchema` Zod object is removed entirely — the route no longer parses a body at all, since `newOwnerId` was its only field.)

- [ ] **Step 5: `app/api/generate/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme', 'component']).optional(),
  candidateCount: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = GenerateSchema.parse(await req.json());

    if (input.outputKind === 'theme') {
      const pieces = (input.options as { pieces?: unknown } | undefined)?.pieces;
      if (Array.isArray(pieces) && pieces.length > 0) {
        return NextResponse.json({ success: false, error: 'Theme jobs cannot include UI-sheet options.' }, { status: 400 });
      }
    }

    if (input.outputKind === 'component' && input.candidateCount !== undefined && input.candidateCount !== 1) {
      return NextResponse.json({ success: false, error: 'Component jobs do not support multi-candidate generation.' }, { status: 400 });
    }

    const jobInput = { ...input, createdBy: user.id };

    const count = input.candidateCount ?? 1;
    if (count === 1) {
      const job = await jobService.create(jobInput);
      return NextResponse.json({ success: true, data: job });
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const job = await jobService.create(jobInput);
      DatabaseConnection.getInstance().prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchId, job.id);
      jobs.push({ ...job, batch_id: batchId });
    }
    return NextResponse.json({ success: true, data: jobs });
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

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: the existing tests for these 5 routes (parts of `test/fromCrop.test.ts` and others named in Task 17) now FAIL, because they still POST a `createdBy` body field and no session cookie — this is expected per this plan's Global Constraints sequencing note. Confirm the FAILURES are only in files Task 17 will touch, and that nothing else broke. Do not fix these tests now — Task 17 does that.

- [ ] **Step 7: Commit**

```bash
git add app/api/assets/route.ts app/api/assets/from-crop/route.ts app/api/styles/route.ts "app/api/styles/[id]/fork/route.ts" app/api/generate/route.ts
git commit -m "feat: require a real session for asset/style/generate creation"
```

---

### Task 13: Migrate `app/api/styles/[id]/route.ts` (ownership check + admin bypass)

**Files:**
- Modify: `app/api/styles/[id]/route.ts`
- Modify: `lib/services/StyleService.ts` (the `update` method's ownership check)

**Interfaces:**
- Consumes: `getCurrentUser` (Task 4).
- Produces: `StyleService.update(id, requestingUserId, patch, isAdmin)` — **note the added `isAdmin` parameter**, the one deliberate service-layer signature change in this whole plan (justified below). PUT/DELETE both become `existing.created_by !== user.id && !user.isAdmin`.

This is the one place the plan's own Global Constraint ("service-layer signatures do not change") gets a narrow, explicit exception: `StyleService.update()`'s ownership check needs to know about the admin bypass, and duplicating that check at the route layer (bypassing the service's own guard) would leave `StyleService.update()` itself still enforceable-bypassable by any future caller that isn't this route. Passing `isAdmin` through is more consistent with "only the creator can edit" being the service's own invariant, not the route's.

- [ ] **Step 1: Modify `StyleService.ts`'s `update` method**

Current (lines 36-56):

```ts
  /** Only the creator may edit a style. Everyone else must Fork. */
  async update(
    id: string,
    requestingUserId: string,
    patch: { name?: string; parameters?: string }
  ): Promise<Style | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId) return { error: 'FORBIDDEN' };
```

New:

```ts
  /** Only the creator, or an admin, may edit a style. Everyone else must Fork. */
  async update(
    id: string,
    requestingUserId: string,
    patch: { name?: string; parameters?: string },
    isAdmin: boolean = false
  ): Promise<Style | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };
```

(The rest of the method, and every other method in the file, is unchanged. `isAdmin` defaults to `false` so any other/future caller that doesn't pass it keeps today's exact behavior.)

- [ ] **Step 2: Modify `app/api/styles/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { styleService } from '@/lib/services/StyleService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const style = await styleService.getById(id);
    if (!style) return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: style });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Only the creator (or an admin) may edit — enforced server-side in StyleService.update().
const UpdateStyleSchema = z.object({
  name: z.string().min(1).optional(),
  parameters: z.string().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const patch = UpdateStyleSchema.parse(await req.json());
    const result = await styleService.update(id, user.id, patch, !!user.is_admin);

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: false,
        error: 'Only the creator can edit this style. Fork it to make your own changes.',
      }, { status: 403 });
    }

    return NextResponse.json({ success: true, data: result });
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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const existing = await styleService.getById(id);
    if (!existing) return NextResponse.json({ success: false, error: 'Style not found' }, { status: 404 });
    if (existing.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({
        success: false,
        error: 'Only the creator can delete this style.',
      }, { status: 403 });
    }

    await styleService.softDelete(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: existing tests for this route (whichever of the 14 files in Task 17 cover it) now fail for the same reason as Task 12 — expected, fixed in Task 17.

- [ ] **Step 4: Commit**

```bash
git add "app/api/styles/[id]/route.ts" lib/services/StyleService.ts
git commit -m "feat: enforce style ownership via session, with admin bypass"
```

---

### Task 14: Migrate the 6 client pages off `getClientId()`

**Files:**
- Modify: `app/dashboard/ui-sheets/page.tsx`
- Modify: `app/dashboard/themes/page.tsx`
- Modify: `app/dashboard/components/page.tsx`
- Modify: `app/dashboard/styles/page.tsx`
- Modify: `app/dashboard/generate/page.tsx`
- Modify: `app/dashboard/jobs/[id]/split/page.tsx`

**Interfaces:**
- Produces: no client-submitted identity in any request body anywhere in the app. Identity now comes entirely from the session cookie the browser sends automatically.

Each edit is the same shape: remove the `import { getClientId } from '@/lib/utils/clientId';` line, and remove the `createdBy: getClientId(),` (or `newOwnerId: getClientId(),`) line from the request body.

- [ ] **Step 1: `app/dashboard/ui-sheets/page.tsx`**

Remove line 6 (`import { getClientId } from '@/lib/utils/clientId';`) and line 59 (`createdBy: getClientId(),`) from the `body: JSON.stringify({...})` call at what is currently lines 57-67.

- [ ] **Step 2: `app/dashboard/themes/page.tsx`**

Remove line 7 (the `getClientId` import) and line 37 (`createdBy: getClientId(),`) from the body at lines 35-42.

- [ ] **Step 3: `app/dashboard/components/page.tsx`**

Remove line 7 (the `getClientId` import) and line 39 (`createdBy: getClientId(),`) from the body at lines 37-43.

- [ ] **Step 4: `app/dashboard/styles/page.tsx`**

Remove line 5 (the `getClientId` import). Remove `createdBy: getClientId()` from the `handleCreate` body (currently `body: JSON.stringify({ name: name.trim(), createdBy: getClientId() })` → `body: JSON.stringify({ name: name.trim() })`). Remove the entire `body` line from `handleFork` (currently `body: JSON.stringify({ newOwnerId: getClientId() })` on line 36) — the fork route no longer takes a body at all (Task 12, Step 4), so drop the `headers`/`body` object entirely, leaving just:

```ts
      await fetch(`/api/styles/${styleId}/fork`, { method: 'POST' });
```

- [ ] **Step 5: `app/dashboard/generate/page.tsx`**

Remove line 7 (the `getClientId` import) and line 37 (`createdBy: getClientId(),`) from the body at lines 35-40.

- [ ] **Step 6: `app/dashboard/jobs/[id]/split/page.tsx`**

Remove line 6 (the `getClientId` import) and line 131 (`createdBy: getClientId(),`) from the body at lines 129-135.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: no change from Task 13's end-state — these are client component files with no direct unit tests, so nothing here should newly pass or fail.

- [ ] **Step 8: Manual verification via dev server**

`npm run dev`, log in, exercise each of: creating a style, forking a style, generating a theme/component/UI-sheet/sprite job, splitting a UI sheet into elements. Confirm each still works end-to-end and the created row's `created_by` is your logged-in user id (spot-check via the styles/assets list showing your name once Task 18+ or a later polish pass displays names instead of raw ids — for this task, it's enough that the request succeeds with no body identity field and no 401).

- [ ] **Step 9: Commit**

```bash
git add app/dashboard/ui-sheets/page.tsx app/dashboard/themes/page.tsx app/dashboard/components/page.tsx app/dashboard/styles/page.tsx app/dashboard/generate/page.tsx "app/dashboard/jobs/[id]/split/page.tsx"
git commit -m "feat: stop sending client-generated identity in request bodies"
```

---

### Task 15: Delete `lib/utils/clientId.ts`

**Files:**
- Delete: `lib/utils/clientId.ts`

**Interfaces:**
- Consumes: nothing (this task only runs after Task 14 removes every import of it).

- [ ] **Step 1: Confirm zero remaining references**

Run: `grep -rn "getClientId\|utils/clientId" app lib test --include="*.ts" --include="*.tsx"`
Expected: no output. If anything appears, stop — Task 14 missed a call site; fix that call site the same way as Task 14's other edits before proceeding.

- [ ] **Step 2: Delete the file**

```bash
git rm lib/utils/clientId.ts
```

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: no change — nothing imports this file anymore.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove the anonymous client-id mechanism, superseded by real login"
```

---

### Task 16: Test helper — `test/helpers/testSession.ts`

**Files:**
- Create: `test/helpers/testSession.ts`

**Interfaces:**
- Consumes: `userService` (Task 2), `sessionService` (Task 3).
- Produces: `seedSession(name?: string): Promise<{ userId: string; cookieHeader: string }>` — creates one user (default name `'Test User'`) and one session for them, returning a ready-to-use `Cookie` header value. Used by every file in Task 17.

Read `test/dedupQueries.test.ts`'s exact temp-DB setup first (already the established pattern in this codebase — `setProjectRootForTests` + copying `lib/database/migrations/` into a temp dir + `DatabaseConnection.resetForTests()`); this helper assumes that setup has already run in the calling test file's own `beforeEach` — it does not duplicate that setup itself, since each test file already needs its own `tempRoot`/migrations copy regardless of whether it uses sessions.

- [ ] **Step 1: Implement the helper**

```ts
// test/helpers/testSession.ts
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';

export async function seedSession(name = 'Test User'): Promise<{ userId: string; cookieHeader: string }> {
  const user = await userService.create({ name });
  const { token } = await sessionService.create(user.id);
  return { userId: user.id, cookieHeader: `session=${token}` };
}
```

- [ ] **Step 2: Write a smoke test for the helper itself**

```ts
// test/helpers/testSession.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';
import { seedSession } from './testSession';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-testsessionhelper-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('seedSession test helper', () => {
  it('produces a cookie header that getCurrentUser resolves back to the seeded user', async () => {
    const { userId, cookieHeader } = await seedSession('Alice');
    const req = new NextRequest('http://localhost/x', { headers: { Cookie: cookieHeader } });
    const user = await getCurrentUser(req);
    expect(user?.id).toBe(userId);
    expect(user?.name).toBe('Alice');
  });
});
```

- [ ] **Step 3: Run to confirm it passes (this is a helper, not TDD-first — Tasks 2-4 it depends on are already implemented)**

Run: `npx vitest run test/helpers/testSession.test.ts`
Expected: PASS (1 test)

- [ ] **Step 4: Commit**

```bash
git add test/helpers/testSession.ts test/helpers/testSession.test.ts
git commit -m "test: add seedSession helper for route tests needing an authenticated request"
```

---

### Task 17: Migrate the 14 existing test files to use `seedSession`

**Files:**
- Modify: `test/componentFileRoute.test.ts`
- Modify: `test/outputKindWiring.test.ts`
- Modify: `test/multiCandidateGeneration.test.ts`
- Modify: `test/jobComponentResetRoute.test.ts`
- Modify: `test/jobComponentEditRoute.test.ts`
- Modify: `test/cleanupOrphanedThemes.test.ts`
- Modify: `test/jobThemeResetRoute.test.ts`
- Modify: `test/jobThemeEditRoute.test.ts`
- Modify: `test/themeGenerator.test.ts`
- Modify: `test/jobSimilarityRoute.test.ts`
- Modify: `test/dedupQueries.test.ts`
- Modify: `test/assetContrastRoute.test.ts`
- Modify: `test/assetExportRoute.test.ts`
- Modify: `test/fromCrop.test.ts`

**Interfaces:**
- Consumes: `seedSession` (Task 16).

**Before starting:** re-run the grep from the spec to confirm this list is still exact and find every remaining occurrence:

```bash
grep -rln "requestingUserId\|createdBy\|newOwnerId" test
```

For each match, decide which of two shapes it is:

**Shape A — the file calls a SERVICE method directly** (e.g. `styleService.create({ createdBy: 'user-1', ... })`, `jobService.create({ createdBy: 'user-1', ... })`). **No change needed** — service-layer signatures didn't change (this plan's Global Constraints). Leave these exactly as they are.

**Shape B — the file constructs a route request with the identity as a JSON body field** (e.g. `test/fromCrop.test.ts:57-61`'s `postRequest({ styleId, createdBy: 'user-1', jobId, label })`, calling the exported route handler directly). These need the field removed from the body and a `Cookie` header added instead, sourced from `seedSession()`.

Concretely, for `test/fromCrop.test.ts` (representative of the pattern every Shape-B file follows):

- [ ] **Step 1: Read the current exact content of `test/fromCrop.test.ts`**

- [ ] **Step 2: Add the import and a per-test session**

```ts
import { seedSession } from './helpers/testSession';
```

Wherever the file's `beforeEach` sets up the temp DB (matching the pattern already used throughout this codebase), add one line seeding a session for that test run:

```ts
let cookieHeader: string;

beforeEach(async () => {
  // ... existing tempRoot/migrations/setProjectRootForTests/resetForTests setup ...
  ({ cookieHeader } = await seedSession());
});
```

- [ ] **Step 3: Update the `postRequest` helper (or wherever the request is built) to send the cookie and drop `createdBy` from the body**

Before:

```ts
function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/assets/from-crop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

After:

```ts
function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/assets/from-crop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}
```

Then remove `createdBy: 'user-1',` from every call site in the file that builds a request body with it (e.g. lines 57-61 and 77-81 as they existed before this plan's other tasks landed — re-verify exact current line numbers when doing this step, since Task 12 did not touch this test file, only the route it tests).

- [ ] **Step 4: Repeat Steps 1-3's pattern for the other 13 files**, adjusting only the route path/body shape per file — the transformation (add `seedSession()` in `beforeEach`, add `Cookie: cookieHeader` to the request headers, remove the identity field from the body) is identical. For a file testing a route that takes NO identity in its body at all (double check — some of the 14 may only reference `createdBy` via a Shape-A service call and need no route-level change), skip it per the Shape A/B distinction in this task's preamble.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: **all tests pass** — this is the task that restores the full-green suite after Tasks 12-14's expected interim breakage.

- [ ] **Step 6: Commit**

```bash
git add test/
git commit -m "test: migrate route tests to authenticated sessions instead of a body-supplied identity"
```

---

### Task 18: New tests — ownership admin-bypass + Pull-before-first-account race

**Files:**
- Create: `test/styleOwnershipAdminBypass.test.ts`
- Create: `test/loginPullRace.test.ts`

**Interfaces:**
- Consumes: `styleService` (existing), `getCurrentUser`/route handlers (Tasks 4, 6, 13), `gitService.importFromJson` (Task 5).

- [ ] **Step 1: Write the admin-bypass test**

```ts
// test/styleOwnershipAdminBypass.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { PUT, DELETE } from '@/app/api/styles/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-adminbypass-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function putRequest(body: unknown, cookieHeader: string) {
  return new NextRequest('http://localhost/api/styles/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('style ownership: admin bypass', () => {
  it('lets a non-owner admin edit someone else\'s style', async () => {
    const admin = await userService.create({ name: 'Admin' }); // first user created = admin
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);

    const style = await styleService.create({ name: 'Their Style', createdBy: other.id, parameters: '{}' });

    const res = await PUT(putRequest({ name: 'Renamed by admin' }, `session=${token}`), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed by admin');
  });

  it('still blocks a non-owner, non-admin user', async () => {
    await userService.create({ name: 'Admin' }); // first user = admin, not relevant here
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);

    const style = await styleService.create({ name: 'Owned', createdBy: owner.id, parameters: '{}' });

    const res = await PUT(putRequest({ name: 'Should fail' }, `session=${token}`), { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(403);
  });

  it('lets the admin delete someone else\'s style', async () => {
    const admin = await userService.create({ name: 'Admin' });
    const other = await userService.create({ name: 'Other' });
    const { token } = await sessionService.create(admin.id);
    const style = await styleService.create({ name: 'Deletable', createdBy: other.id, parameters: '{}' });

    const req = new NextRequest('http://localhost/api/styles/x', { method: 'DELETE', headers: { Cookie: `session=${token}` } });
    const res = await DELETE(req, { params: Promise.resolve({ id: style.id }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Write the Pull-before-first-account race test**

```ts
// test/loginPullRace.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { userService } from '@/lib/services/UserService';
import { gitService } from '@/lib/services/GitService';
import { POST as login } from '@/app/api/auth/login/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-loginpullrace-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function loginRequest(body: unknown) {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('login create-first-account path after a git import', () => {
  it('rejects create-first-account once importFromJson has brought in an existing admin', async () => {
    // Simulate "Alice already exists on the synced repo" by writing an
    // exported user file directly, the same shape exportToJson() produces,
    // then importing it — mirroring what a real `git pull` would leave on
    // disk before Bob's first login attempt.
    const usersDir = path.join(tempRoot, 'data', 'users');
    await fsPromises.mkdir(usersDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(usersDir, 'user-11111111-1111-1111-1111-111111111111.json'),
      JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', name: 'Alice', is_admin: 1, created_at: Date.now() })
    );
    await gitService.importFromJson();

    // Bob's local `users` table is no longer empty — the create-first path must be rejected.
    const res = await login(loginRequest({ name: 'Bob' }));
    expect(res.status).toBe(403);

    const admins = (await userService.getAll()).filter(u => u.is_admin === 1);
    expect(admins.length).toBe(1);
    expect(admins[0].name).toBe('Alice');
  });
});
```

- [ ] **Step 3: Run to confirm both pass**

Run: `npx vitest run test/styleOwnershipAdminBypass.test.ts test/loginPullRace.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: all passing

- [ ] **Step 5: Commit**

```bash
git add test/styleOwnershipAdminBypass.test.ts test/loginPullRace.test.ts
git commit -m "test: cover admin ownership bypass and the login/pull first-account race"
```

---

### Task 19: Final whole-branch review prep — typecheck + lint

**Files:** none (verification-only task)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all files passing, no skipped tests

- [ ] **Step 3: Grep sweep for anything the plan's tasks might have missed**

```bash
grep -rn "getClientId\|clientId" app lib test --include="*.ts" --include="*.tsx"
grep -rn "requestingUserId" app lib test --include="*.ts" --include="*.tsx"
```

Expected: zero results for both (the second may still show `newOwnerId`/`createdBy` in Shape-A service-layer test calls per Task 17's distinction — that's correct and expected, not a miss).

- [ ] **Step 4: Commit if either grep required a fix, otherwise proceed with no commit**

---

## Self-Review (performed while writing this plan)

**Spec coverage:** every section of `docs/superpowers/specs/2026-09-07-login-auth-design.md` maps to a task — Data model → Task 1, UserService/SessionService → Tasks 2-3, git sync → Task 5, session mechanism/cookie options → Tasks 4/6/7, Route Handler testability rule → Global Constraints + every route task, login/logout flow → Tasks 6-7/9, Proxy → Task 10, the complete call-site inventory → Tasks 12-15, test impact → Tasks 16-17, First-run/Pull race → Task 18. No spec section lacks a task.

**Placeholder scan:** no TBD/TODO; every code block is complete, real code with concrete values (90-day expiry in ms, 32-byte tokens, exact cookie option values, exact matcher regex). Task 17 is deliberately pattern-based rather than writing out all 14 files verbatim (each is a large existing file with independent content) — but the pattern itself, and one fully-worked example (`fromCrop.test.ts`), are concrete and repeatable, and Step 4 explicitly names the mechanical transformation to apply, not "figure it out."

**Type consistency:** `User`/`UserSchema` (Task 1) used identically in every later task. `getCurrentUser(req: NextRequest): Promise<User | null>` (Task 4) is the one signature every route task imports and calls the same way. `StyleService.update`'s new `isAdmin: boolean = false` parameter (Task 13) is the only service-layer signature change in the plan, called consistently from the one route that uses it. `seedSession()` (Task 16) returns `{ userId, cookieHeader }` and Task 17/18 both consume exactly that shape.

---

## Execution

This plan uses **superpowers:subagent-driven-development** — the standing pattern for every feature built this session (fresh implementer subagent per task, fresh task reviewer, final whole-branch review before merge). The user has stated they cannot answer questions for the remainder of this work, so per that skill's own "Rulings, not stalls" principle, any ambiguity the implementer or reviewer hits gets a documented ruling and continues rather than stopping to ask — the four genuine stop conditions (irreversible/destructive action, security-sensitive action, a merge/push to a shared branch the user hasn't pre-authorized, or a plan so broken every path is a guess) still apply, but this user has a standing autonomous PR/merge instruction on file that already covers the push/PR/merge case for a clean branch.
