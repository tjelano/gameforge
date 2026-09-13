# Dashboard AI Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a floating, always-available dashboard panel that answers "how does this feature work"
questions grounded in a curated knowledge doc + live project state, can navigate the user to a real
dashboard page, supports both Claude and Ollama as the answering model, and persists conversation
history per user with an in-panel history view.

**Architecture:** Two new DB tables + two thin services for persistence; two new "optional tool use"
call helpers added to the existing Claude/Ollama provider files; one route that assembles a system
prompt (curated doc + live `/api/context` data), calls the resolved provider, and persists both sides
of the turn; two read-only routes for history; one floating client component mounted at the root
layout.

**Tech Stack:** Next.js App Router route handlers, better-sqlite3 (direct SQL, no ORM), Zod, React
client components, the project's existing Claude/Ollama provider abstractions.

**Spec:** `docs/superpowers/specs/2026-09-13-dashboard-ai-copilot-design.md` (DeepSeek-reviewed, see
the paired `-review-log.md`).

## Global Constraints

- No ORM, no repository pattern, no wrapper classes, no custom Error subclasses, no DTOs — direct SQL
  via `DatabaseConnection.getInstance().prepare(...)`, direct Zod schemas, plain `Error` throws.
- Every new DB-backed service method follows the exact shape already used by `PageService.ts` /
  `PresetService.ts`: `getById`, `create`, ownership comparisons done by the **caller** (the route),
  not hidden inside a service method — `getById` itself never takes a `requestingUserId`.
- `try/catch` around every file system operation, with `console.error` logging on failure —
  `fs.mkdir(dir, { recursive: true })` is not needed here (no new directories are written to), but any
  `fs.readFile` still gets its own try/catch.
- `path.join(getProjectRoot(), ...)` for every physical path; `getProjectRoot` from
  `@/lib/utils/projectRoot`.
- Every new/modified route: `getCurrentUser(req)` from `@/lib/utils/session`, 401 with
  `{ success: false, error: 'Not logged in' }` if absent — exactly the pattern already in
  `app/api/pages/[id]/route.ts` and `app/api/generate/route.ts`.
- Route error responses: `{ success: false, error: <readable message> }` with a specific HTTP status
  (401/403/404/400/502/503/500) — never a raw error code like `'FORBIDDEN'` as the message text itself
  (see `app/api/pages/[id]/route.ts` for the exact convention: `'Page not found'`, not `'NOT_FOUND'`).
- Service/helper unit tests run against a **real temporary SQLite file**
  (`setProjectRootForTests()` + `DatabaseConnection.resetForTests()`, copying the real
  `lib/database/migrations/*.sql` files into the temp root first) — this is `test/pageService.test.ts`'s
  exact boilerplate, reused verbatim in every new test file below. Never mock the database.
  `fetch` is mocked at the global level (`vi.stubGlobal('fetch', ...)`) for provider-call tests, exactly
  as `test/claudeToolCall.test.ts` / `test/ollamaToolCall.test.ts` already do — never `vi.mock()` a
  whole module for this.
- No React component rendering tests exist anywhere in this codebase (confirmed: zero
  `@testing-library` usage). The one UI task in this plan (Task 9) is verified manually in a running
  dev server, per `AGENTS.md`'s own instruction for UI changes — this is a deliberate, converged
  project convention, not a shortcut.
- Run `npx vitest run`, `npx tsc --noEmit`, and `npx eslint app lib worker.ts` before considering any
  task done — all three are required CI gates (`.github/workflows/ci.yml`), not just the first two.

---

### Task 1: Copilot tables migration + Zod schemas

**Files:**
- Create: `lib/database/migrations/016_add_copilot_tables.sql`
- Modify: `lib/database/schema.ts` (append two schemas at the end of the file)
- Test: `test/migration-016.test.ts`

**Interfaces:**
- Produces: `CopilotConversationSchema` / `type CopilotConversation`, `CopilotMessageSchema` /
  `type CopilotMessage`, both exported from `lib/database/schema.ts` — every later task that touches
  these tables imports from here.

- [ ] **Step 1: Write the migration**

Create `lib/database/migrations/016_add_copilot_tables.sql`:

```sql
CREATE TABLE copilot_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_copilot_conversations_created_by ON copilot_conversations(created_by);

CREATE TABLE copilot_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES copilot_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_call TEXT,
  provider TEXT CHECK (provider IN ('claude', 'ollama')),
  model TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_copilot_messages_conversation_id ON copilot_messages(conversation_id);
```

- [ ] **Step 2: Add the Zod schemas**

Append to the end of `lib/database/schema.ts`:

```ts
export const CopilotConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  created_by: z.string().min(1),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type CopilotConversation = z.infer<typeof CopilotConversationSchema>;

export const CopilotMessageSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  tool_call: z.string().nullable(), // JSON-serialized {name, input}
  provider: z.enum(['claude', 'ollama']).nullable(),
  model: z.string().nullable(),
  created_at: z.number().int(),
});
export type CopilotMessage = z.infer<typeof CopilotMessageSchema>;
```

- [ ] **Step 3: Write the failing migration test**

Create `test/migration-016.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-migration016-'));
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

describe('migration 016', () => {
  it('creates copilot_conversations and copilot_messages with working constraints', () => {
    const db = DatabaseConnection.getInstance();

    db.prepare(`
      INSERT INTO copilot_conversations (id, title, created_by, created_at, updated_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'How do themes work?', 'user-1', 1000, 1000)
    `).run();

    db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, tool_call, provider, model, created_at)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'user', 'How do themes work?', NULL, NULL, NULL, 1000)
    `).run();

    const convo = db.prepare('SELECT * FROM copilot_conversations WHERE id = ?').get('11111111-1111-1111-1111-111111111111') as any;
    expect(convo.title).toBe('How do themes work?');

    const msg = db.prepare('SELECT * FROM copilot_messages WHERE id = ?').get('22222222-2222-2222-2222-222222222222') as any;
    expect(msg.role).toBe('user');

    expect(() => db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, created_at)
      VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'system', 'nope', 1000)
    `).run()).toThrow(/CHECK constraint/);

    expect(() => db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, created_at)
      VALUES ('44444444-4444-4444-4444-444444444444', 'does-not-exist', 'user', 'orphan', 1000)
    `).run()).toThrow(/FOREIGN KEY constraint/);
  });
});
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/migration-016.test.ts`
Expected: PASS (the migration and schema already exist from Steps 1-2, so this confirms them rather
than following red-green — there is no code path to make fail-first here, only SQL).

- [ ] **Step 5: Commit**

```bash
git add lib/database/migrations/016_add_copilot_tables.sql lib/database/schema.ts test/migration-016.test.ts
git commit -m "feat: add copilot_conversations/copilot_messages tables and schemas"
```

---

### Task 2: CopilotConversationService + CopilotMessageService

**Files:**
- Create: `lib/services/CopilotConversationService.ts`
- Create: `lib/services/CopilotMessageService.ts`
- Test: `test/copilotConversationService.test.ts`
- Test: `test/copilotMessageService.test.ts`

**Interfaces:**
- Consumes: `CopilotConversationSchema`/`CopilotMessageSchema` from Task 1.
- Produces: `copilotConversationService` singleton — `.create({title, createdBy})`,
  `.getById(id)`, `.listForUser(userId)`, `.touch(id)`. `copilotMessageService` singleton —
  `.append({conversationId, role, content, toolCall?, provider?, model?})`,
  `.listByConversation(conversationId)`. Task 3's routes and Task 8's message route both call these
  directly — no ownership logic lives inside either service (see Global Constraints).

- [ ] **Step 1: Write the failing service test for conversations**

Create `test/copilotConversationService.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotconvo-'));
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

describe('CopilotConversationService', () => {
  it('creates a conversation and reads it back', async () => {
    const convo = await copilotConversationService.create({ title: 'How do themes work?', createdBy: 'user-1' });
    expect(convo.title).toBe('How do themes work?');
    expect(convo.created_by).toBe('user-1');

    const fetched = await copilotConversationService.getById(convo.id);
    expect(fetched?.id).toBe(convo.id);
  });

  it('getById returns null for an unknown id', async () => {
    expect(await copilotConversationService.getById('does-not-exist')).toBeNull();
  });

  it('listForUser scopes to the creator and orders newest-updated first', async () => {
    const a = await copilotConversationService.create({ title: 'A', createdBy: 'user-1' });
    const b = await copilotConversationService.create({ title: 'B', createdBy: 'user-1' });
    await copilotConversationService.create({ title: 'Other user', createdBy: 'user-2' });

    // touch()'s updated_at must land strictly after b's own created_at/updated_at
    // for the assertion below to be meaningful -- without this gap, a fast
    // synchronous run could tie all three Date.now() calls to the same
    // millisecond, making the expected order a coincidence rather than a
    // real assertion of touch()'s effect.
    await new Promise(resolve => setTimeout(resolve, 20));
    await copilotConversationService.touch(a.id);

    const list = await copilotConversationService.listForUser('user-1');
    expect(list.map(c => c.id)).toEqual([a.id, b.id]);
  });

  it('touch bumps updated_at', async () => {
    const convo = await copilotConversationService.create({ title: 'A', createdBy: 'user-1' });
    const before = convo.updated_at;
    await new Promise(resolve => setTimeout(resolve, 20)); // comfortably above typical Date.now() clock-tick resolution
    await copilotConversationService.touch(convo.id);
    const after = await copilotConversationService.getById(convo.id);
    expect(after!.updated_at).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/copilotConversationService.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/CopilotConversationService'"

- [ ] **Step 3: Implement CopilotConversationService**

Create `lib/services/CopilotConversationService.ts`:

```ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { CopilotConversationSchema, type CopilotConversation } from '@/lib/database/schema';

class CopilotConversationServiceImpl {
  async create(input: { title: string; createdBy: string }): Promise<CopilotConversation> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO copilot_conversations (id, title, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.title, input.createdBy, now, now);
    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<CopilotConversation | null> {
    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM copilot_conversations WHERE id = ?').get(id);
    return row ? CopilotConversationSchema.parse(row) : null;
  }

  /** This user's conversations, most-recently-active first. */
  async listForUser(userId: string): Promise<CopilotConversation[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM copilot_conversations WHERE created_by = ? ORDER BY updated_at DESC'
    ).all(userId);
    return rows.map(row => CopilotConversationSchema.parse(row));
  }

  /** Called once per message turn so the conversation list sorts by recent activity, not just creation. */
  async touch(id: string): Promise<void> {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE copilot_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
}

export const copilotConversationService = new CopilotConversationServiceImpl();
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/copilotConversationService.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing service test for messages**

Create `test/copilotMessageService.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotmsg-'));
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

describe('CopilotMessageService', () => {
  it('appends a plain user message with null tool_call/provider/model', async () => {
    const convo = await copilotConversationService.create({ title: 'x', createdBy: 'user-1' });
    const msg = await copilotMessageService.append({ conversationId: convo.id, role: 'user', content: 'How do themes work?' });
    expect(msg.role).toBe('user');
    expect(msg.tool_call).toBeNull();
    expect(msg.provider).toBeNull();
    expect(msg.model).toBeNull();
  });

  it('appends an assistant message with a JSON-serialized tool_call, provider, and model', async () => {
    const convo = await copilotConversationService.create({ title: 'x', createdBy: 'user-1' });
    const msg = await copilotMessageService.append({
      conversationId: convo.id,
      role: 'assistant',
      content: "Here's the Ollama settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    expect(JSON.parse(msg.tool_call!)).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } });
    expect(msg.provider).toBe('claude');
    expect(msg.model).toBe('claude-sonnet-5');
  });

  it('listByConversation returns messages oldest-first, scoped to one conversation', async () => {
    const a = await copilotConversationService.create({ title: 'A', createdBy: 'user-1' });
    const b = await copilotConversationService.create({ title: 'B', createdBy: 'user-1' });
    const first = await copilotMessageService.append({ conversationId: a.id, role: 'user', content: 'first' });
    const second = await copilotMessageService.append({ conversationId: a.id, role: 'assistant', content: 'second' });
    await copilotMessageService.append({ conversationId: b.id, role: 'user', content: 'other conversation' });

    const messages = await copilotMessageService.listByConversation(a.id);
    expect(messages.map(m => m.id)).toEqual([first.id, second.id]);
  });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `npx vitest run test/copilotMessageService.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/CopilotMessageService'"

- [ ] **Step 7: Implement CopilotMessageService**

Create `lib/services/CopilotMessageService.ts`:

```ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { CopilotMessageSchema, type CopilotMessage } from '@/lib/database/schema';

class CopilotMessageServiceImpl {
  async append(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    toolCall?: { name: string; input: unknown };
    provider?: 'claude' | 'ollama';
    model?: string;
  }): Promise<CopilotMessage> {
    const db = DatabaseConnection.getInstance();
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO copilot_messages (id, conversation_id, role, content, tool_call, provider, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.role,
      input.content,
      input.toolCall ? JSON.stringify(input.toolCall) : null,
      input.provider ?? null,
      input.model ?? null,
      now
    );
    const row = db.prepare('SELECT * FROM copilot_messages WHERE id = ?').get(id);
    return CopilotMessageSchema.parse(row);
  }

  /**
   * Oldest first — the natural order for replaying into a model's `messages`
   * array. `rowid` is SQLite's implicit insertion-order column (present on
   * every normal, non-WITHOUT-ROWID table, which this is); it's the
   * tiebreaker for two messages landing on the same created_at millisecond
   * (a real possibility: the route appends the user message, then the
   * assistant's reply, and a mocked/very fast model call in tests can make
   * both happen within the same tick) -- `created_at` alone doesn't
   * guarantee a stable order for ties.
   */
  async listByConversation(conversationId: string): Promise<CopilotMessage[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(
      'SELECT * FROM copilot_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(conversationId);
    return rows.map(row => CopilotMessageSchema.parse(row));
  }
}

export const copilotMessageService = new CopilotMessageServiceImpl();
```

- [ ] **Step 8: Run both test files, confirm they pass**

Run: `npx vitest run test/copilotConversationService.test.ts test/copilotMessageService.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/services/CopilotConversationService.ts lib/services/CopilotMessageService.ts test/copilotConversationService.test.ts test/copilotMessageService.test.ts
git commit -m "feat: add CopilotConversationService and CopilotMessageService"
```

---

### Task 3: History routes — list conversations, load one

**Files:**
- Create: `app/api/copilot/conversations/route.ts`
- Create: `app/api/copilot/conversations/[id]/route.ts`
- Test: `test/copilotConversationsRoute.test.ts`

**Interfaces:**
- Consumes: `copilotConversationService`, `copilotMessageService` (Task 2), `getCurrentUser` from
  `@/lib/utils/session`.
- Produces: `GET /api/copilot/conversations` → `{success, data: {id, title, updatedAt}[]}`.
  `GET /api/copilot/conversations/[id]` → `{success, data: {id, title, messages: {id, role, content,
  toolCall?, provider, model, createdAt}[]}}`. Task 9's `CopilotPanel` calls both directly.

- [ ] **Step 1: Write the failing route test**

Create `test/copilotConversationsRoute.test.ts`:

```ts
// test/copilotConversationsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';
import { GET as listConversations } from '@/app/api/copilot/conversations/route';
import { GET as getConversation } from '@/app/api/copilot/conversations/[id]/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotconvoroute-'));
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

function req(cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/copilot/conversations', {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

describe('copilot conversation routes', () => {
  it('GET /api/copilot/conversations requires login', async () => {
    const res = await listConversations(req());
    expect(res.status).toBe(401);
  });

  it('GET /api/copilot/conversations lists only the requesting user\'s conversations', async () => {
    const { userId, cookieHeader } = await seedSession('Alice');
    const { userId: otherUserId } = await seedSession('Bob');
    await copilotConversationService.create({ title: 'Mine', createdBy: userId });
    await copilotConversationService.create({ title: 'Not mine', createdBy: otherUserId });

    const res = await listConversations(req(cookieHeader));
    const body = await res.json();
    expect(body.data.map((c: any) => c.title)).toEqual(['Mine']);
  });

  it('GET /api/copilot/conversations/[id] returns 404 for an unknown id', async () => {
    const { cookieHeader } = await seedSession();
    const res = await getConversation(req(cookieHeader), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });

  it('GET /api/copilot/conversations/[id] returns 403 for another user\'s conversation', async () => {
    const { userId: ownerId } = await seedSession('Alice');
    const { cookieHeader: otherCookie } = await seedSession('Bob');
    const convo = await copilotConversationService.create({ title: 'Alice only', createdBy: ownerId });

    const res = await getConversation(req(otherCookie), { params: Promise.resolve({ id: convo.id }) });
    expect(res.status).toBe(403);
  });

  it('GET /api/copilot/conversations/[id] returns the conversation with its messages in order', async () => {
    const { userId, cookieHeader } = await seedSession();
    const convo = await copilotConversationService.create({ title: 'How do themes work?', createdBy: userId });
    await copilotMessageService.append({ conversationId: convo.id, role: 'user', content: 'How do themes work?' });
    await copilotMessageService.append({
      conversationId: convo.id,
      role: 'assistant',
      content: 'Generate a theme from the Themes page.',
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/themes' } },
      provider: 'claude',
      model: 'claude-sonnet-5',
    });

    const res = await getConversation(req(cookieHeader), { params: Promise.resolve({ id: convo.id }) });
    const body = await res.json();
    expect(body.data.title).toBe('How do themes work?');
    expect(body.data.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(body.data.messages[1].toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/themes' } });
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/copilotConversationsRoute.test.ts`
Expected: FAIL with "Cannot find module '@/app/api/copilot/conversations/route'"

- [ ] **Step 3: Implement the list route**

Create `app/api/copilot/conversations/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/utils/session';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    const conversations = await copilotConversationService.listForUser(user.id);
    return NextResponse.json({
      success: true,
      data: conversations.map(c => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Implement the single-conversation route**

Create `app/api/copilot/conversations/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/utils/session';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const conversation = await copilotConversationService.getById(id);
    if (!conversation) {
      return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 });
    }
    if (conversation.created_by !== user.id) {
      return NextResponse.json({ success: false, error: 'You do not have access to this conversation' }, { status: 403 });
    }

    const messages = await copilotMessageService.listByConversation(id);
    return NextResponse.json({
      success: true,
      data: {
        id: conversation.id,
        title: conversation.title,
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCall: m.tool_call ? JSON.parse(m.tool_call) : undefined,
          provider: m.provider,
          model: m.model,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `npx vitest run test/copilotConversationsRoute.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/api/copilot/conversations test/copilotConversationsRoute.test.ts
git commit -m "feat: add copilot conversation history routes"
```

---

### Task 4: Shared dashboard-route list + the navigate_to_page tool contract

**Files:**
- Create: `lib/dashboardRoutes.ts`
- Create: `lib/services/copilotTool.ts`
- Modify: `app/components/NavRail.tsx`
- Test: `test/copilotTool.test.ts`

**Interfaces:**
- Produces: `DASHBOARD_ROUTES: {href, label}[]` (`lib/dashboardRoutes.ts`) — the single source of truth
  for both `NavRail`'s link list and the navigation tool's enum. `ProviderMessageResult` type,
  `NAVIGATE_TOOL_NAME`, `buildNavigateTool()`, `NavigateToPageInputSchema` (`lib/services/copilotTool.ts`)
  — Tasks 5, 6, and 8 all import from here.

- [ ] **Step 1: Extract the shared route list**

Create `lib/dashboardRoutes.ts`:

```ts
export interface DashboardRoute {
  href: string;
  label: string;
}

// Single source of truth for both NavRail's link list and the copilot's
// navigate_to_page tool enum -- see lib/services/copilotTool.ts. Keep this
// to GameForge's static routes only; a dynamic route (a specific job's
// edit page, a specific asset) has no id the model could validly supply.
export const DASHBOARD_ROUTES: DashboardRoute[] = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/themes', label: 'Themes' },
  { href: '/dashboard/components', label: 'Components' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/presets', label: 'Presets' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/drive', label: 'Drive' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
  { href: '/dashboard/settings/google-drive', label: 'Google Drive' },
  { href: '/dashboard/settings/ollama', label: 'Ollama' },
];
```

- [ ] **Step 2: Update NavRail to use it, and to use the existing useCurrentUser hook**

`app/components/NavRail.tsx` currently defines its own `LINKS` constant and does its own inline
`/api/auth/me` fetch. `lib/hooks/useCurrentUser.ts` already exists (used today by
`app/dashboard/styles/[id]/page.tsx`) and does the exact same fetch — reuse it instead of keeping a
second copy.

Replace the top of `app/components/NavRail.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DASHBOARD_ROUTES } from '@/lib/dashboardRoutes';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';

export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { user: me } = useCurrentUser();
  const [loggingOut, setLoggingOut] = useState(false);
```

Remove the old `LINKS` constant, the `useEffect`/`useState` pair that fetched `/api/auth/me` into
`me`, and the now-unused `useEffect` import. Leave `handleLogout` exactly as-is. Replace
`{LINKS.map(link => (` with `{DASHBOARD_ROUTES.map(link => (` in the render body — the rest of that
block (the `<Link>` JSX) is unchanged, since `DashboardRoute`'s `{href, label}` shape matches the old
`LINKS` entries exactly.

- [ ] **Step 3: Write the failing tool-contract test**

Create `test/copilotTool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROUTES } from '@/lib/dashboardRoutes';
import { buildNavigateTool, NavigateToPageInputSchema, NAVIGATE_TOOL_NAME } from '@/lib/services/copilotTool';

describe('copilot navigate_to_page tool', () => {
  it('builds a tool schema whose path enum matches DASHBOARD_ROUTES exactly', () => {
    const tool = buildNavigateTool();
    expect(tool.name).toBe(NAVIGATE_TOOL_NAME);
    expect((tool.inputSchema.properties as any).path.enum).toEqual(DASHBOARD_ROUTES.map(r => r.href));
  });

  it('accepts any real dashboard route', () => {
    const result = NavigateToPageInputSchema.safeParse({ path: '/dashboard/settings/ollama' });
    expect(result.success).toBe(true);
  });

  it('rejects a path outside the static route list', () => {
    const result = NavigateToPageInputSchema.safeParse({ path: '/dashboard/jobs/123/edit' });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 4: Run it, confirm it fails**

Run: `npx vitest run test/copilotTool.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/copilotTool'"

- [ ] **Step 5: Implement the tool contract**

Create `lib/services/copilotTool.ts`:

```ts
import { z } from 'zod';
import { DASHBOARD_ROUTES } from '@/lib/dashboardRoutes';

export const NAVIGATE_TOOL_NAME = 'navigate_to_page';

const ROUTE_HREFS = DASHBOARD_ROUTES.map(r => r.href);

// z.enum's typed overload wants a non-empty tuple, not string[] -- DASHBOARD_ROUTES
// is a fixed, always-non-empty list, so this cast is safe.
export const NavigateToPageInputSchema = z.object({
  path: z.enum(ROUTE_HREFS as [string, ...string[]]),
});

/** The shared return shape for both callClaudeMessage() and callOllamaMessage() (Tasks 5-6). */
export interface ProviderMessageResult {
  text: string;
  toolCall?: { name: string; input: unknown };
}

export function buildNavigateTool() {
  return {
    name: NAVIGATE_TOOL_NAME,
    description: 'Navigate the user to a specific page in the GameForge dashboard.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', enum: ROUTE_HREFS, description: 'The dashboard route to navigate to.' },
      },
      required: ['path'],
    },
  };
}
```

- [ ] **Step 6: Run the test, confirm it passes**

Run: `npx vitest run test/copilotTool.test.ts`
Expected: PASS

- [ ] **Step 7: Manually verify NavRail still renders**

Run: `npm run dev`, open `http://localhost:3000/dashboard/generate`.
Expected: the left nav rail shows the same 15 links as before, in the same order, and still shows
"Logged in as &lt;name&gt;" with a working Log out button.

- [ ] **Step 8: Commit**

```bash
git add lib/dashboardRoutes.ts lib/services/copilotTool.ts app/components/NavRail.tsx test/copilotTool.test.ts
git commit -m "refactor: extract DASHBOARD_ROUTES and add the navigate_to_page tool contract"
```

---

### Task 5: resolveClaudeProvider() + callClaudeMessage()

**Files:**
- Modify: `lib/services/claudeApiProviders.ts`
- Modify: `lib/services/claudeToolCall.ts`
- Modify: `test/claudeToolCall.test.ts`

**Interfaces:**
- Consumes: `ANTHROPIC_PROVIDER`/`CHEAPERINFERENCE_PROVIDER` (already in `claudeApiProviders.ts`),
  `ProviderMessageResult` (Task 4).
- Produces: `resolveClaudeProvider(): { provider: ClaudeApiProvider; apiKey: string } | { error: string }`
  and `callClaudeMessage(params): Promise<ProviderMessageResult>`. Task 8's message route calls both.

- [ ] **Step 1: Write the failing test for resolveClaudeProvider**

Append to `test/claudeToolCall.test.ts` (new imports at the top, new `describe` block at the bottom):

```ts
import { resolveClaudeProvider } from '@/lib/services/claudeApiProviders';
```

```ts
describe('resolveClaudeProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves Anthropic when THEME_API_PROVIDER is unset and ANTHROPIC_API_KEY is present', () => {
    delete process.env.THEME_API_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key';
    const result = resolveClaudeProvider();
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.provider.name).toBe('anthropic');
      expect(result.apiKey).toBe('fake-anthropic-key');
    }
  });

  it('resolves cheaperinference when THEME_API_PROVIDER is set to it and the key is present', () => {
    process.env.THEME_API_PROVIDER = 'cheaperinference';
    process.env.CHEAPERINFERENCE_API_KEY = 'fake-ci-key';
    const result = resolveClaudeProvider();
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.provider.name).toBe('cheaperinference');
      expect(result.apiKey).toBe('fake-ci-key');
    }
  });

  it('returns an error, not a throw, when no key is configured', () => {
    delete process.env.THEME_API_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    const result = resolveClaudeProvider();
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/isn't configured/);
    }
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/claudeToolCall.test.ts`
Expected: FAIL with "'resolveClaudeProvider' is not exported"

- [ ] **Step 3: Implement resolveClaudeProvider**

Append to `lib/services/claudeApiProviders.ts`:

```ts
const NOT_CONFIGURED_ERROR = "Claude isn't configured — set ANTHROPIC_API_KEY or CHEAPERINFERENCE_API_KEY, or pick an installed Ollama model instead.";

/**
 * Resolves which Claude-shaped provider + API key to use, from the same
 * THEME_API_PROVIDER env-var switch ThemeGenerator.ts/ComponentGenerator.ts/
 * PageLayoutSuggester.ts each already read -- but exported here, since this
 * is the first caller outside those three generators (the copilot route).
 * Returns an error value rather than throwing or falling back to a mock --
 * the copilot has no mock backend, so a misconfiguration must be reported
 * to the caller, not silently swallowed.
 */
export function resolveClaudeProvider(): { provider: ClaudeApiProvider; apiKey: string } | { error: string } {
  const providerName = process.env.THEME_API_PROVIDER;
  if (!providerName || providerName === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) return { error: NOT_CONFIGURED_ERROR };
    return { provider: ANTHROPIC_PROVIDER, apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (providerName === 'cheaperinference') {
    if (!process.env.CHEAPERINFERENCE_API_KEY) return { error: NOT_CONFIGURED_ERROR };
    return { provider: CHEAPERINFERENCE_PROVIDER, apiKey: process.env.CHEAPERINFERENCE_API_KEY };
  }
  return { error: `Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic" or "cheaperinference".` };
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/claudeToolCall.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for callClaudeMessage**

Append to `test/claudeToolCall.test.ts` — this file already imports `ANTHROPIC_PROVIDER` at its top
(used by the pre-existing `callClaudeTool` tests), so only the new function needs importing:

```ts
import { callClaudeMessage } from '@/lib/services/claudeToolCall';
```

```ts
function baseMessageParams(overrides: Partial<Parameters<typeof callClaudeMessage>[0]> = {}) {
  return {
    provider: ANTHROPIC_PROVIDER,
    apiKey: 'fake-key',
    toolName: 'navigate_to_page',
    toolDescription: 'Navigate somewhere.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
    messages: [{ role: 'user', content: 'How do themes work?' }],
    operationLabel: 'copilot message',
    truncatedMessage: 'the reply could not be completed',
    ...overrides,
  };
}

describe('callClaudeMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns text with no toolCall when the model replies with plain text', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Generate a theme from the Themes page.' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callClaudeMessage(baseMessageParams());
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('returns both text and toolCall when the model does both in one turn', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [
        { type: 'text', text: "Here's the Ollama settings page." },
        { type: 'tool_use', id: 't1', name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
      ],
      stop_reason: 'tool_use',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callClaudeMessage(baseMessageParams());
    expect(result).toEqual({
      text: "Here's the Ollama settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
    });
  });

  it('sends tool_choice auto and the system prompt as a top-level field, not a message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await callClaudeMessage(baseMessageParams({ system: 'You are the GameForge copilot.' }));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toBe('You are the GameForge copilot.');
    expect(body.messages).toEqual([{ role: 'user', content: 'How do themes work?' }]);
  });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `npx vitest run test/claudeToolCall.test.ts`
Expected: FAIL with "'callClaudeMessage' is not exported"

- [ ] **Step 7: Implement callClaudeMessage**

Append to `lib/services/claudeToolCall.ts` (reuses the file's existing private `fetchWithRetry` and
`combineWithTimeout`, so no new imports are needed):

```ts
export interface ClaudeMessageParams {
  provider: ClaudeApiProvider;
  apiKey: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  /** Top-level Anthropic `system` field -- never a message in `messages`, unlike Ollama's /api/chat. */
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  operationLabel: string;
  truncatedMessage: string;
}

/**
 * Like callClaudeTool(), but for the copilot's conversational turn: tool use
 * is optional (tool_choice: auto, not forced), and the reply may carry text,
 * a tool call, or both -- callClaudeTool() only ever looks for a tool_use
 * block and throws if one's missing, which is the wrong contract here.
 */
export async function callClaudeMessage(params: ClaudeMessageParams): Promise<import('@/lib/services/copilotTool').ProviderMessageResult> {
  const { provider, apiKey, toolName, toolDescription, inputSchema, messages, system, maxTokens = 4096, signal, operationLabel, truncatedMessage } = params;

  const res = await fetchWithRetry(provider.requestUrl, {
    method: 'POST',
    headers: {
      ...provider.buildAuthHeaders(apiKey),
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      tools: [{ name: toolName, description: toolDescription, input_schema: inputSchema }],
      tool_choice: { type: 'auto' },
      messages,
    }),
    signal: combineWithTimeout(signal),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${operationLabel} failed via ${provider.name} (${res.status}): ${body || res.statusText}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Anthropic response (via ${provider.name}) was truncated (stop_reason: max_tokens) before completing — ${truncatedMessage}.`);
  }

  let text = '';
  let toolCall: { name: string; input: unknown } | undefined;
  for (const block of data.content) {
    if (block.type === 'text') {
      text += (block as { text?: string }).text ?? '';
    } else if (block.type === 'tool_use') {
      const tu = block as unknown as ToolUseBlock;
      toolCall = { name: tu.name, input: tu.input };
    }
  }
  return { text, toolCall };
}
```

(The inline `import('@/lib/services/copilotTool').ProviderMessageResult` type-only import avoids a
circular runtime import — `copilotTool.ts` never imports from `claudeToolCall.ts`, so this is safe and
matches how this file already type-only-imports `OllamaProviderOverride` from `ollamaToolCall.ts`
elsewhere in the codebase. If preferred for readability, a top-level
`import type { ProviderMessageResult } from '@/lib/services/copilotTool';` works identically — use
whichever this file's existing import block style favors.)

- [ ] **Step 8: Run the test, confirm it passes**

Run: `npx vitest run test/claudeToolCall.test.ts`
Expected: PASS, all `describe` blocks including the pre-existing retry tests.

- [ ] **Step 9: Commit**

```bash
git add lib/services/claudeApiProviders.ts lib/services/claudeToolCall.ts test/claudeToolCall.test.ts
git commit -m "feat: add resolveClaudeProvider() and callClaudeMessage() for optional tool use"
```

---

### Task 6: callOllamaMessage()

**Files:**
- Modify: `lib/services/ollamaToolCall.ts`
- Modify: `test/ollamaToolCall.test.ts`

**Interfaces:**
- Consumes: `ProviderMessageResult` (Task 4).
- Produces: `callOllamaMessage(params): Promise<ProviderMessageResult>`. Task 8's message route calls
  this for the Ollama path.

- [ ] **Step 1: Write the failing test**

Append to `test/ollamaToolCall.test.ts` — this file already defines a local `jsonResponse(body, ok,
status)` helper near its top (used by the pre-existing `callOllamaTool` tests); the new `describe`
block below reuses that same helper, no new one needed:

```ts
import { callOllamaMessage } from '@/lib/services/ollamaToolCall';
```

```ts
const baseMessageParams = {
  host: 'http://localhost:11434',
  model: 'llama3-groq-tool-use:8b',
  toolName: 'navigate_to_page',
  toolDescription: 'Navigate somewhere.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  messages: [{ role: 'system', content: 'You are the GameForge copilot.' }, { role: 'user', content: 'How do themes work?' }],
  operationLabel: 'copilot message',
  truncatedMessage: 'the reply could not be completed',
};

describe('callOllamaMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns plain text when the model makes no tool call -- the normal case here', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { role: 'assistant', content: 'Generate a theme from the Themes page.' },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('returns text and toolCall when the model calls the tool', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: {
        role: 'assistant',
        content: "Here's the Ollama settings page.",
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/settings/ollama' } } }],
      },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result).toEqual({
      text: "Here's the Ollama settings page.",
      toolCall: { name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } },
    });
  });

  it('JSON.parses a stringified tool call argument', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":"/dashboard/themes"}' } }],
      },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result.toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/themes' } });
  });

  it('falls back to the plain text reply when a stringified tool call argument is malformed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: {
        content: 'Generate a theme from the Themes page.',
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: '{"path":' } }],
      },
    }));
    const result = await callOllamaMessage(baseMessageParams);
    expect(result).toEqual({ text: 'Generate a theme from the Themes page.' });
  });

  it('still throws on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'model not found' }, false, 404));
    await expect(callOllamaMessage(baseMessageParams)).rejects.toThrow(/copilot message failed \(404\)/);
  });

  it('still treats prompt_eval_count reaching num_ctx as truncation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { content: 'cut off' },
      prompt_eval_count: 8192,
    }));
    await expect(callOllamaMessage(baseMessageParams)).rejects.toThrow('truncated');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/ollamaToolCall.test.ts`
Expected: FAIL with "'callOllamaMessage' is not exported"

- [ ] **Step 3: Implement callOllamaMessage**

Append to `lib/services/ollamaToolCall.ts` (reuses the file's existing private `withOllamaLock`,
`combineWithTimeout`, and `DEFAULT_NUM_CTX`):

```ts
export interface OllamaMessageParams {
  host: string;
  model: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  signal?: AbortSignal;
  operationLabel: string;
  truncatedMessage: string;
}

/**
 * Like callOllamaTool(), but for the copilot's conversational turn: a
 * missing tool_calls entry is the normal, expected case here (most turns
 * are plain answers), not the hard-fail callOllamaTool() treats it as.
 */
export async function callOllamaMessage(params: OllamaMessageParams): Promise<import('@/lib/services/copilotTool').ProviderMessageResult> {
  const { host, model, toolName, toolDescription, inputSchema, messages, signal, operationLabel, truncatedMessage } = params;

  return withOllamaLock(async () => {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: inputSchema } }],
        options: { num_ctx: DEFAULT_NUM_CTX },
      }),
      signal: combineWithTimeout(signal),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${operationLabel} failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (typeof data.prompt_eval_count === 'number' && data.prompt_eval_count >= DEFAULT_NUM_CTX) {
      throw new Error(`Ollama response for ${operationLabel} was truncated (prompt_eval_count reached num_ctx) -- ${truncatedMessage}.`);
    }

    const text = data.message?.content ?? '';
    const toolCallRaw = data.message?.tool_calls?.[0];
    if (!toolCallRaw) return { text };

    let input = toolCallRaw.function.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        // Malformed structured output -- unlike callOllamaTool(), a bad tool
        // call here shouldn't blank out an otherwise-usable text reply.
        return { text };
      }
    }
    return { text, toolCall: { name: toolCallRaw.function.name, input } };
  });
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/ollamaToolCall.test.ts`
Expected: PASS, all `describe` blocks including the pre-existing `callOllamaTool` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/services/ollamaToolCall.ts test/ollamaToolCall.test.ts
git commit -m "feat: add callOllamaMessage() for optional tool use"
```

---

### Task 7: Project-context extraction + copilot system prompt + knowledge doc

**Files:**
- Create: `lib/services/projectContext.ts`
- Modify: `app/api/context/route.ts`
- Create: `docs/copilot-knowledge.md`
- Create: `lib/services/copilotSystemPrompt.ts`
- Test: `test/copilotSystemPrompt.test.ts`

**Interfaces:**
- Consumes: `styleService.getActiveStyles()`, `assetService.getActiveAssets()`, `jobService.getActive()`
  (all pre-existing).
- Produces: `getProjectContextSummary(): Promise<{styles, totalActiveAssets, inFlightJobs}>` —
  `app/api/context/route.ts` and `buildCopilotSystemPrompt()` both call this, instead of
  `/api/copilot/message` making an HTTP round-trip to its own server. `buildCopilotSystemPrompt():
  Promise<string>` — Task 8's message route calls this once per turn.

- [ ] **Step 1: Extract getProjectContextSummary from the existing /api/context route**

`app/api/context/route.ts` today inlines the styles/assets/jobs aggregation directly in its `GET`
handler. The copilot needs the exact same aggregation — extracting it once avoids a second,
drifting copy.

Create `lib/services/projectContext.ts`:

```ts
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { jobService } from '@/lib/services/JobService';

export interface ProjectContextSummary {
  styles: { id: string; name: string; assetCount: number }[];
  totalActiveAssets: number;
  inFlightJobs: number;
}

/**
 * Moved out of app/api/context/route.ts so both that route and the
 * copilot's system-prompt builder (lib/services/copilotSystemPrompt.ts)
 * share one aggregation instead of the copilot re-fetching its own HTTP
 * endpoint over the network.
 */
export async function getProjectContextSummary(): Promise<ProjectContextSummary> {
  const [styles, assets, activeJobs] = await Promise.all([
    styleService.getActiveStyles(),
    assetService.getActiveAssets(),
    jobService.getActive(),
  ]);

  const assetCountByStyle = new Map<string, number>();
  for (const asset of assets) {
    assetCountByStyle.set(asset.style_id, (assetCountByStyle.get(asset.style_id) ?? 0) + 1);
  }

  return {
    styles: styles.map(style => ({
      id: style.id,
      name: style.name,
      assetCount: assetCountByStyle.get(style.id) ?? 0,
    })),
    totalActiveAssets: assets.length,
    inFlightJobs: activeJobs.filter(j => j.status === 'pending' || j.status === 'processing').length,
  };
}
```

- [ ] **Step 2: Point the existing route at it**

Replace the body of `app/api/context/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { getProjectContextSummary } from '@/lib/services/projectContext';

export const dynamic = 'force-dynamic';

/**
 * Modular context summary for AI assistants (AGENTS.md/CLAUDE.md-facing).
 * The blueprint names this endpoint but never specifies its shape — this
 * is an inferred minimal design: current styles, asset counts per style,
 * and in-flight job counts, so an assistant can orient without querying
 * the DB directly. Extend as concrete AI-assistant use cases emerge.
 */
export async function GET() {
  try {
    const data = await getProjectContextSummary();
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Run the existing test suite to confirm this route still behaves identically**

Run: `npx vitest run`
Expected: PASS — no existing test imports `/api/context/route.ts` directly (confirmed: no
`test/*context*.test.ts` file exists), but this step guards against any indirect dependency.

- [ ] **Step 4: Write the curated knowledge doc**

Create `docs/copilot-knowledge.md`. Every entry below reuses this app's own existing page copy (each
dashboard page's `page-subtitle` text) as its authoritative description, rather than inventing new
wording — the copilot should describe GameForge the same way GameForge already describes itself:

```markdown
# GameForge — what each feature does

You are the GameForge Copilot, answering questions about a local, two-person game-asset pipeline
tool. Answer from this doc and the live project state given to you below. If neither covers the
question, say so plainly and ask a clarifying question rather than guessing.

## Generate (`/dashboard/generate`)
Queue a new pixel-art sprite against a Style Bible. GameForge keeps every generation until you
promote it to an asset or discard it.

## UI Sheets (`/dashboard/ui-sheets`)
Place named pieces on a canvas, then generate one composite sheet from the whole layout — useful for
batching several related sprites (e.g. a full icon set) into one generation.

## Themes (`/dashboard/themes`)
Generate a website design token set (colors, typography, spacing) from a Style Bible. Supports
generating 1, 3, or 5 candidates at once, and an optional reference image to steer the result. Kept
until promoted or discarded, same as sprites.

## Components (`/dashboard/components`)
Generate a real HTML+CSS website component (button, card, nav bar) styled to a Style Bible. Same
review-and-promote flow as themes and sprites.

## Jobs (`/dashboard/jobs`)
Review what came back from a generation. Promote a keeper to an asset, discard a reject, or retry a
failed generation. A theme or component job can also be retried "with correction" when a local
Ollama model failed to produce structured output.

## Assets (`/dashboard/assets`)
Everything that's been promoted, ready to export to Godot (for sprites) or into a generated site
(for themes/components).

## Style Bibles (`/dashboard/styles`)
A Style Bible is the visual language every generation in it shares — its name, and the aesthetic
description/parameters every generation is steered by. Only its creator can edit one; anyone else
forks it into their own independent copy.

## Presets (`/dashboard/presets`)
A reusable recipe: a prompt, tech-stack labels, and a starting set of things to generate. Applying
one queues a theme (if set) and every listed component as one batch, optionally into a brand-new
Style Bible.

## Export (`/dashboard/export`)
Copies one Style Bible's active asset images into `storage/exports/` for a Godot project (2D only).
Separate from Site Export, which produces a hand-editable Next.js site from themes/components
instead.

## Drive (`/dashboard/drive`)
Browse, upload, and organize files in the team's shared Google Drive without leaving GameForge.

## Settings → Storage (`/dashboard/settings/storage`)
Generated files that no longer belong to any asset or in-flight job pile up in `storage/images/` and
`storage/themes/`. Clean them up here on demand — nothing runs automatically.

## Settings → Aseprite (`/dashboard/settings/aseprite`)
Sets the path to a local Aseprite executable so the "Edit in Aseprite" button on asset pages can
launch it. Machine-specific — never synced to git, so this has to be set on each machine separately.

## Settings → Seed Themes (`/dashboard/settings/seed-themes`)
Populates Style Bibles with ready-made themes pulled from DaisyUI and Bootswatch — real,
open-source, human-designed color/typography combinations, at zero generation cost. Safe to run
again later: already-imported themes are skipped, never duplicated.

## Settings → Google Drive (`/dashboard/settings/google-drive`)
Connects the Google account that owns the shared Drive — everyone using GameForge browses and shares
through this one connection.

## Settings → Ollama (`/dashboard/settings/ollama`)
Configures a local Ollama model as an alternative to Claude for theme, component, and page-layout
generation, and for the copilot itself. Lets you pull/manage models and test the connection. Ollama
has no built-in authentication — pointing it at a non-localhost host is a real trust decision, not
just a config choice.

## Choosing Claude vs. an Ollama model (applies to generation pages and this copilot)
Claude is a cloud model and costs API tokens; an installed Ollama model runs locally and is free, but
local models are noticeably less reliable at structured output (the "retry with correction" flow on
the Jobs page exists specifically for this). For a quick, low-stakes question, a local model is a
reasonable first choice; for something you want to get right the first time, Claude is the safer
pick.
```

- [ ] **Step 5: Write the failing test for buildCopilotSystemPrompt**

Create `test/copilotSystemPrompt.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { buildCopilotSystemPrompt } from '@/lib/services/copilotSystemPrompt';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotprompt-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'docs', 'copilot-knowledge.md'), '# Test knowledge doc\n\nThemes live at /dashboard/themes.');
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('buildCopilotSystemPrompt', () => {
  it('includes the knowledge doc, live project state, and the escalation instruction', async () => {
    const prompt = await buildCopilotSystemPrompt();
    expect(prompt).toContain('Themes live at /dashboard/themes.');
    expect(prompt).toContain('"styles"');
    expect(prompt).toContain('"inFlightJobs"');
    expect(prompt.toLowerCase()).toContain('clarifying question');
  });

  it('does not throw when the knowledge doc is missing -- falls back to an empty section', async () => {
    await fsPromises.rm(path.join(tempRoot, 'docs', 'copilot-knowledge.md'));
    const prompt = await buildCopilotSystemPrompt();
    expect(prompt).not.toContain('Themes live at /dashboard/themes.'); // the deleted file's own content must be gone, not silently cached
    expect(prompt).toContain('"styles"'); // the live-context section still assembles fine on its own
    expect(prompt).toContain('clarifying question');
  });
});
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `npx vitest run test/copilotSystemPrompt.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/copilotSystemPrompt'"

- [ ] **Step 7: Implement buildCopilotSystemPrompt**

Create `lib/services/copilotSystemPrompt.ts`:

```ts
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getProjectContextSummary } from '@/lib/services/projectContext';

const ESCALATION_INSTRUCTION = 'If the knowledge doc above and the live project state below don\'t clearly answer the question, say so plainly and ask a clarifying question instead of guessing -- never invent a GameForge feature, setting, or path that isn\'t described above.';

/**
 * Assembles the copilot's full system prompt fresh on every call (the live
 * project state below can change between messages, so this is never
 * cached across turns): the curated knowledge doc verbatim, the current
 * project state as JSON, then a fixed escalation instruction. See
 * docs/superpowers/specs/2026-09-13-dashboard-ai-copilot-design.md,
 * Section 3, for why this is a prompt-level instruction rather than a
 * computed confidence score.
 */
export async function buildCopilotSystemPrompt(): Promise<string> {
  let knowledgeDoc: string;
  try {
    knowledgeDoc = await fsPromises.readFile(path.join(getProjectRoot(), 'docs', 'copilot-knowledge.md'), 'utf-8');
  } catch (e) {
    console.error('Failed to read docs/copilot-knowledge.md:', e);
    knowledgeDoc = '';
  }

  const context = await getProjectContextSummary();

  return [
    knowledgeDoc,
    '## Current project state',
    JSON.stringify(context, null, 2),
    ESCALATION_INSTRUCTION,
  ].join('\n\n');
}
```

- [ ] **Step 8: Run the test, confirm it passes**

Run: `npx vitest run test/copilotSystemPrompt.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/services/projectContext.ts app/api/context/route.ts docs/copilot-knowledge.md lib/services/copilotSystemPrompt.ts test/copilotSystemPrompt.test.ts
git commit -m "feat: add copilot knowledge doc and system-prompt builder, extract getProjectContextSummary"
```

---

### Task 8: POST /api/copilot/message

**Files:**
- Create: `app/api/copilot/message/route.ts`
- Test: `test/copilotMessageRoute.test.ts`

**Interfaces:**
- Consumes: `copilotConversationService`/`copilotMessageService` (Task 2), `resolveClaudeProvider`/
  `callClaudeMessage` (Task 5), `callOllamaMessage` (Task 6), `buildNavigateTool`/
  `NavigateToPageInputSchema` (Task 4), `buildCopilotSystemPrompt` (Task 7).
- Produces: `POST /api/copilot/message` → `{success, data: {conversationId, reply: {text,
  toolCall?}}}`. Task 9's `CopilotPanel` calls this.

- [ ] **Step 1: Write the failing route test**

Create `test/copilotMessageRoute.test.ts`:

```ts
// test/copilotMessageRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { POST as sendMessage } from '@/app/api/copilot/message/route';

let tempRoot: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotmsgroute-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'docs', 'copilot-knowledge.md'), '# Test knowledge doc');
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/copilot/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/copilot/message', () => {
  it('requires login', async () => {
    const res = await sendMessage(req({ text: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('returns 503 with a clear message when Claude is selected but no key is configured', async () => {
    delete process.env.THEME_API_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CHEAPERINFERENCE_API_KEY;
    const { cookieHeader } = await seedSession();

    const res = await sendMessage(req({ text: 'How do themes work?' }, cookieHeader));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/isn't configured/);
  });

  it('creates a new conversation, calls Claude, and persists both sides of the turn', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key';
    delete process.env.THEME_API_PROVIDER;
    const { userId, cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Generate a theme from the Themes page.' }],
      stop_reason: 'end_turn',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({ text: 'How do themes work?' }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reply.text).toBe('Generate a theme from the Themes page.');
    expect(body.data.reply.toolCall).toBeUndefined();
    expect(body.data.conversationId).toBeTruthy();

    const conversations = await copilotConversationService.listForUser(userId);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe('How do themes work?');
  });

  it('calls Ollama when provider/model/ollamaHost are given, and navigates via a returned tool call', async () => {
    const { cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        content: "Here's the Ollama settings page.",
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/settings/ollama' } } }],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({
      text: 'Take me to the Ollama settings',
      provider: 'ollama',
      model: 'llama3-groq-tool-use:8b',
      ollamaHost: 'http://localhost:11434',
    }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reply.toolCall).toEqual({ name: 'navigate_to_page', input: { path: '/dashboard/settings/ollama' } });
  });

  it('rejects provider "ollama" without model/ollamaHost with a 400', async () => {
    const { cookieHeader } = await seedSession();
    const res = await sendMessage(req({ text: 'hi', provider: 'ollama' }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('drops a tool call whose path is outside the enum, but still returns the text reply', async () => {
    const { cookieHeader } = await seedSession();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      message: {
        content: 'Sure, heading there now.',
        tool_calls: [{ function: { name: 'navigate_to_page', arguments: { path: '/dashboard/jobs/123/edit' } } }],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessage(req({
      text: 'Take me to job 123',
      provider: 'ollama',
      model: 'llama3-groq-tool-use:8b',
      ollamaHost: 'http://localhost:11434',
    }, cookieHeader));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.reply.text).toBe('Sure, heading there now.');
    expect(body.data.reply.toolCall).toBeUndefined();
  });

  it('returns 403 when posting to another user\'s conversationId', async () => {
    const { userId: ownerId } = await seedSession('Alice');
    const { cookieHeader: otherCookie } = await seedSession('Bob');
    const convo = await copilotConversationService.create({ title: 'Alice only', createdBy: ownerId });

    const res = await sendMessage(req({ conversationId: convo.id, text: 'hi' }, otherCookie));
    expect(res.status).toBe(403);
  });

  it('returns 404 when posting to an unknown conversationId', async () => {
    const { cookieHeader } = await seedSession();
    const res = await sendMessage(req({ conversationId: '99999999-9999-9999-9999-999999999999', text: 'hi' }, cookieHeader));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/copilotMessageRoute.test.ts`
Expected: FAIL with "Cannot find module '@/app/api/copilot/message/route'"

- [ ] **Step 3: Implement the route**

Create `app/api/copilot/message/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { resolveClaudeProvider } from '@/lib/services/claudeApiProviders';
import { callClaudeMessage } from '@/lib/services/claudeToolCall';
import { callOllamaMessage } from '@/lib/services/ollamaToolCall';
import { buildNavigateTool, NavigateToPageInputSchema, type ProviderMessageResult } from '@/lib/services/copilotTool';
import { buildCopilotSystemPrompt } from '@/lib/services/copilotSystemPrompt';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

export const dynamic = 'force-dynamic';

const TITLE_MAX_LENGTH = 60;

const MessageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().min(1).max(4000),
  provider: z.enum(['claude', 'ollama']).optional(),
  model: z.string().min(1).optional(),
  ollamaHost: z.string().regex(/^https?:\/\//).optional(),
}).refine(
  input => input.provider !== 'ollama' || (!!input.model && !!input.ollamaHost),
  { message: 'model and ollamaHost are required when provider is "ollama"' }
);

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = MessageSchema.parse(await req.json());

    let conversationId = input.conversationId;
    if (conversationId) {
      const existing = await copilotConversationService.getById(conversationId);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 });
      }
      if (existing.created_by !== user.id) {
        return NextResponse.json({ success: false, error: 'You do not have access to this conversation' }, { status: 403 });
      }
    } else {
      const title = input.text.length > TITLE_MAX_LENGTH ? `${input.text.slice(0, TITLE_MAX_LENGTH)}…` : input.text;
      const created = await copilotConversationService.create({ title, createdBy: user.id });
      conversationId = created.id;
    }

    const priorMessages = await copilotMessageService.listByConversation(conversationId);
    await copilotMessageService.append({ conversationId, role: 'user', content: input.text });

    const tool = buildNavigateTool();
    const systemPrompt = await buildCopilotSystemPrompt();
    const turnMessages = [
      ...priorMessages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: input.text },
    ];

    let result: ProviderMessageResult;
    let providerUsed: 'claude' | 'ollama';
    let modelUsed: string;

    if (input.provider === 'ollama') {
      providerUsed = 'ollama';
      modelUsed = input.model!;
      try {
        result = await callOllamaMessage({
          host: input.ollamaHost!,
          model: input.model!,
          toolName: tool.name,
          toolDescription: tool.description,
          inputSchema: tool.inputSchema,
          messages: [{ role: 'system', content: systemPrompt }, ...turnMessages],
          operationLabel: 'copilot message',
          truncatedMessage: 'the reply could not be completed',
        });
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 502 });
      }
    } else {
      const resolved = resolveClaudeProvider();
      if ('error' in resolved) {
        return NextResponse.json({ success: false, error: resolved.error }, { status: 503 });
      }
      providerUsed = 'claude';
      modelUsed = resolved.provider.model;
      try {
        result = await callClaudeMessage({
          provider: resolved.provider,
          apiKey: resolved.apiKey,
          toolName: tool.name,
          toolDescription: tool.description,
          inputSchema: tool.inputSchema,
          messages: turnMessages,
          system: systemPrompt,
          operationLabel: 'copilot message',
          truncatedMessage: 'the reply could not be completed',
        });
      } catch (e: any) {
        // Same 502 treatment as the Ollama branch above -- a resolved,
        // configured provider that still fails mid-call (HTTP failure,
        // truncation) is a transient upstream problem, not the "isn't
        // configured" case resolveClaudeProvider() already caught as 503.
        return NextResponse.json({ success: false, error: e.message }, { status: 502 });
      }
    }

    let toolCall: { name: string; input: unknown } | undefined;
    if (result.toolCall) {
      const parsed = NavigateToPageInputSchema.safeParse(result.toolCall.input);
      if (parsed.success) {
        toolCall = { name: result.toolCall.name, input: parsed.data };
      }
      // An out-of-enum or malformed path is silently dropped -- the text reply still stands.
    }

    await copilotMessageService.append({
      conversationId,
      role: 'assistant',
      content: result.text,
      toolCall,
      provider: providerUsed,
      model: modelUsed,
    });
    await copilotConversationService.touch(conversationId);

    return NextResponse.json({ success: true, data: { conversationId, reply: { text: result.text, toolCall } } });
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

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/copilotMessageRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/copilot/message test/copilotMessageRoute.test.ts
git commit -m "feat: add POST /api/copilot/message"
```

---

### Task 9: CopilotPanel UI

**Files:**
- Create: `app/components/CopilotPanel.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `useCurrentUser` (existing), `useOllamaModels` (existing), `GET /api/copilot/conversations`,
  `GET /api/copilot/conversations/[id]`, `POST /api/copilot/message` (Tasks 3 and 8).
- Produces: `<CopilotPanel />`, mounted once at the root layout.

No automated test for this task — this codebase has zero React component rendering tests anywhere
(see Global Constraints); verification is manual, in a running dev server, per `AGENTS.md`'s own
instruction for UI work.

- [ ] **Step 1: Add the panel styles**

Append to `app/globals.css`:

```css
.copilot-toggle {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  z-index: 1000;
}

.copilot-panel {
  position: fixed;
  bottom: 84px;
  right: 24px;
  width: 360px;
  max-height: 70vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  overflow: hidden;
}

.copilot-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  color: var(--ink);
}

.copilot-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.copilot-message {
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 6px;
  white-space: pre-wrap;
  max-width: 85%;
}

.copilot-message-user {
  align-self: flex-end;
  background: var(--accent);
  color: var(--accent-ink);
}

.copilot-message-assistant {
  align-self: flex-start;
  background: var(--border);
  color: var(--ink);
}

.copilot-input-row {
  display: flex;
  gap: 6px;
  padding: 12px;
  border-top: 1px solid var(--border);
}

.copilot-input-row input {
  flex: 1;
}

.copilot-history {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.copilot-history-item {
  text-align: left;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ink);
  cursor: pointer;
}
```

- [ ] **Step 2: Build CopilotPanel**

Create `app/components/CopilotPanel.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';
import { useOllamaModels } from '@/lib/hooks/useOllamaModels';

interface PanelMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolCall?: { name: string; input: { path: string } };
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export function CopilotPanel() {
  const { user } = useCurrentUser();
  const router = useRouter();
  const { models: ollamaModels, host: ollamaHost } = useOllamaModels();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'chat' | 'history'>('chat');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<'claude' | string>('claude');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  if (!user) return null;

  async function handleOpenHistory() {
    setMode('history');
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/copilot/conversations');
      const body = await res.json();
      if (body.success) setHistory(body.data);
    } catch {
      // Non-fatal -- history just stays empty.
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleSelectConversation(id: string) {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/copilot/conversations/${id}`);
      const body = await res.json();
      if (body.success) {
        setConversationId(body.data.id);
        setMessages(body.data.messages);
        setMode('chat');
      }
    } catch {
      setError('Could not load that conversation.');
    } finally {
      setHistoryLoading(false);
    }
  }

  function handleNewChat() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setMode('chat');
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');

    try {
      const res = await fetch('/api/copilot/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          text,
          ...(provider !== 'claude' ? { provider: 'ollama', model: provider, ollamaHost } : {}),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'The copilot could not reply.');
        return;
      }
      setConversationId(body.data.conversationId);
      setMessages(prev => [...prev, { role: 'assistant', content: body.data.reply.text, toolCall: body.data.reply.toolCall }]);
      if (body.data.reply.toolCall?.name === 'navigate_to_page') {
        router.push(body.data.reply.toolCall.input.path);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button className="copilot-toggle" onClick={() => setOpen(o => !o)} aria-label="Toggle GameForge copilot">
        {open ? '×' : '?'}
      </button>
      {open && (
        <div className="copilot-panel">
          <div className="copilot-panel-header">
            <strong>GameForge Copilot</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={handleNewChat}>New chat</button>
              <button className="btn" onClick={handleOpenHistory}>History</button>
            </div>
          </div>

          {mode === 'history' ? (
            <div className="copilot-history">
              {historyLoading && <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>Loading…</p>}
              {!historyLoading && history.length === 0 && (
                <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>No previous conversations yet.</p>
              )}
              {history.map(c => (
                <button key={c.id} className="copilot-history-item" onClick={() => handleSelectConversation(c.id)}>
                  <div>{c.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{new Date(c.updatedAt).toLocaleString()}</div>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="copilot-messages">
                {messages.length === 0 && (
                  <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
                    Ask about any GameForge feature, setting, or what to try next on your current project.
                  </p>
                )}
                {messages.map((m, i) => (
                  <div key={m.id ?? i} className={`copilot-message copilot-message-${m.role}`}>
                    {m.content}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {error && <p style={{ color: 'var(--reject)', fontSize: 13, padding: '0 12px' }}>{error}</p>}

              <form className="copilot-input-row" onSubmit={handleSend}>
                <select value={provider} onChange={e => setProvider(e.target.value)} disabled={sending}>
                  <option value="claude">Claude</option>
                  {ollamaModels.map(m => <option key={m} value={m}>{m} (local)</option>)}
                </select>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Ask the copilot…"
                  disabled={sending}
                />
                <button className="btn btn-primary" type="submit" disabled={sending || !input.trim()}>
                  {sending ? '…' : 'Send'}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Mount it at the root layout**

In `app/layout.tsx`, import and render it alongside `NavRail`:

```tsx
import { NavRail } from '@/app/components/NavRail';
import { CopilotPanel } from '@/app/components/CopilotPanel';
```

```tsx
      <body>
        <div className="shell">
          <NavRail />
          <main className="main">{children}</main>
          <CopilotPanel />
        </div>
      </body>
```

- [ ] **Step 4: Run the full automated suite once more before manual verification**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all three clean — this task added no new automated tests, but must not have broken any
existing one, and must type-check and lint clean.

- [ ] **Step 5: Manually verify in a running dev server**

Run: `npm run dev`, open `http://localhost:3000/dashboard/generate` in a browser, logged in.

Check, in order:
1. A round floating button appears bottom-right on every dashboard page.
2. Clicking it opens the panel; typing a question and hitting Send shows the question immediately,
   then a reply (requires either `ANTHROPIC_API_KEY`/`CHEAPERINFERENCE_API_KEY` or an Ollama model
   actually configured in this environment — if neither is, confirm instead that the 503 error message
   renders cleanly instead of a blank/broken state).
3. Asking something like "take me to the Ollama settings" with a tool-capable model selected actually
   navigates the page.
4. Clicking "New chat" clears the panel; clicking "History" shows the just-created conversation;
   clicking it reloads that conversation's messages.
5. Reloading the browser, then reopening the panel and clicking History still shows the conversation
   (confirms persistence survived a full page reload, the entire point of Task 1-3 vs. the
   earlier-considered client-only design).

- [ ] **Step 6: Commit**

```bash
git add app/components/CopilotPanel.tsx app/layout.tsx app/globals.css
git commit -m "feat: add the CopilotPanel UI, mounted at the root layout"
```

---

## After all tasks: final verification

- [ ] Run `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts` one more time on the
  full branch.
- [ ] Re-read `docs/superpowers/specs/2026-09-13-dashboard-ai-copilot-design.md`'s "Follow-ups
  explicitly deferred" section — none of those are in scope for this plan; confirm nothing here
  accidentally implements or blocks them.
- [ ] Per `AGENTS.md` item 4: run a DeepSeek diff review (Mode 2) on the whole branch's diff before
  opening a PR, in addition to whatever per-task review already happened during execution.
