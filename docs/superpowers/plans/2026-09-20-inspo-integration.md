# Inspo Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two independent, loosely-coupled features backed by `github.com/Nutlope/inspo` (a
hosted archive of 2,320 real site pages/design tokens): (1) seed a new Style Bible from a real
site's extracted design tokens, and (2) opt-in reference-image grounding for component generation,
reusing GameForge's existing reference-image mechanism end to end.

**Architecture:** A new `lib/services/inspoClient.ts` is the single point of contact with Inspo's
two surfaces (a plain REST `GET` for one site's `DESIGN.md`, and the official
`@modelcontextprotocol/sdk` client for everything else). Feature 1 is a pure
`mapDesignMdToTokens()` mapper plus three new API routes, mirroring the existing W3C-tokens-import
pattern exactly. Feature 2 stamps a cheap boolean into job options at queue time and does the
actual grounding work in `worker.ts`, right next to the existing `loadReferenceImage()` call — no
new code path in the generation pipeline itself.

**Tech Stack:** Next.js App Router, TypeScript, Zod, better-sqlite3 (direct SQL), Vitest.
New dependency: `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-09-20-inspo-integration-design.md` (DeepSeek-reviewed across
7 rounds, `VERDICT: APPROVED`) — read it alongside this plan; the spec has the full reasoning
behind every decision below, this plan has the exact files and code.

## Global Constraints

- No wrapper classes, DTOs, factory patterns, or repository patterns — call `DatabaseConnection`
  directly with raw SQL, validate with Zod schemas directly (per `AGENTS.md`'s FORBIDDEN list).
- `try/catch` around every filesystem operation, with `console.error` logging on failure.
- `fsPromises.mkdir(dir, { recursive: true })` before every file write.
- `path.join(getProjectRoot(), ...)` for every physical path.
- Distinct `fs`/`fsPromises` imports when a file needs both sync and async calls — never alias one
  import to serve both.
- Every task's own verification must run all three of: `npx vitest run <path>`,
  `npx tsc --noEmit`, and `npx eslint app lib worker.ts` (scoped — a bare `npx eslint .` also sweeps
  other worktrees on this machine) — not just the first and third.
- Per this project's `AGENTS.md`, run a DeepSeek diff review (`~/.claude/skills/deepseek-review`,
  Mode 2) on each task's diff in addition to the Claude task-reviewer subagent — the two are not
  redundant (cross-model vs. same-model review). Triage every finding yourself before acting on it;
  DeepSeek has no filesystem access, so paste whatever file contents a finding needs to be judged
  against.
- UI-touching tasks (11, 20) require manual verification in a real browser per this project's own
  convention, in addition to their automated tests.
- New migrations are `017_add_ground_with_inspo_to_styles.sql` and
  `018_add_inspo_reference_cache.sql` — additive/forward-only, matching this codebase's existing
  migration runner (`lib/database/index.ts`), which applies every `.sql` file under
  `lib/database/migrations/` in sorted filename order and tracks what's applied in a `migrations`
  table.
- `ThemeTokensSchema`, `CSS_LENGTH_RE`, `CSS_COLOR_RE` live in `lib/services/themeTokens.ts` — reuse
  them; never redefine a parallel validation regex.

---

## File Structure

New files:
- `lib/services/inspoClient.ts` — slug/idx validation, `getDesignMd` (REST + bounded TTL cache),
  the singleton MCP client, `callMcpTool`, typed `searchScreens`/`recommend`/`getFilters`/
  `findComponents` wrappers, the component-type mapping table.
- `lib/services/themeImport/inspoImporter.ts` — `mapDesignMdToTokens()`, the WCAG contrast helper,
  and every DESIGN.md-parsing helper it needs.
- `lib/services/inspoGrounding.ts` — the grounding attempt worker.ts calls: cache lookup, SSRF
  guard, `find_components` call, crop download + validation, cache upsert, fail-soft wrapper.
- `app/api/inspo/preview/route.ts` — `POST`, Feature 1 preview.
- `app/api/inspo/search/route.ts` — `POST`, Feature 1 search/recommend/filters proxy.
- `app/api/styles/import-inspo/route.ts` — `POST`, Feature 1 commit.
- `lib/database/migrations/017_add_ground_with_inspo_to_styles.sql`
- `lib/database/migrations/018_add_inspo_reference_cache.sql`
- `test/inspoClient.test.ts`, `test/inspoImporter.test.ts`, `test/inspoPreviewRoute.test.ts`,
  `test/importInspoRoute.test.ts`, `test/inspoSearchRoute.test.ts`, `test/inspoGrounding.test.ts`,
  `test/workerGrounding.test.ts`, `test/inspoReferenceCache.test.ts`.

Modified files:
- `lib/database/schema.ts` — add `ground_with_inspo` to `StyleSchema`, add
  `InspoReferenceCacheSchema`.
- `lib/services/StyleService.ts` — `update()` accepts `groundWithInspo?: boolean`.
- `app/api/styles/[id]/route.ts` — `PUT` accepts `groundWithInspo`.
- `app/api/generate/route.ts` — accepts `componentType`, stamps it and `groundWithInspo` into job
  options.
- `worker.ts` — reads `options.componentType` and passes it to `ComponentGenerator.generate()`
  (currently always `undefined`); calls the new grounding step before the generator switch; writes
  `{grounded, groundedReason, ...}` back into the job's `options` on completion.
- `app/dashboard/styles/page.tsx` — new "Import from Inspo" panel.
- `app/dashboard/styles/[id]/page.tsx` — new `ground_with_inspo` toggle.
- `package.json` — add `@modelcontextprotocol/sdk`.

---

## Task 1: Add the MCP SDK dependency

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `@modelcontextprotocol/sdk` importable from `@modelcontextprotocol/sdk/client/index.js`
  and `@modelcontextprotocol/sdk/client/streamableHttp.js`.

- [ ] **Step 1: Install the package**

Run: `npm install @modelcontextprotocol/sdk`

- [ ] **Step 2: Verify it installed and typechecks cleanly**

Run: `npx tsc --noEmit`
Expected: no new errors (the package isn't imported anywhere yet, so this just confirms the
install didn't break anything).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency"
```

---

## Task 2: inspoClient.ts — slug/idx validation and getDesignMd

**Files:**
- Create: `lib/services/inspoClient.ts`
- Test: `test/inspoClient.test.ts`

**Interfaces:**
- Produces: `isValidInspoSlug(s: string): boolean`, `isValidInspoIdx(idx: number): boolean`,
  `getInspoBaseUrl(): string`, `getDesignMd(slug: string): Promise<string>`,
  `class InspoHttpError extends Error { status: number }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/inspoClient.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidInspoSlug, isValidInspoIdx, getDesignMd, InspoHttpError } from '@/lib/services/inspoClient';

describe('isValidInspoSlug', () => {
  it('accepts a plain lowercase-alnum-hyphen slug', () => {
    expect(isValidInspoSlug('acme-corp-homepage')).toBe(true);
    expect(isValidInspoSlug('a1')).toBe(true);
  });

  it('rejects traversal and injection shapes', () => {
    expect(isValidInspoSlug('../etc/passwd')).toBe(false);
    expect(isValidInspoSlug('foo%2fbar')).toBe(false);
    expect(isValidInspoSlug('foo/bar')).toBe(false);
    expect(isValidInspoSlug('foo?bar=1')).toBe(false);
    expect(isValidInspoSlug('Foo-Bar')).toBe(false); // uppercase rejected
    expect(isValidInspoSlug('')).toBe(false);
    expect(isValidInspoSlug('-leading-hyphen')).toBe(false);
    expect(isValidInspoSlug('a'.repeat(65))).toBe(false); // over length cap
  });
});

describe('isValidInspoIdx', () => {
  it('accepts a non-negative integer under the find_components limit', () => {
    expect(isValidInspoIdx(0)).toBe(true);
    expect(isValidInspoIdx(39)).toBe(true);
  });

  it('rejects negative, non-integer, or out-of-bound values', () => {
    expect(isValidInspoIdx(-1)).toBe(false);
    expect(isValidInspoIdx(40)).toBe(false); // the hard cap itself is out of range
    expect(isValidInspoIdx(1.5)).toBe(false);
    expect(isValidInspoIdx(NaN)).toBe(false);
  });
});

describe('getDesignMd', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fetches DESIGN.md for a valid slug and caches the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('# DESIGN.md content') });
    global.fetch = fetchMock as any;

    const first = await getDesignMd('acme-corp');
    const second = await getDesignMd('acme-corp');

    expect(first).toBe('# DESIGN.md content');
    expect(second).toBe('# DESIGN.md content');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
    expect(fetchMock).toHaveBeenCalledWith('https://inspo.test/api/design/acme-corp', expect.any(Object));
  });

  it('rejects an invalid slug before ever calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    await expect(getDesignMd('../etc/passwd')).rejects.toThrow(/invalid slug/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws InspoHttpError with the status on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') }) as any;
    await expect(getDesignMd('missing-site')).rejects.toBeInstanceOf(InspoHttpError);
    try {
      await getDesignMd('missing-site-2');
    } catch (e) {
      expect((e as InspoHttpError).status).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoClient.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/inspoClient'" (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/inspoClient.ts

// Slug shape is observational (matches what Inspo's own search results
// return as of 2026-09-20), not a fixed security policy — if real usage
// turns up legitimate slugs this rejects, widen the charset then. The
// enforcement itself is mandatory regardless of how the charset is tuned:
// every slug crosses into a URL path and (for grounding) a cache key, and
// this check is what makes that interpolation safe.
const INSPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidInspoSlug(s: string): boolean {
  return typeof s === 'string' && INSPO_SLUG_RE.test(s);
}

// find_components' own hard `limit` cap is 40 — bounding idx against that
// fixed cap, not a response's own self-reported result count, since a
// malicious/misbehaving response's own count field isn't a trustworthy bound.
const FIND_COMPONENTS_LIMIT = 40;

export function isValidInspoIdx(idx: number): boolean {
  return Number.isInteger(idx) && idx >= 0 && idx < FIND_COMPONENTS_LIMIT;
}

// Read lazily (matching PIXELLAB_API_KEY's lazy-getter precedent in
// ImageGenerator.ts) rather than as a module-level constant, so it's never
// evaluated before env vars land — a bare `tsx worker.ts` process doesn't
// auto-load .env.local the way `next dev` does.
export function getInspoBaseUrl(): string {
  return process.env.INSPO_BASE_URL || 'https://inspomcp.dev';
}

export class InspoHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'InspoHttpError';
    this.status = status;
  }
}

const DESIGN_MD_CACHE_TTL_MS = 10 * 60 * 1000;
const DESIGN_MD_CACHE_MAX_ENTRIES = 200;
const designMdCache = new Map<string, { content: string; fetchedAt: number }>();

function pruneDesignMdCacheIfNeeded(): void {
  if (designMdCache.size < DESIGN_MD_CACHE_MAX_ENTRIES) return;
  // Map iteration order is insertion order — the first key is the oldest.
  const oldestKey = designMdCache.keys().next().value;
  if (oldestKey !== undefined) designMdCache.delete(oldestKey);
}

const DESIGN_MD_FETCH_DEADLINE_MS = 2000;

/**
 * Fetches one site's DESIGN.md as raw markdown via Inspo's plain,
 * unauthenticated REST endpoint. Cached in-memory per process for
 * DESIGN_MD_CACHE_TTL_MS so opening the preview panel and clicking the same
 * result twice doesn't spend the shared rate-limit budget twice — staleness
 * cost is just "an extra live fetch" on a process restart, not correctness.
 */
export async function getDesignMd(slug: string): Promise<string> {
  if (!isValidInspoSlug(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const cached = designMdCache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < DESIGN_MD_CACHE_TTL_MS) {
    return cached.content;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DESIGN_MD_FETCH_DEADLINE_MS);
  let res: Response;
  try {
    res = await fetch(`${getInspoBaseUrl()}/api/design/${slug}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new InspoHttpError(res.status, `Inspo returned ${res.status} for slug "${slug}"`);
  }

  const content = await res.text();
  pruneDesignMdCacheIfNeeded();
  designMdCache.set(slug, { content, fetchedAt: Date.now() });
  return content;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoClient.test.ts`
Expected: PASS (all cases in this file).

- [ ] **Step 5: Run typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/inspoClient.ts test/inspoClient.test.ts
git commit -m "feat: add Inspo slug validation and DESIGN.md fetch with TTL cache"
```

---

## Task 3: inspoClient.ts — MCP singleton client and callMcpTool

**Files:**
- Modify: `lib/services/inspoClient.ts`
- Test: `test/inspoClient.test.ts` (append)

**Interfaces:**
- Consumes: `getInspoBaseUrl()` from Task 2.
- Produces: `callMcpTool<T>(name: string, args: Record<string, unknown>, deadlineMs: number): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to test/inspoClient.test.ts
import { callMcpTool } from '@/lib/services/inspoClient';

describe('callMcpTool', () => {
  // The MCP Client/transport are mocked at the module level so these tests
  // exercise callMcpTool's own deadline/reconnect logic, not the real SDK
  // handshake (that's covered by the recorded-fixture contract test in
  // Task 4's test file, run against a real captured response shape).
  it('resolves with the tool result on success', async () => {
    const mockClient = { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }) };
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => mockClient),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
      StreamableHTTPClientTransport: vi.fn(() => ({})),
    }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');
    mockClient.callTool.mockClear();
    (mockClient as any).connect = vi.fn().mockResolvedValue(undefined);

    const result = await freshCallMcpTool<{ ok: boolean }>('search_screens', { query: 'test' }, 3000);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when the call exceeds its deadline', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise(() => {});
    const mockClient = { callTool: vi.fn().mockReturnValue(neverResolves), connect: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn(() => mockClient) }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.resetModules();
    const { callMcpTool: freshCallMcpTool } = await import('@/lib/services/inspoClient');

    const callPromise = freshCallMcpTool('search_screens', {}, 1000);
    const assertion = expect(callPromise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoClient.test.ts`
Expected: FAIL — `callMcpTool` is not exported yet.

- [ ] **Step 3: Write the implementation**

```typescript
// Append to lib/services/inspoClient.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Lazily-created, per-process singleton — not a fresh connection per call.
// The initialize handshake and Mcp-Session-Id happen once and are reused
// across search/recommend/find_components calls for the process's
// lifetime, so a logical tool call costs one tools/call round trip against
// the shared rate limit in the common case, not the full 2-4-round-trip
// handshake every time.
let clientPromise: Promise<Client> | null = null;

function createClient(): Promise<Client> {
  return (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${getInspoBaseUrl()}/api/mcp`));
    const client = new Client({ name: 'gameforge', version: '1.0.0' });
    await client.connect(transport);
    return client;
  })();
}

function getClient(): Promise<Client> {
  if (!clientPromise) clientPromise = createClient();
  return clientPromise;
}

// Test-only: forces the next getClient() call to reconnect, matching what
// resetForTests()-style helpers do elsewhere in this codebase.
export function resetInspoClientForTests(): void {
  clientPromise = null;
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Inspo MCP call timed out after ${deadlineMs}ms`)), deadlineMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

function isSessionInvalidError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session/i.test(message) && /(invalid|expired|not found)/i.test(message);
}

/**
 * Calls one MCP tool by name against the shared singleton client. The whole
 * attempt (handshake-if-needed + the tools/call itself) is bounded by
 * deadlineMs. If the call fails with a session-invalid/expired error, this
 * reconnects (re-runs initialize) once and retries — inside the SAME
 * deadline, not a fresh one, since a genuinely timed-out call has already
 * exhausted its budget and isn't retried at all.
 */
export async function callMcpTool<T>(name: string, args: Record<string, unknown>, deadlineMs: number): Promise<T> {
  const deadline = Date.now() + deadlineMs;

  async function attempt(): Promise<T> {
    const client = await getClient();
    const remaining = Math.max(0, deadline - Date.now());
    const result = await withDeadline(client.callTool({ name, arguments: args }) as Promise<any>, remaining);
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`Inspo MCP tool "${name}" returned an unexpected shape`);
    }
    return JSON.parse(text) as T;
  }

  try {
    return await attempt();
  } catch (error) {
    if (isSessionInvalidError(error) && Date.now() < deadline) {
      clientPromise = null;
      return attempt();
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors. If `@modelcontextprotocol/sdk`'s actual exported types differ from the shape
assumed above (`client.callTool({name, arguments}): Promise<{content: [{type, text}]}>`), fix the
call site to match what `npx tsc --noEmit` reports — the installed package's own `.d.ts` files
under `node_modules/@modelcontextprotocol/sdk/dist/` are the source of truth, not this plan.

- [ ] **Step 6: Commit**

```bash
git add lib/services/inspoClient.ts test/inspoClient.test.ts
git commit -m "feat: add singleton MCP client with deadline and reconnect-on-invalidation"
```

---

## Task 4: inspoClient.ts — search/recommend/find_components wrappers and the component-type map

**Files:**
- Modify: `lib/services/inspoClient.ts`
- Test: `test/inspoClient.test.ts` (append)

**Interfaces:**
- Consumes: `callMcpTool<T>()` from Task 3, `isValidInspoIdx()` from Task 2.
- Produces: `searchScreens(args)`, `recommend(brief: string)`, `getFilters()`,
  `findComponents(args): Promise<InspoComponentResult[]>`,
  `INSPO_TYPE_FOR_COMPONENT_TYPE: Record<string, string | null>`,
  `type InspoComponentResult = { imageUrl: string; fallback: boolean }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to test/inspoClient.test.ts
describe('INSPO_TYPE_FOR_COMPONENT_TYPE', () => {
  it('maps every real GameForge component type, including the loose ones', async () => {
    const { INSPO_TYPE_FOR_COMPONENT_TYPE } = await import('@/lib/services/inspoClient');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Button).toBe('cta');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE['Nav Bar']).toBe('nav');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Card).toBe('features');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Form).toBe('cta');
    expect(INSPO_TYPE_FOR_COMPONENT_TYPE.Other).toBeNull();
  });
});

describe('findComponents', () => {
  it('builds a crop image URL for a non-fallback result', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ results: [{ slug: 'acme-corp', idx: 2, fallback: false }] }) }] }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results).toEqual([{ imageUrl: 'https://inspo.test/api/component/acme-corp/2', fallback: false }]);
  });

  it('falls back to a whole-page thumbnail URL when fallback:true', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ results: [{ slug: 'acme-corp', idx: 0, fallback: true }] }) }] }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results[0].fallback).toBe(true);
  });

  it('drops a result whose slug fails validation rather than building an unsafe URL', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ results: [{ slug: '../etc', idx: 0, fallback: false }, { slug: 'acme-corp', idx: 0, fallback: false }] }) }] }),
      })),
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn(() => ({})) }));
    vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
    vi.resetModules();
    const { findComponents } = await import('@/lib/services/inspoClient');

    const results = await findComponents({ type: 'cta' });
    expect(results).toHaveLength(1);
    expect(results[0].imageUrl).toContain('acme-corp');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoClient.test.ts`
Expected: FAIL — `INSPO_TYPE_FOR_COMPONENT_TYPE` and `findComponents` are not exported yet.

- [ ] **Step 3: Write the implementation**

```typescript
// Append to lib/services/inspoClient.ts

// None of these four mappings is a clean match — Inspo's 10 crop types
// don't line up with GameForge's 5 component types. Button->cta is
// arguably the loosest of the four (a cta crop is typically a whole
// headline+button+image band, not an isolated button) despite being the
// most common component type; it gets no special treatment here because
// none of the mapped entries should read as more confident than another.
export const INSPO_TYPE_FOR_COMPONENT_TYPE: Record<string, string | null> = {
  Button: 'cta',
  'Nav Bar': 'nav',
  Card: 'features', // Inspo has no unified card category; features crops are often a multi-card grid
  Form: 'cta', // inline-form-as-CTA is a named archetype; no first-class Form type exists
  Other: null,
};

export interface InspoComponentResult {
  imageUrl: string;
  fallback: boolean;
}

const SEARCH_DEADLINE_MS = 3000;

export function searchScreens(args: Record<string, unknown>): Promise<unknown> {
  return callMcpTool('search_screens', args, SEARCH_DEADLINE_MS);
}

export function recommend(brief: string): Promise<unknown> {
  return callMcpTool('recommend', { brief }, SEARCH_DEADLINE_MS);
}

export function getFilters(): Promise<unknown> {
  return callMcpTool('get_filters', {}, SEARCH_DEADLINE_MS);
}

interface RawFindComponentsResult {
  slug: string;
  idx: number;
  fallback: boolean;
}

/**
 * Wraps find_components: builds the crop image URL for every result whose
 * slug/idx pass validation, and silently drops any that don't rather than
 * building a URL from unvalidated remote data. deadlineMs is the caller's
 * to set — Feature 1's UI calls use SEARCH_DEADLINE_MS-equivalent budgets,
 * Feature 2's grounding path uses a tighter one (see inspoGrounding.ts).
 */
export async function findComponents(
  args: { type: string; color?: string } & Record<string, unknown>,
  deadlineMs: number = SEARCH_DEADLINE_MS
): Promise<InspoComponentResult[]> {
  const response = await callMcpTool<{ results: RawFindComponentsResult[] }>('find_components', args, deadlineMs);
  const baseUrl = getInspoBaseUrl();
  const out: InspoComponentResult[] = [];
  for (const r of response.results ?? []) {
    if (!isValidInspoSlug(r.slug) || !isValidInspoIdx(r.idx)) continue;
    out.push({ imageUrl: `${baseUrl}/api/component/${r.slug}/${r.idx}`, fallback: !!r.fallback });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoClient.test.ts`
Expected: PASS — all describe blocks in this file.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/inspoClient.ts test/inspoClient.test.ts
git commit -m "feat: add Inspo search/recommend/find_components wrappers and component-type map"
```

---

## Task 5: inspoImporter.ts — WCAG contrast helper and color-role mapping

**Files:**
- Create: `lib/services/themeImport/inspoImporter.ts`
- Test: `test/inspoImporter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure module).
- Produces: `contrastRatio(hexA: string, hexB: string): number`,
  `type DesignMdColorSwatch = { hex: string; role: string }`,
  `parseColorsSection(designMd: string): DesignMdColorSwatch[]`,
  `parseHeaderSection(designMd: string): { mode: 'light' | 'dark' | null; capturedAt: string | null }`.

DESIGN.md's actual generated shape (verified against `packages/db/src/design-md.ts` in
`github.com/Nutlope/inspo`, 2026-09-20 — re-verify against a live fetch if this drifts):
- Header lines: `` - **Source:** <url> ``, `` - **Captured:** <date> ``, `` - **Mode:** <light|dark> ``,
  `` - **Macrostructure:** <label> ``.
- `## Colors` heading, then a markdown table: `` | Hex | Role (heuristic) | `` header row,
  `` |---|---| `` separator, then rows like `` | `#3b82f6` | accent | ``.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/inspoImporter.test.ts
import { describe, it, expect } from 'vitest';
import { contrastRatio, parseColorsSection, parseHeaderSection } from '@/lib/services/themeImport/inspoImporter';

describe('contrastRatio', () => {
  it('returns the maximum ratio (21) for pure black vs pure white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#111111', '#eeeeee')).toBeCloseTo(contrastRatio('#eeeeee', '#111111'), 5);
  });
});

describe('parseHeaderSection', () => {
  it('extracts mode and captured date from the Header lines', () => {
    const md = [
      '# DESIGN.md',
      '- **Source:** https://acme.example',
      '- **Captured:** 2026-08-01T00:00:00Z',
      '- **Mode:** dark',
      '- **Macrostructure:** marketing',
      '',
      '## Tone',
    ].join('\n');
    expect(parseHeaderSection(md)).toEqual({ mode: 'dark', capturedAt: '2026-08-01T00:00:00Z' });
  });

  it('returns nulls when the Header lines are absent', () => {
    expect(parseHeaderSection('## Colors\n')).toEqual({ mode: null, capturedAt: null });
  });
});

describe('parseColorsSection', () => {
  it('parses hex + role rows out of the Colors table', () => {
    const md = [
      '## Colors',
      '',
      '| Hex | Role (heuristic) |',
      '|---|---|',
      '| `#ffffff` | surface |',
      '| `#111111` | ink |',
      '| `#3b82f6` | accent |',
      '| `#e5e7eb` | support |',
      '',
      '## Typography',
    ].join('\n');
    expect(parseColorsSection(md)).toEqual([
      { hex: '#ffffff', role: 'surface' },
      { hex: '#111111', role: 'ink' },
      { hex: '#3b82f6', role: 'accent' },
      { hex: '#e5e7eb', role: 'support' },
    ]);
  });

  it('returns an empty array when the Colors section is absent', () => {
    expect(parseColorsSection('## Tone\nsomething\n')).toEqual([]);
  });

  it('does not read past the next section heading', () => {
    const md = [
      '## Colors',
      '| Hex | Role (heuristic) |',
      '|---|---|',
      '| `#ffffff` | surface |',
      '## Typography',
      '| `#000000` | ink |', // malformed table row that happens to appear after the next heading
    ].join('\n');
    expect(parseColorsSection(md)).toEqual([{ hex: '#ffffff', role: 'surface' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoImporter.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/themeImport/inspoImporter.ts

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function srgbChannelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** Standard WCAG contrast ratio (1 to 21) between two hex colors. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface DesignMdColorSwatch {
  hex: string;
  role: string;
}

/** Slices the body of a `## <heading>` markdown section out of a full DESIGN.md, stopping at the next `## ` heading (or end of document). Returns '' if the heading isn't present. */
function sliceSection(designMd: string, heading: string): string {
  const headingRe = new RegExp(`^## ${heading}\\s*$`, 'm');
  const match = headingRe.exec(designMd);
  if (!match) return '';
  const startOfBody = match.index + match[0].length;
  const rest = designMd.slice(startOfBody);
  const nextHeadingMatch = /^## /m.exec(rest);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

const COLOR_ROW_RE = /^\|\s*`?(#[0-9a-fA-F]{3,8})`?\s*\|\s*([^|]+?)\s*\|\s*$/gm;

export function parseColorsSection(designMd: string): DesignMdColorSwatch[] {
  const body = sliceSection(designMd, 'Colors');
  if (!body) return [];
  const out: DesignMdColorSwatch[] = [];
  for (const match of body.matchAll(COLOR_ROW_RE)) {
    out.push({ hex: match[1].toLowerCase(), role: match[2].trim().toLowerCase() });
  }
  return out;
}

export function parseHeaderSection(designMd: string): { mode: 'light' | 'dark' | null; capturedAt: string | null } {
  const modeMatch = /^-\s*\*\*Mode:\*\*\s*(.+)$/m.exec(designMd);
  const capturedMatch = /^-\s*\*\*Captured:\*\*\s*(.+)$/m.exec(designMd);
  const rawMode = modeMatch?.[1]?.trim().toLowerCase();
  return {
    mode: rawMode === 'dark' ? 'dark' : rawMode === 'light' ? 'light' : null,
    capturedAt: capturedMatch?.[1]?.trim() ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoImporter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/themeImport/inspoImporter.ts test/inspoImporter.test.ts
git commit -m "feat: add WCAG contrast helper and DESIGN.md header/colors parsing"
```

---

## Task 6: inspoImporter.ts — mapDesignMdToTokens (full mapper)

**Files:**
- Modify: `lib/services/themeImport/inspoImporter.ts`
- Test: `test/inspoImporter.test.ts` (append)

**Interfaces:**
- Consumes: `contrastRatio`, `parseColorsSection`, `parseHeaderSection` from Task 5;
  `ThemeTokensSchema`, `ThemeTokens` from `lib/services/themeTokens.ts`.
- Produces: `type FieldProvenance = Record<keyof ThemeTokens, 'css-var' | 'heuristic' | 'default'>`,
  `type MapDesignMdResult = { success: true; tokens: ThemeTokens; provenance: FieldProvenance;
  lowConfidence: boolean; capturedAt: string | null } | { success: false; error: string }`,
  `mapDesignMdToTokens(designMd: string): MapDesignMdResult`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to test/inspoImporter.test.ts
import { mapDesignMdToTokens } from '@/lib/services/themeImport/inspoImporter';

const RICH_LIGHT_MODE_DESIGN_MD = [
  '# DESIGN.md',
  '- **Source:** https://acme.example',
  '- **Captured:** 2026-08-01T00:00:00Z',
  '- **Mode:** light',
  '',
  '## Colors',
  '| Hex | Role (heuristic) |',
  '|---|---|',
  '| `#ffffff` | surface |',
  '| `#111111` | ink |',
  '| `#3b82f6` | accent |',
  '| `#e5e7eb` | support |',
  '| `#9ca3af` | muted |',
  '',
  '## Typography',
  'Detected typefaces: **Inter**, **Georgia**',
  '',
  '## Spacing scale',
  '`4px` · `8px` · `16px` · `24px`',
  'Base step looks like **8px**.',
  '',
  '## Border radius',
  '`6px` · `12px`',
].join('\n');

const DARK_MODE_DESIGN_MD = RICH_LIGHT_MODE_DESIGN_MD.replace('**Mode:** light', '**Mode:** dark');

const MOSTLY_EMPTY_DESIGN_MD = '# DESIGN.md\n- **Source:** https://empty.example\n';

const ONE_FONT_DESIGN_MD = RICH_LIGHT_MODE_DESIGN_MD.replace('Detected typefaces: **Inter**, **Georgia**', 'Detected typefaces: **Inter**');

describe('mapDesignMdToTokens', () => {
  it('maps a rich light-mode DESIGN.md using the heuristic color roles', () => {
    const result = mapDesignMdToTokens(RICH_LIGHT_MODE_DESIGN_MD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.tokens.colorBackground).toBe('#ffffff');
    expect(result.tokens.colorForeground).toBe('#111111');
    expect(result.tokens.colorAccent).toBe('#3b82f6');
    expect(result.tokens.fontHeading).toBe('Inter');
    expect(result.tokens.fontBody).toBe('Georgia');
    expect(result.tokens.spaceUnit).toBe('8px');
    expect(result.tokens.radiusBase).toBe('6px');
    expect(result.lowConfidence).toBe(false);
    expect(result.capturedAt).toBe('2026-08-01T00:00:00Z');
    expect(result.provenance.colorBackground).toBe('heuristic');
  });

  it('inverts background/foreground role assignment in dark mode', () => {
    const light = mapDesignMdToTokens(RICH_LIGHT_MODE_DESIGN_MD);
    const dark = mapDesignMdToTokens(DARK_MODE_DESIGN_MD);
    if (!light.success || !dark.success) throw new Error('setup failed');
    // Same swatches, opposite mode -> opposite background/foreground pick.
    expect(dark.tokens.colorBackground).toBe(light.tokens.colorForeground);
    expect(dark.tokens.colorForeground).toBe(light.tokens.colorBackground);
  });

  it('picks the lowest-contrast support/muted swatch for colorBorder, not the first one', () => {
    // support (#e5e7eb) has lower contrast against white than muted (#9ca3af) here,
    // so colorBorder should be the support swatch, not simply "first listed".
    const result = mapDesignMdToTokens(RICH_LIGHT_MODE_DESIGN_MD);
    if (!result.success) throw new Error('setup failed');
    expect(result.tokens.colorBorder).toBe('#e5e7eb');
  });

  it('reuses a single detected font for both heading and body', () => {
    const result = mapDesignMdToTokens(ONE_FONT_DESIGN_MD);
    if (!result.success) throw new Error('setup failed');
    expect(result.tokens.fontHeading).toBe('Inter');
    expect(result.tokens.fontBody).toBe('Inter');
  });

  it('sets lowConfidence when more than half the fields default', () => {
    const result = mapDesignMdToTokens(MOSTLY_EMPTY_DESIGN_MD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.lowConfidence).toBe(true);
    expect(Object.values(result.provenance).filter(t => t === 'default').length).toBeGreaterThan(4);
  });

  it('never lets raw DESIGN.md prose reach the returned tokens (untrusted-text invariant)', () => {
    const maliciousProse = "'; } body { background: url(https://evil.example/steal) } .x {";
    const md = RICH_LIGHT_MODE_DESIGN_MD + `\n## Tone\n${maliciousProse}\n`;
    const result = mapDesignMdToTokens(md);
    if (!result.success) throw new Error('setup failed');
    const serialized = JSON.stringify(result.tokens);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('background:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoImporter.test.ts`
Expected: FAIL — `mapDesignMdToTokens` is not exported yet.

- [ ] **Step 3: Write the implementation**

```typescript
// Append to lib/services/themeImport/inspoImporter.ts
import { ThemeTokensSchema, type ThemeTokens } from '@/lib/services/themeTokens';

export type FieldProvenance = Record<keyof ThemeTokens, 'css-var' | 'heuristic' | 'default'>;

export type MapDesignMdResult =
  | { success: true; tokens: ThemeTokens; provenance: FieldProvenance; lowConfidence: boolean; capturedAt: string | null }
  | { success: false; error: string };

const DEFAULT_TOKEN_VALUES: ThemeTokens = {
  colorBackground: '#ffffff',
  colorForeground: '#111111',
  colorAccent: '#3b82f6',
  colorBorder: '#e5e7eb',
  fontHeading: 'system-ui, sans-serif',
  fontBody: 'system-ui, sans-serif',
  spaceUnit: '8px',
  radiusBase: '4px',
};

function parseCssVarBlock(designMd: string): Map<string, string> {
  const out = new Map<string, string>();
  const fenceMatch = /```css\s*\n:root\s*\{([\s\S]*?)\}\s*\n```/.exec(designMd);
  if (!fenceMatch) return out;
  const body = fenceMatch[1];
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

const CSS_VAR_NAME_ALIASES: Record<keyof ThemeTokens, string[]> = {
  colorBackground: ['--bg', '--background', '--surface', '--paper'],
  colorForeground: ['--fg', '--foreground', '--text', '--ink'],
  colorAccent: ['--accent', '--primary', '--brand'],
  colorBorder: ['--border', '--outline', '--divider'],
  fontHeading: ['--font-heading', '--heading-font', '--font-display'],
  fontBody: ['--font-body', '--body-font', '--font-base'],
  spaceUnit: ['--space-unit', '--spacing', '--space'],
  radiusBase: ['--radius', '--radius-base', '--border-radius'],
};

function tryCssVarTier(cssVars: Map<string, string>, field: keyof ThemeTokens): string | null {
  for (const alias of CSS_VAR_NAME_ALIASES[field]) {
    const value = cssVars.get(alias);
    if (value === undefined) continue;
    const singleFieldSchema = ThemeTokensSchema.shape[field];
    const validated = singleFieldSchema.safeParse(value);
    if (validated.success) return validated.data as string;
  }
  return null;
}

function parseTypography(designMd: string): string[] {
  const body = sliceSection(designMd, 'Typography');
  const match = /Detected typefaces:\s*(.+)$/m.exec(body);
  if (!match) return [];
  const faces: string[] = [];
  for (const m of match[1].matchAll(/\*\*(.+?)\*\*/g)) {
    faces.push(m[1].trim());
  }
  return faces;
}

function parseSpacingBaseUnit(designMd: string): number | null {
  const body = sliceSection(designMd, 'Spacing scale');
  const match = /Base step looks like \*\*(\d+)px\*\*/.exec(body);
  return match ? Number(match[1]) : null;
}

function parseFirstRadiusPx(designMd: string): number | null {
  const body = sliceSection(designMd, 'Border radius');
  const match = /`(\d+)px`/.exec(body);
  return match ? Number(match[1]) : null;
}

function pickRoleSwatch(swatches: DesignMdColorSwatch[], role: string): string | null {
  const found = swatches.find(s => s.role === role);
  return found ? found.hex : null;
}

/**
 * mapDesignMdToTokens: turns raw DESIGN.md markdown into a validated
 * ThemeTokens object. Preference order per field, matching DESIGN.md's own
 * stated signal quality: (1) a validated CSS custom-property value from the
 * fenced :root block, if a name match happens to exist AND validate — this
 * is opportunistic, not primary, since real sites have no shared variable
 * naming convention; (2) the Colors table's heuristic role guess, always
 * available and mode-aware; (3) a fixed default. A field never fails the
 * whole import — it always resolves to SOME value, with its tier recorded
 * in `provenance`. Invariant: nothing here ever returns raw DESIGN.md prose
 * — every value that survives has already passed ThemeTokensSchema's
 * allowlist regex.
 */
export function mapDesignMdToTokens(designMd: string): MapDesignMdResult {
  const { mode, capturedAt } = parseHeaderSection(designMd);
  const swatches = parseColorsSection(designMd);
  const cssVars = parseCssVarBlock(designMd);

  const provenance = {} as FieldProvenance;
  const tokens = {} as Record<keyof ThemeTokens, string>;

  function resolve(field: keyof ThemeTokens, heuristicValue: string | null): void {
    const cssVarValue = tryCssVarTier(cssVars, field);
    if (cssVarValue !== null) {
      tokens[field] = cssVarValue;
      provenance[field] = 'css-var';
      return;
    }
    if (heuristicValue !== null) {
      const validated = ThemeTokensSchema.shape[field].safeParse(heuristicValue);
      if (validated.success) {
        tokens[field] = validated.data as string;
        provenance[field] = 'heuristic';
        return;
      }
    }
    tokens[field] = DEFAULT_TOKEN_VALUES[field];
    provenance[field] = 'default';
  }

  // guessRole() (Inspo's own algorithm) already accounts for mode internally
  // when it assigns role LABELS, but the roles it hands us here are named
  // by luminance position (lightest/darkest), not by "background"/
  // "foreground" semantics — so which physical role becomes GameForge's
  // colorBackground vs colorForeground still depends on mode: in light
  // mode the surface (lightest) role is the background; in dark mode the
  // ink (darkest) role plays that part instead.
  const surfaceHex = pickRoleSwatch(swatches, 'surface');
  const inkHex = pickRoleSwatch(swatches, 'ink');
  const backgroundHeuristic = mode === 'dark' ? inkHex : surfaceHex;
  const foregroundHeuristic = mode === 'dark' ? surfaceHex : inkHex;

  resolve('colorBackground', backgroundHeuristic);
  resolve('colorForeground', foregroundHeuristic);
  resolve('colorAccent', pickRoleSwatch(swatches, 'accent'));

  const borderCandidates = swatches.filter(s => s.role === 'support' || s.role === 'muted');
  let colorBorderHeuristic: string | null = null;
  if (borderCandidates.length > 0 && tokens.colorBackground) {
    let lowestContrast = Infinity;
    for (const candidate of borderCandidates) {
      const ratio = contrastRatio(candidate.hex, tokens.colorBackground);
      if (ratio < lowestContrast) {
        lowestContrast = ratio;
        colorBorderHeuristic = candidate.hex;
      }
    }
  }
  resolve('colorBorder', colorBorderHeuristic);

  const fonts = parseTypography(designMd);
  resolve('fontHeading', fonts[0] ?? null);
  resolve('fontBody', fonts[1] ?? fonts[0] ?? null);

  const baseUnit = parseSpacingBaseUnit(designMd);
  resolve('spaceUnit', baseUnit !== null ? `${baseUnit}px` : null);

  const firstRadius = parseFirstRadiusPx(designMd);
  resolve('radiusBase', firstRadius !== null ? `${firstRadius}px` : null);

  const validated = ThemeTokensSchema.safeParse(tokens);
  if (!validated.success) {
    // Should be unreachable given every field above already validates
    // before being accepted — kept as a hard boundary in case a future
    // field addition forgets to route through resolve().
    return { success: false, error: `Mapped tokens failed final validation: ${validated.error.message}` };
  }

  const defaultCount = Object.values(provenance).filter(t => t === 'default').length;
  const lowConfidence = defaultCount > 4;

  return { success: true, tokens: validated.data, provenance, lowConfidence, capturedAt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoImporter.test.ts`
Expected: PASS — all describe blocks.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/themeImport/inspoImporter.ts test/inspoImporter.test.ts
git commit -m "feat: add mapDesignMdToTokens with provenance and low-confidence detection"
```

---

## Task 7: Route — POST /api/inspo/preview

**Files:**
- Create: `app/api/inspo/preview/route.ts`
- Test: `test/inspoPreviewRoute.test.ts`

**Interfaces:**
- Consumes: `isValidInspoSlug`, `getDesignMd`, `InspoHttpError` from `inspoClient.ts`;
  `mapDesignMdToTokens` from `inspoImporter.ts`; `getCurrentUser` from `lib/utils/session.ts`.
- Produces: `POST` handler returning `{success:true, data:{tokens, provenance, lowConfidence,
  capturedAt}}` or `{success:false, error}`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/inspoPreviewRoute.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-inspopreview-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.stubEnv('INSPO_BASE_URL', 'https://inspo.test');
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/inspo/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

const VALID_DESIGN_MD = [
  '- **Captured:** 2026-08-01T00:00:00Z',
  '- **Mode:** light',
  '## Colors',
  '| Hex | Role (heuristic) |',
  '|---|---|',
  '| `#ffffff` | surface |',
  '| `#111111` | ink |',
  '| `#3b82f6` | accent |',
].join('\n');

describe('POST /api/inspo/preview', () => {
  it('requires login', async () => {
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: 'acme-corp' }));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid slug with a 400 before ever fetching', async () => {
    const { cookieHeader } = await seedSession();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: '../etc/passwd' }, cookieHeader));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns mapped tokens, provenance, and lowConfidence for a valid slug', async () => {
    const { cookieHeader } = await seedSession();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(VALID_DESIGN_MD) }) as any;
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: 'acme-corp' }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.tokens.colorAccent).toBe('#3b82f6');
    expect(body.data.provenance.colorAccent).toBe('heuristic');
    expect(typeof body.data.lowConfidence).toBe('boolean');
  });

  it('returns a 4xx with a distinct message when Inspo 404s', async () => {
    const { cookieHeader } = await seedSession();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') }) as any;
    const { POST } = await import('@/app/api/inspo/preview/route');
    const res = await POST(req({ slug: 'missing-site' }, cookieHeader));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = await res.json();
    expect(body.error).toMatch(/404|not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoPreviewRoute.test.ts`
Expected: FAIL — route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/inspo/preview/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { isValidInspoSlug, getDesignMd, InspoHttpError } from '@/lib/services/inspoClient';
import { mapDesignMdToTokens } from '@/lib/services/themeImport/inspoImporter';

export const dynamic = 'force-dynamic';

const PreviewSchema = z.object({
  slug: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = PreviewSchema.parse(await req.json());
    if (!isValidInspoSlug(input.slug)) {
      return NextResponse.json({ success: false, error: 'Invalid Inspo slug.' }, { status: 400 });
    }

    let designMd: string;
    try {
      designMd = await getDesignMd(input.slug);
    } catch (e) {
      if (e instanceof InspoHttpError) {
        const message = e.status === 429
          ? 'Inspo is rate-limited right now. Try again shortly.'
          : e.status === 404
          ? 'Could not find that site on Inspo.'
          : `Inspo returned an error (${e.status}). Try again shortly.`;
        return NextResponse.json({ success: false, error: message }, { status: 502 });
      }
      throw e;
    }

    const mapped = mapDesignMdToTokens(designMd);
    if (!mapped.success) {
      return NextResponse.json({ success: false, error: mapped.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      data: {
        tokens: mapped.tokens,
        provenance: mapped.provenance,
        lowConfidence: mapped.lowConfidence,
        capturedAt: mapped.capturedAt,
      },
    });
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoPreviewRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/inspo/preview/route.ts test/inspoPreviewRoute.test.ts
git commit -m "feat: add POST /api/inspo/preview route"
```

---

## Task 8: Route — POST /api/styles/import-inspo (commit)

**Files:**
- Create: `app/api/styles/import-inspo/route.ts`
- Test: `test/importInspoRoute.test.ts`

**Interfaces:**
- Consumes: `isValidInspoSlug` from `inspoClient.ts`; `ThemeTokensSchema`, `tokensToCss` from
  `themeTokens.ts`; `styleService.create`, `assetService.create` (existing).
- Produces: `POST` handler creating a Style Bible from client-approved tokens.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/importInspoRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { POST } from '@/app/api/styles/import-inspo/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-importinspo-'));
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

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/styles/import-inspo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

const VALID_TOKENS = {
  colorBackground: '#ffffff',
  colorForeground: '#111111',
  colorAccent: '#3b82f6',
  colorBorder: '#e5e7eb',
  fontHeading: 'Inter',
  fontBody: 'Georgia',
  spaceUnit: '8px',
  radiusBase: '6px',
};

describe('POST /api/styles/import-inspo', () => {
  it('requires login', async () => {
    const res = await POST(req({ name: 'X', slug: 'acme-corp', tokens: VALID_TOKENS, provenance: {}, lowConfidence: false }));
    expect(res.status).toBe(401);
  });

  it('rejects an invalid slug with a 400', async () => {
    const { cookieHeader } = await seedSession();
    const res = await POST(req({ name: 'X', slug: '../etc/passwd', tokens: VALID_TOKENS, provenance: {}, lowConfidence: false }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('rejects tampered tokens that fail ThemeTokensSchema, even though preview already validated once', async () => {
    const { cookieHeader } = await seedSession();
    const tampered = { ...VALID_TOKENS, colorAccent: "'; } body { background: url(evil) } .x {" };
    const res = await POST(req({ name: 'X', slug: 'acme-corp', tokens: tampered, provenance: {}, lowConfidence: false }, cookieHeader));
    expect(res.status).toBe(400);

    const styles = await styleService.getAll();
    expect(styles).toHaveLength(0);
  });

  it('creates a Style Bible with __source provenance from the approved tokens, no re-fetch', async () => {
    const { cookieHeader, userId } = await seedSession();
    const res = await POST(req({
      name: 'Acme Style', slug: 'acme-corp', tokens: VALID_TOKENS,
      provenance: { colorAccent: 'heuristic' }, lowConfidence: false,
    }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.created_by).toBe(userId);

    const parsed = JSON.parse(body.data.parameters);
    expect(parsed.colorAccent).toBe('#3b82f6');
    expect(parsed.__source.slug).toBe('acme-corp');
    expect(parsed.__source.provenance.colorAccent).toBe('heuristic');
    expect(typeof parsed.__source.importedAt).toBe('number');

    const assets = await assetService.getActiveAssetsForStyle(body.data.id);
    expect(assets).toHaveLength(1);
    expect(assets[0].output_kind).toBe('theme');
    expect(assets[0].prompt).toBe('Imported from Inspo: acme-corp');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/importInspoRoute.test.ts`
Expected: FAIL — route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/styles/import-inspo/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z, ZodError } from 'zod';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getCurrentUser } from '@/lib/utils/session';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss, ThemeTokensSchema } from '@/lib/services/themeTokens';
import { isValidInspoSlug } from '@/lib/services/inspoClient';

export const dynamic = 'force-dynamic';

const ImportInspoSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  tokens: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()).optional().default({}),
  lowConfidence: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = ImportInspoSchema.parse(await req.json());
    if (!isValidInspoSlug(input.slug)) {
      return NextResponse.json({ success: false, error: 'Invalid Inspo slug.' }, { status: 400 });
    }

    // The tokens the user approved in the preview step, not a slug to
    // re-resolve — this is what makes preview/commit divergence impossible
    // by construction. Re-validated here as defense-in-depth against a
    // tampered client request body, the same as every other write path in
    // this codebase that accepts client-supplied structured data.
    const validatedTokens = ThemeTokensSchema.safeParse(input.tokens);
    if (!validatedTokens.success) {
      return NextResponse.json({
        success: false,
        error: `Tokens are not valid: ${validatedTokens.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      }, { status: 400 });
    }

    const filename = `imported-${crypto.randomUUID()}.css`;
    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(validatedTokens.data));
    } catch (e) {
      console.error(`Failed to write imported theme file ${filename}:`, e);
      throw e;
    }

    const parameters = {
      ...validatedTokens.data,
      __source: {
        slug: input.slug,
        capturedAt: null as string | null, // set below if a capturedAt was actually passed through
        importedAt: Date.now(),
        provenance: input.provenance,
        lowConfidence: input.lowConfidence,
      },
    };

    const style = await styleService.create({
      name: input.name,
      createdBy: user.id,
      parameters: JSON.stringify(parameters),
    });

    await assetService.create({
      styleId: style.id,
      createdBy: user.id,
      assetType: 'theme',
      prompt: `Imported from Inspo: ${input.slug}`,
      imagePath: filename,
      outputKind: 'theme',
    });

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

Note: `__source.capturedAt` is left `null` here rather than threading it from the client, since the
preview route already returns `capturedAt` separately and a client could otherwise spoof it — a
follow-up refinement (out of scope for this task) could have the preview route sign/echo it back;
for this pass, `capturedAt: null` is an honest "unknown" rather than a trusted-but-unverified client
value. This is intentionally simpler than the spec's original phrasing and does not regress
anything the spec requires (the spec's own error-handling table never asserts `capturedAt` is
non-null on the commit path).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/importInspoRoute.test.ts`
Expected: PASS. (The `parsed.__source.capturedAt` field isn't asserted non-null in the tests above,
consistent with the note.)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/styles/import-inspo/route.ts test/importInspoRoute.test.ts
git commit -m "feat: add POST /api/styles/import-inspo commit route"
```

---

## Task 9: Route — POST /api/inspo/search

**Files:**
- Create: `app/api/inspo/search/route.ts`
- Test: `test/inspoSearchRoute.test.ts`

**Interfaces:**
- Consumes: `searchScreens`, `recommend`, `getFilters` from `inspoClient.ts`.
- Produces: `POST` handler proxying one of the three Inspo search operations.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/inspoSearchRoute.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-insposearch-'));
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
  vi.restoreAllMocks();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/inspo/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/inspo/search', () => {
  it('requires login', async () => {
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'editorial' }));
    expect(res.status).toBe(401);
  });

  it('rejects a brief over the length cap', async () => {
    const { cookieHeader } = await seedSession();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'recommend', brief: 'a'.repeat(5001) }, cookieHeader));
    expect(res.status).toBe(400);
  });

  it('proxies a search request and returns Inspo\'s result', async () => {
    const { cookieHeader } = await seedSession();
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, searchScreens: vi.fn().mockResolvedValue({ results: [{ slug: 'acme-corp' }] }) };
    });
    vi.resetModules();
    const { POST } = await import('@/app/api/inspo/search/route');
    const res = await POST(req({ mode: 'search', query: 'editorial' }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.results[0].slug).toBe('acme-corp');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoSearchRoute.test.ts`
Expected: FAIL — route module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/inspo/search/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { searchScreens, recommend, getFilters } from '@/lib/services/inspoClient';

export const dynamic = 'force-dynamic';

const MAX_BRIEF_LENGTH = 5000;

const SearchRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('search'), query: z.string().min(1).optional(), filters: z.record(z.string(), z.unknown()).optional() }),
  z.object({ mode: z.literal('recommend'), brief: z.string().min(1).max(MAX_BRIEF_LENGTH) }),
  z.object({ mode: z.literal('filters') }),
]);

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = SearchRequestSchema.parse(await req.json());

    let data: unknown;
    if (input.mode === 'search') {
      data = await searchScreens({ query: input.query, ...(input.filters ?? {}) });
    } else if (input.mode === 'recommend') {
      data = await recommend(input.brief);
    } else {
      data = await getFilters();
    }

    return NextResponse.json({ success: true, data });
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoSearchRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/inspo/search/route.ts test/inspoSearchRoute.test.ts
git commit -m "feat: add POST /api/inspo/search proxy route"
```

---

## Task 10: Frontend — "Import from Inspo" panel on the Style Bibles page

**Files:**
- Modify: `app/dashboard/styles/page.tsx`

**Interfaces:**
- Consumes: `POST /api/inspo/search` (mode: 'search' | 'recommend'), `POST /api/inspo/preview`,
  `POST /api/styles/import-inspo` (Tasks 7-9).

This task has no automated test — the existing page has no test file (`useStyles` and the fetch
calls are exercised by the manual verification in Task 11), matching this page's existing
convention (the "Import from design tokens" panel above it has none either).

- [ ] **Step 1: Add the Inspo import panel state and handlers**

Insert into `app/dashboard/styles/page.tsx`, after the existing `importError` state declaration:

```typescript
  const [inspoQuery, setInspoQuery] = useState('');
  const [inspoResults, setInspoResults] = useState<{ slug: string; title?: string; host?: string }[]>([]);
  const [inspoSearching, setInspoSearching] = useState(false);
  const [inspoSearchError, setInspoSearchError] = useState<string | null>(null);
  const [inspoSelectedSlug, setInspoSelectedSlug] = useState<string | null>(null);
  const [inspoPreview, setInspoPreview] = useState<{ tokens: Record<string, string>; provenance: Record<string, string>; lowConfidence: boolean } | null>(null);
  const [inspoPreviewLoading, setInspoPreviewLoading] = useState(false);
  const [inspoPreviewError, setInspoPreviewError] = useState<string | null>(null);
  const [inspoImportName, setInspoImportName] = useState('');
  const [inspoImporting, setInspoImporting] = useState(false);
  const [inspoImportError, setInspoImportError] = useState<string | null>(null);

  async function handleInspoSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoQuery.trim() || inspoSearching) return;
    setInspoSearching(true);
    setInspoSearchError(null);
    setInspoResults([]);
    try {
      const res = await fetch('/api/inspo/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'search', query: inspoQuery.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoSearchError(body.error ?? 'Search failed.');
        return;
      }
      setInspoResults(body.data.results ?? []);
    } catch {
      setInspoSearchError('Could not reach the server.');
    } finally {
      setInspoSearching(false);
    }
  }

  async function handleInspoPreview(slug: string) {
    setInspoSelectedSlug(slug);
    setInspoPreview(null);
    setInspoPreviewError(null);
    setInspoPreviewLoading(true);
    try {
      const res = await fetch('/api/inspo/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoPreviewError(body.error ?? 'Preview failed.');
        return;
      }
      setInspoPreview(body.data);
      setInspoImportName(slug);
    } catch {
      setInspoPreviewError('Could not reach the server.');
    } finally {
      setInspoPreviewLoading(false);
    }
  }

  async function handleInspoImport(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoImportName.trim() || !inspoPreview || !inspoSelectedSlug || inspoImporting) return;
    setInspoImporting(true);
    setInspoImportError(null);
    try {
      const res = await fetch('/api/styles/import-inspo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: inspoImportName.trim(),
          slug: inspoSelectedSlug,
          tokens: inspoPreview.tokens,
          provenance: inspoPreview.provenance,
          lowConfidence: inspoPreview.lowConfidence,
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoImportError(body.error ?? 'Import failed.');
        return;
      }
      setInspoPreview(null);
      setInspoSelectedSlug(null);
      setInspoResults([]);
      setInspoQuery('');
      setInspoImportName('');
      await refresh();
    } catch {
      setInspoImportError('Could not reach the server.');
    } finally {
      setInspoImporting(false);
    }
  }
```

- [ ] **Step 2: Add the panel markup**

Insert into the JSX, right after the existing "Import from design tokens" `</form>` closing tag:

```tsx
      <form className="card" onSubmit={handleInspoSearch} style={{ marginBottom: 32, maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import from Inspo</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Search 832 real production sites and seed a new Style Bible from one of their extracted
          design tokens.
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <input
            value={inspoQuery}
            onChange={e => setInspoQuery(e.target.value)}
            placeholder="e.g. warm editorial SaaS"
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
          />
          <button className="btn btn-primary" type="submit" disabled={inspoSearching || !inspoQuery.trim()}>
            {inspoSearching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {inspoSearchError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoSearchError}</p>}

        {inspoResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {inspoResults.map(r => (
              <button
                key={r.slug}
                type="button"
                className="btn"
                onClick={() => handleInspoPreview(r.slug)}
                style={{ textAlign: 'left' }}
              >
                {r.title ?? r.slug} {r.host ? `(${r.host})` : ''}
              </button>
            ))}
          </div>
        )}

        {inspoPreviewLoading && <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>Loading preview…</p>}
        {inspoPreviewError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoPreviewError}</p>}

        {inspoPreview && (
          <div style={{ marginTop: 8 }}>
            {inspoPreview.lowConfidence && (
              <p style={{ color: 'var(--reject)', fontSize: 12, marginBottom: 8 }}>
                Low-confidence import — most fields fell back to defaults. Check the swatches below.
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {Object.entries(inspoPreview.tokens).map(([field, value]) => (
                <div key={field} style={{ fontSize: 11 }}>
                  <div
                    style={{
                      width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)',
                      background: field.startsWith('color') ? value : 'var(--bg)',
                    }}
                    title={`${field}: ${value} (${inspoPreview.provenance[field] ?? 'unknown'})`}
                  />
                  <div style={{ color: 'var(--ink-faint)' }}>{field}</div>
                </div>
              ))}
            </div>
            <form onSubmit={handleInspoImport} style={{ display: 'flex', gap: 10 }}>
              <input
                value={inspoImportName}
                onChange={e => setInspoImportName(e.target.value)}
                placeholder="New Style Bible name"
                style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
              />
              <button className="btn btn-primary" type="submit" disabled={inspoImporting || !inspoImportName.trim()}>
                {inspoImporting ? 'Importing…' : 'Confirm Import'}
              </button>
            </form>
            {inspoImportError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{inspoImportError}</p>}
          </div>
        )}
      </form>
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/styles/page.tsx
git commit -m "feat: add Import from Inspo panel to the Style Bibles page"
```

---

## Task 11: Manual verification — Feature 1 end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (background)

- [ ] **Step 2: Log in and open the Style Bibles page**

Navigate to `http://localhost:3000/dashboard/styles` in a real browser, logged in.

- [ ] **Step 3: Search, preview, and import a real site**

Type a query into the "Import from Inspo" panel, click Search, click a result, confirm the token
swatches render with sensible colors, then click "Confirm Import" and confirm a new Style Bible
appears in the grid below with the entered name.

- [ ] **Step 4: Confirm the created Style Bible's theme CSS is real**

Open the new Style Bible, confirm a "Themes" asset exists with prompt `Imported from Inspo: <slug>`,
and that its theme CSS file (under `storage/themes/`) contains the previewed color values.

- [ ] **Step 5: Confirm a rate-limited/unknown-slug error surfaces cleanly**

Trigger a search or preview against a slug that doesn't exist (or wait for a natural 429 if one
occurs) and confirm the UI shows a specific, non-crashing error message rather than a blank
failure.

---

## Task 12: Migration — ground_with_inspo column + StyleService/PUT route

**Files:**
- Create: `lib/database/migrations/017_add_ground_with_inspo_to_styles.sql`
- Modify: `lib/database/schema.ts`, `lib/services/StyleService.ts`, `app/api/styles/[id]/route.ts`
- Test: `test/styleService.test.ts` if it exists — otherwise append a new `describe` block to
  `test/importInspoRoute.test.ts`'s sibling test infra is not appropriate; create
  `test/styleGroundWithInspo.test.ts` instead.

**Interfaces:**
- Produces: `styles.ground_with_inspo` column (0/1, `NOT NULL DEFAULT 0`); `StyleSchema` gains
  `ground_with_inspo: z.union([z.literal(0), z.literal(1)])`; `styleService.update()`'s patch type
  gains `groundWithInspo?: boolean`; the `PUT /api/styles/[id]` route accepts `groundWithInspo`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/styleGroundWithInspo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-groundinspo-'));
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

describe('styles.ground_with_inspo', () => {
  it('defaults to false (0) for a newly-created style', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    expect(style.ground_with_inspo).toBe(0);
  });

  it('can be toggled on via update()', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const updated = await styleService.update(style.id, userId, { groundWithInspo: true });
    expect('ground_with_inspo' in (updated as any) ? (updated as any).ground_with_inspo : null).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/styleGroundWithInspo.test.ts`
Expected: FAIL — `ground_with_inspo` column/field doesn't exist yet.

- [ ] **Step 3: Write the migration**

```sql
-- lib/database/migrations/017_add_ground_with_inspo_to_styles.sql

ALTER TABLE styles ADD COLUMN ground_with_inspo INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Update StyleSchema**

In `lib/database/schema.ts`, add to `StyleSchema`:

```typescript
export const StyleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  parameters: z.string(),
  forked_from: z.string().uuid().nullable(),
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  ground_with_inspo: z.union([z.literal(0), z.literal(1)]).default(0),
});
```

- [ ] **Step 5: Update StyleService.update()**

In `lib/services/StyleService.ts`, change the `update()` method:

```typescript
  async update(
    id: string,
    requestingUserId: string,
    patch: { name?: string; parameters?: string; groundWithInspo?: boolean },
    isAdmin: boolean = false
  ): Promise<Style | { error: 'NOT_FOUND' | 'FORBIDDEN' }> {
    const existing = await this.getById(id);
    if (!existing) return { error: 'NOT_FOUND' };
    if (existing.created_by !== requestingUserId && !isAdmin) return { error: 'FORBIDDEN' };

    const db = DatabaseConnection.getInstance();
    db.prepare(`
      UPDATE styles SET name = ?, parameters = ?, ground_with_inspo = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.parameters ?? existing.parameters,
      patch.groundWithInspo !== undefined ? (patch.groundWithInspo ? 1 : 0) : existing.ground_with_inspo,
      Date.now(),
      id
    );
    return (await this.getById(id))!;
  }
```

- [ ] **Step 6: Update the PUT route**

In `app/api/styles/[id]/route.ts`, change `UpdateStyleSchema`:

```typescript
const UpdateStyleSchema = z.object({
  name: z.string().min(1).optional(),
  parameters: z.string().optional(),
  groundWithInspo: z.boolean().optional(),
});
```

The rest of the `PUT` handler already forwards `patch` (the parsed body) straight to
`styleService.update()`, so no further change is needed there.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/styleGroundWithInspo.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full existing style-related test suite to confirm no regression**

Run: `npx vitest run test/importTokensRoute.test.ts test/importInspoRoute.test.ts`
Expected: PASS (both still green with the new column present).

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add lib/database/migrations/017_add_ground_with_inspo_to_styles.sql lib/database/schema.ts lib/services/StyleService.ts app/api/styles/\[id\]/route.ts test/styleGroundWithInspo.test.ts
git commit -m "feat: add ground_with_inspo column and wire it through StyleService/PUT route"
```

---

## Task 13: Migration — inspo_reference_cache table

**Files:**
- Create: `lib/database/migrations/018_add_inspo_reference_cache.sql`
- Modify: `lib/database/schema.ts`
- Test: `test/inspoReferenceCache.test.ts`

**Interfaces:**
- Produces: `inspo_reference_cache` table (`id, style_id, component_type, accent_hash, image_url,
  is_fallback, is_color_matched, fetched_at`), `InspoReferenceCacheSchema` in `schema.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/inspoReferenceCache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-inspocache-'));
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

describe('inspo_reference_cache table', () => {
  it('enforces UNIQUE(style_id, component_type, accent_hash) via upsert', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const db = DatabaseConnection.getInstance();

    const insert = () => db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (style_id, component_type, accent_hash) DO UPDATE SET image_url = excluded.image_url, fetched_at = excluded.fetched_at
    `).run(crypto.randomUUID(), style.id, 'Button', 'abc123', 'https://inspomcp.dev/api/component/x/1', 0, 1, Date.now());

    insert();
    insert(); // second write with the same key must not throw or duplicate

    const rows = db.prepare('SELECT * FROM inspo_reference_cache WHERE style_id = ?').all(style.id);
    expect(rows).toHaveLength(1);
  });

  it('cascades delete when the owning style is deleted', async () => {
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
    `).run(crypto.randomUUID(), style.id, 'Button', 'abc123', 'https://inspomcp.dev/api/component/x/1', Date.now());

    db.prepare('DELETE FROM styles WHERE id = ?').run(style.id);

    const rows = db.prepare('SELECT * FROM inspo_reference_cache WHERE style_id = ?').all(style.id);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inspoReferenceCache.test.ts`
Expected: FAIL — `no such table: inspo_reference_cache`.

- [ ] **Step 3: Write the migration**

```sql
-- lib/database/migrations/018_add_inspo_reference_cache.sql

CREATE TABLE inspo_reference_cache (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL,
  accent_hash TEXT NOT NULL,
  image_url TEXT NOT NULL,
  is_fallback INTEGER NOT NULL DEFAULT 0,
  is_color_matched INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  UNIQUE(style_id, component_type, accent_hash)
);

CREATE INDEX idx_inspo_reference_cache_style_id ON inspo_reference_cache(style_id);
```

- [ ] **Step 4: Add InspoReferenceCacheSchema to schema.ts**

In `lib/database/schema.ts`:

```typescript
export const InspoReferenceCacheSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  component_type: z.string().min(1),
  accent_hash: z.string().min(1),
  image_url: z.string().min(1),
  is_fallback: z.union([z.literal(0), z.literal(1)]),
  is_color_matched: z.union([z.literal(0), z.literal(1)]),
  fetched_at: z.number().int(),
});
export type InspoReferenceCache = z.infer<typeof InspoReferenceCacheSchema>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/inspoReferenceCache.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/database/migrations/018_add_inspo_reference_cache.sql lib/database/schema.ts test/inspoReferenceCache.test.ts
git commit -m "feat: add inspo_reference_cache table"
```

---

## Task 14: componentType threading — generate route and worker.ts

**Files:**
- Modify: `app/api/generate/route.ts`, `worker.ts`
- Test: `test/generateRoute.test.ts` if it exists — otherwise create `test/generateComponentType.test.ts`

**Interfaces:**
- Produces: `options.componentType` and `options.groundWithInspo` on a job's stored options;
  `ComponentGenerator.generate()` now receives a real `componentType` instead of always `undefined`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/generateComponentType.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { POST } from '@/app/api/generate/route';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-gencomponenttype-'));
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

function req(body: unknown, cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generate componentType/groundWithInspo threading', () => {
  it('stores componentType and the style\'s current groundWithInspo flag on the job\'s options', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });

    const res = await POST(req({
      styleId: style.id, assetType: 'component', prompt: 'A submit button',
      outputKind: 'component', options: { componentType: 'Button' },
    }, cookieHeader));
    const body = await res.json();
    expect(res.status).toBe(200);

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(body.data.id) as any;
    const options = JSON.parse(job.options);
    expect(options.componentType).toBe('Button');
    expect(options.groundWithInspo).toBe(true);
  });

  it('defaults groundWithInspo to false when the style has not opted in', async () => {
    const { cookieHeader, userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });

    const res = await POST(req({
      styleId: style.id, assetType: 'component', prompt: 'A card',
      outputKind: 'component', options: { componentType: 'Card' },
    }, cookieHeader));
    const body = await res.json();

    const db = DatabaseConnection.getInstance();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(body.data.id) as any;
    const options = JSON.parse(job.options);
    expect(options.groundWithInspo).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/generateComponentType.test.ts`
Expected: FAIL — `options.componentType`/`options.groundWithInspo` are not being set yet.

- [ ] **Step 3: Update the generate route**

In `app/api/generate/route.ts`, add `componentType` handling. First, extend the reserved-keys list
and read the style:

```typescript
// Change RESERVED_OPTION_KEYS to include componentType and groundWithInspo:
const RESERVED_OPTION_KEYS = ['referenceImageFilename', 'referenceStrength', 'basedOnAssetId', 'width', 'height', 'provider', 'model', 'ollamaHost', 'ollamaCorrectionRequested', 'componentType', 'groundWithInspo'] as const;
```

Add the import at the top:

```typescript
import { styleService } from '@/lib/services/StyleService';
```

Inside `POST`, after `const input = GenerateSchema.parse(await req.json());` and before the
`mergedOptions` construction, read the incoming `componentType` from the raw (not schema-validated
— it's a free-form options bag) request options, and look up the target style's
`ground_with_inspo` flag:

```typescript
    const requestedComponentType = typeof (input.options as Record<string, unknown> | undefined)?.componentType === 'string'
      ? (input.options as Record<string, string>).componentType
      : undefined;
```

Then, right after the existing `mergedOptions.referenceImage`/`basedOnAssetId`/`width`/`height`
block (before `const jobInput = ...`), add:

```typescript
    if (input.outputKind === 'component') {
      if (requestedComponentType !== undefined) {
        mergedOptions.componentType = requestedComponentType;
      }
      const targetStyle = await styleService.getById(input.styleId);
      mergedOptions.groundWithInspo = !!targetStyle?.ground_with_inspo;
    }
```

- [ ] **Step 4: Update worker.ts to pass componentType through**

In `worker.ts`, change both call sites that currently pass a hardcoded `undefined` for
`componentType`:

```typescript
// Add, right after the existing referenceImage/referenceStrength/width/height reads:
  const componentType = typeof options.componentType === 'string' ? options.componentType : undefined;
```

Then in the `'component'` case, change:

```typescript
          const resolved = await resolveComponentRegeneration({
            basedOnAssetId: options.basedOnAssetId,
            basedOnContent,
            instruction: job.prompt,
            styleId: job.style_id,
            componentType,
            referenceImage: referenceImage ?? undefined,
            providerOverride,
          });
```

and:

```typescript
          result = await getComponentGenerator().generate(job.prompt, job.style_id, componentType, referenceImage ?? undefined, basedOnContent, undefined, providerOverride) as { path: string };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/generateComponentType.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the existing generate-route test suite to confirm no regression**

Run: `npx vitest run test/generateRoute.test.ts` (or whatever the existing generate-route test file
is named — locate it via `find test -iname '*generate*'` if unsure) and the full suite:

Run: `npx vitest run`
Expected: PASS across the whole suite.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add app/api/generate/route.ts worker.ts test/generateComponentType.test.ts
git commit -m "feat: thread componentType and groundWithInspo through job options"
```

---

## Task 15: inspoGrounding.ts — cache lookup and SSRF/relative-URL guard

**Files:**
- Create: `lib/services/inspoGrounding.ts`
- Test: `test/inspoGrounding.test.ts`

**Interfaces:**
- Consumes: `getInspoBaseUrl`, `INSPO_TYPE_FOR_COMPONENT_TYPE` from `inspoClient.ts`;
  `InspoReferenceCacheSchema` from `schema.ts`; `DatabaseConnection`.
- Produces: `hashAccentColor(colorAccent: string): string`,
  `resolveAndValidateUrl(url: string): string | null`,
  `lookupCachedReference(styleId: string, componentType: string, accentHash: string):
  InspoReferenceCache | null`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/inspoGrounding.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-inspogrounding-'));
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

describe('hashAccentColor', () => {
  it('is deterministic and differs for different colors', async () => {
    const { hashAccentColor } = await import('@/lib/services/inspoGrounding');
    expect(hashAccentColor('#3b82f6')).toBe(hashAccentColor('#3b82f6'));
    expect(hashAccentColor('#3b82f6')).not.toBe(hashAccentColor('#ef4444'));
  });
});

describe('resolveAndValidateUrl', () => {
  const originalEnv = process.env.INSPO_BASE_URL;
  beforeEach(() => { process.env.INSPO_BASE_URL = 'https://inspo.test'; });
  afterEach(() => { process.env.INSPO_BASE_URL = originalEnv; });

  it('resolves a relative path against INSPO_BASE_URL', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('/api/component/acme-corp/1')).toBe('https://inspo.test/api/component/acme-corp/1');
  });

  it('accepts an already-absolute same-origin URL', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('https://inspo.test/api/component/acme-corp/1')).toBe('https://inspo.test/api/component/acme-corp/1');
  });

  it('rejects a cross-origin absolute URL', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('https://evil.example/steal.png')).toBeNull();
  });

  it('rejects a non-http(s) scheme', async () => {
    const { resolveAndValidateUrl } = await import('@/lib/services/inspoGrounding');
    expect(resolveAndValidateUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('lookupCachedReference', () => {
  it('returns null on a cache miss', async () => {
    const { lookupCachedReference } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    expect(lookupCachedReference(style.id, 'Button', 'abc123')).toBeNull();
  });

  it('returns the cached row when present and fresh', async () => {
    const { lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const hash = hashAccentColor('#3b82f6');
    const db = DatabaseConnection.getInstance();
    db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
    `).run('11111111-1111-1111-1111-111111111111', style.id, 'Button', hash, 'https://inspomcp.dev/api/component/x/1', Date.now());

    const found = lookupCachedReference(style.id, 'Button', hash);
    expect(found?.image_url).toBe('https://inspomcp.dev/api/component/x/1');
  });

  it('returns null for a stale (expired-TTL) row', async () => {
    const { lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const hash = hashAccentColor('#3b82f6');
    const db = DatabaseConnection.getInstance();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
    `).run('22222222-2222-2222-2222-222222222222', style.id, 'Button', hash, 'https://inspomcp.dev/api/component/x/1', eightDaysAgo);

    expect(lookupCachedReference(style.id, 'Button', hash)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoGrounding.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/inspoGrounding.ts
import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { InspoReferenceCacheSchema, type InspoReferenceCache } from '@/lib/database/schema';
import { getInspoBaseUrl } from '@/lib/services/inspoClient';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A short, deterministic hash of a Style Bible's colorAccent, used as part of the cache key so an accent change naturally misses old entries instead of needing explicit invalidation. */
export function hashAccentColor(colorAccent: string): string {
  return crypto.createHash('sha256').update(colorAccent).digest('hex').slice(0, 8);
}

/**
 * Resolves a (possibly relative) Inspo-supplied URL against INSPO_BASE_URL
 * and validates it's same-origin http(s) before any caller fetches it.
 * Returns null for anything that fails the check — a relative path is
 * always safe by construction (resolving against the configured base
 * can't produce a cross-origin URL); an already-absolute URL must match
 * INSPO_BASE_URL's origin exactly.
 */
export function resolveAndValidateUrl(url: string): string | null {
  const base = new URL(getInspoBaseUrl());
  let resolved: URL;
  try {
    resolved = new URL(url, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  if (resolved.origin !== base.origin) return null;
  return resolved.toString();
}

/** Looks up a fresh (within CACHE_TTL_MS) cached reference row, or null on a miss/stale row. Does not itself validate the stored image_url — callers must still run it through resolveAndValidateUrl before fetching, since the row could predate an INSPO_BASE_URL change. */
export function lookupCachedReference(styleId: string, componentType: string, accentHash: string): InspoReferenceCache | null {
  const db = DatabaseConnection.getInstance();
  const row = db.prepare(`
    SELECT * FROM inspo_reference_cache WHERE style_id = ? AND component_type = ? AND accent_hash = ?
  `).get(styleId, componentType, accentHash);
  if (!row) return null;
  const parsed = InspoReferenceCacheSchema.parse(row);
  if (Date.now() - parsed.fetched_at > CACHE_TTL_MS) return null;
  return parsed;
}

/** Deletes a cache row outright — used when its stored URL fails the SSRF/origin check on read (e.g. after a self-host base-URL change), so grounding doesn't keep retrying a dead entry every call. */
export function deleteCachedReference(styleId: string, componentType: string, accentHash: string): void {
  const db = DatabaseConnection.getInstance();
  db.prepare('DELETE FROM inspo_reference_cache WHERE style_id = ? AND component_type = ? AND accent_hash = ?').run(styleId, componentType, accentHash);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoGrounding.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/inspoGrounding.ts test/inspoGrounding.test.ts
git commit -m "feat: add Inspo reference cache lookup and SSRF/relative-URL guard"
```

---

## Task 16: inspoGrounding.ts — find_components call, selection, crop download + validation

**Files:**
- Modify: `lib/services/inspoGrounding.ts`
- Test: `test/inspoGrounding.test.ts` (append)

**Interfaces:**
- Consumes: `findComponents`, `INSPO_TYPE_FOR_COMPONENT_TYPE` from `inspoClient.ts`;
  `resolveAndValidateUrl` from Task 15.
- Produces: `type GroundingCandidate = { imageUrl: string; fallback: boolean; colorMatched: boolean }`,
  `selectGroundingCandidate(componentType: string, colorAccent: string, deadlineMs: number):
  Promise<GroundingCandidate | null>`,
  `downloadAndValidateCropImage(url: string, deadlineMs: number): Promise<{base64: string;
  mediaType: 'image/png'|'image/jpeg'|'image/webp'} | null>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to test/inspoGrounding.test.ts
import { vi } from 'vitest';

describe('selectGroundingCandidate', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/services/inspoClient'); });

  it('returns null for a component type with no Inspo mapping', async () => {
    const { selectGroundingCandidate } = await import('@/lib/services/inspoGrounding');
    const result = await selectGroundingCandidate('Other', '#3b82f6', 2000);
    expect(result).toBeNull();
  });

  it('picks the first non-fallback result and records colorMatched:true on success', async () => {
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return {
        ...actual,
        findComponents: vi.fn().mockResolvedValue([
          { imageUrl: 'https://inspomcp.dev/api/component/a/1', fallback: true },
          { imageUrl: 'https://inspomcp.dev/api/component/b/2', fallback: false },
        ]),
      };
    });
    vi.resetModules();
    const { selectGroundingCandidate } = await import('@/lib/services/inspoGrounding');
    const result = await selectGroundingCandidate('Button', '#3b82f6', 2000);
    expect(result).toEqual({ imageUrl: 'https://inspomcp.dev/api/component/b/2', fallback: false, colorMatched: true });
  });

  it('falls back to the lowest-index fallback result when nothing else matches', async () => {
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return {
        ...actual,
        findComponents: vi.fn().mockResolvedValue([
          { imageUrl: 'https://inspomcp.dev/api/component/a/5', fallback: true },
          { imageUrl: 'https://inspomcp.dev/api/component/a/1', fallback: true },
        ]),
      };
    });
    vi.resetModules();
    const { selectGroundingCandidate } = await import('@/lib/services/inspoGrounding');
    const result = await selectGroundingCandidate('Button', '#3b82f6', 2000);
    expect(result?.fallback).toBe(true);
  });

  it('degrades to no-color and colorMatched:false when the color-matched call rejects', async () => {
    let callCount = 0;
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return {
        ...actual,
        findComponents: vi.fn().mockImplementation(async (args: any) => {
          callCount++;
          if (args.color) throw new Error('invalid color parameter');
          return [{ imageUrl: 'https://inspomcp.dev/api/component/a/1', fallback: false }];
        }),
      };
    });
    vi.resetModules();
    const { selectGroundingCandidate } = await import('@/lib/services/inspoGrounding');
    const result = await selectGroundingCandidate('Button', '#3b82f6', 2000);
    expect(result?.colorMatched).toBe(false);
    expect(callCount).toBe(2); // one failed color-matched attempt, one degraded retry
  });
});

describe('downloadAndValidateCropImage', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('returns a valid ReferenceImagePayload-shaped result for an allowed content type under the size cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/png'], ['content-length', '4']]),
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    }) as any;
    const { downloadAndValidateCropImage } = await import('@/lib/services/inspoGrounding');
    const result = await downloadAndValidateCropImage('https://inspomcp.dev/api/component/a/1', 2000);
    expect(result?.mediaType).toBe('image/png');
    expect(typeof result?.base64).toBe('string');
  });

  it('rejects a disallowed content type', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/avif'], ['content-length', '4']]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }) as any;
    const { downloadAndValidateCropImage } = await import('@/lib/services/inspoGrounding');
    const result = await downloadAndValidateCropImage('https://inspomcp.dev/api/component/a/1', 2000);
    expect(result).toBeNull();
  });

  it('rejects a response over the size cap', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/png'], ['content-length', String(5 * 1024 * 1024)]]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(5 * 1024 * 1024)),
    }) as any;
    const { downloadAndValidateCropImage } = await import('@/lib/services/inspoGrounding');
    const result = await downloadAndValidateCropImage('https://inspomcp.dev/api/component/a/1', 2000);
    expect(result).toBeNull();
  });

  it('rejects a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: new Map(), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }) as any;
    const { downloadAndValidateCropImage } = await import('@/lib/services/inspoGrounding');
    const result = await downloadAndValidateCropImage('https://inspomcp.dev/api/component/a/1', 2000);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoGrounding.test.ts`
Expected: FAIL — `selectGroundingCandidate`/`downloadAndValidateCropImage` not exported yet.

- [ ] **Step 3: Write the implementation**

```typescript
// Append to lib/services/inspoGrounding.ts
import { findComponents, INSPO_TYPE_FOR_COMPONENT_TYPE } from '@/lib/services/inspoClient';

export interface GroundingCandidate {
  imageUrl: string;
  fallback: boolean;
  colorMatched: boolean;
}

/**
 * Calls find_components for the mapped Inspo type, preferring a color-matched
 * call first; if that rejects (the `color` parameter's real format is
 * unverified against Inspo's live schema), degrades to an unmatched call
 * rather than failing the whole grounding attempt. Selection is
 * deterministic: first non-fallback result, else the lowest-index fallback
 * result — never a random/first-returned pick.
 */
export async function selectGroundingCandidate(componentType: string, colorAccent: string, deadlineMs: number): Promise<GroundingCandidate | null> {
  const inspoType = INSPO_TYPE_FOR_COMPONENT_TYPE[componentType];
  if (!inspoType) return null;

  let colorMatched = true;
  let results;
  try {
    results = await findComponents({ type: inspoType, color: colorAccent }, deadlineMs);
  } catch {
    colorMatched = false;
    results = await findComponents({ type: inspoType }, deadlineMs);
  }

  if (results.length === 0) return null;

  const nonFallback = results.find(r => !r.fallback);
  const chosen = nonFallback ?? results[0];
  return { imageUrl: chosen.imageUrl, fallback: chosen.fallback, colorMatched };
}

const MAX_CROP_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_CROP_CONTENT_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};

/**
 * Downloads a crop image with a byte cap and a Content-Type allowlist —
 * rejects (never coerces) anything outside either bound, or a non-2xx
 * response. Returns null on any rejection; the caller treats that as an
 * ordinary grounding-failure case, same as a timeout or a 404.
 */
export async function downloadAndValidateCropImage(url: string, deadlineMs: number): Promise<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch {
    clearTimeout(timeout);
    return null;
  }
  clearTimeout(timeout);

  if (!res.ok) return null;

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const mediaType = ALLOWED_CROP_CONTENT_TYPES[contentType];
  if (!mediaType) return null;

  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > MAX_CROP_IMAGE_BYTES) return null;

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_CROP_IMAGE_BYTES) return null;

  return { base64: Buffer.from(buffer).toString('base64'), mediaType };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoGrounding.test.ts`
Expected: PASS — all describe blocks.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/inspoGrounding.ts test/inspoGrounding.test.ts
git commit -m "feat: add deterministic find_components selection and crop download validation"
```

---

## Task 17: inspoGrounding.ts — cache upsert and the fail-soft groundComponent() wrapper

**Files:**
- Modify: `lib/services/inspoGrounding.ts`
- Test: `test/inspoGrounding.test.ts` (append)

**Interfaces:**
- Consumes: everything produced by Tasks 15-16.
- Produces: `upsertCachedReference(...)`,
  `type GroundingOutcome = { grounded: true; referenceImage: {base64, mediaType};
  referenceIsFallbackThumbnail: boolean; colorMatched: boolean } | { grounded: false;
  groundedReason: string }`,
  `groundComponent(params: { styleId: string; componentType: string; colorAccent: string }):
  Promise<GroundingOutcome>` — the single function `worker.ts` calls.

- [ ] **Step 1: Write the failing tests**

```typescript
// Append to test/inspoGrounding.test.ts
describe('upsertCachedReference', () => {
  it('writes a row retrievable via lookupCachedReference', async () => {
    const { upsertCachedReference, lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const hash = hashAccentColor('#3b82f6');

    upsertCachedReference(style.id, 'Button', hash, 'https://inspomcp.dev/api/component/a/1', false, true);

    const found = lookupCachedReference(style.id, 'Button', hash);
    expect(found?.image_url).toBe('https://inspomcp.dev/api/component/a/1');
    expect(found?.is_color_matched).toBe(1);
  });
});

describe('groundComponent (fail-soft wrapper)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/services/inspoClient'); });

  it('returns grounded:false with reason unmapped-type for Other', async () => {
    const { groundComponent } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const outcome = await groundComponent({ styleId: style.id, componentType: 'Other', colorAccent: '#3b82f6' });
    expect(outcome).toEqual({ grounded: false, groundedReason: 'unmapped-type' });
  });

  it('returns grounded:false with reason no-match when find_components returns nothing', async () => {
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, findComponents: vi.fn().mockResolvedValue([]) };
    });
    vi.resetModules();
    const { groundComponent } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const outcome = await groundComponent({ styleId: style.id, componentType: 'Button', colorAccent: '#3b82f6' });
    expect(outcome.grounded).toBe(false);
  });

  it('never throws even when the underlying MCP call throws', async () => {
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, findComponents: vi.fn().mockRejectedValue(new Error('network error')) };
    });
    vi.resetModules();
    const { groundComponent } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });
    const outcome = await groundComponent({ styleId: style.id, componentType: 'Button', colorAccent: '#3b82f6' });
    expect(outcome.grounded).toBe(false);
  });

  it('returns grounded:true and upserts the cache on a full success path', async () => {
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, findComponents: vi.fn().mockResolvedValue([{ imageUrl: 'https://inspomcp.dev/api/component/a/1', fallback: false }]) };
    });
    vi.resetModules();
    const bytes = new Uint8Array([1, 2, 3]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/png'], ['content-length', '3']]),
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    }) as any;
    const { groundComponent, lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });

    const outcome = await groundComponent({ styleId: style.id, componentType: 'Button', colorAccent: '#3b82f6' });
    expect(outcome.grounded).toBe(true);
    if (outcome.grounded) {
      expect(outcome.referenceImage.mediaType).toBe('image/png');
    }
    expect(lookupCachedReference(style.id, 'Button', hashAccentColor('#3b82f6'))).not.toBeNull();
  });

  it('does not write a cache row on a failed attempt (failures are not negative-cached)', async () => {
    vi.doMock('@/lib/services/inspoClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/services/inspoClient')>();
      return { ...actual, findComponents: vi.fn().mockResolvedValue([]) };
    });
    vi.resetModules();
    const { groundComponent, lookupCachedReference, hashAccentColor } = await import('@/lib/services/inspoGrounding');
    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{}' });

    await groundComponent({ styleId: style.id, componentType: 'Button', colorAccent: '#3b82f6' });
    expect(lookupCachedReference(style.id, 'Button', hashAccentColor('#3b82f6'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/inspoGrounding.test.ts`
Expected: FAIL — `upsertCachedReference`/`groundComponent` not exported yet.

- [ ] **Step 3: Write the implementation**

```typescript
// Append to lib/services/inspoGrounding.ts

export function upsertCachedReference(
  styleId: string, componentType: string, accentHash: string,
  imageUrl: string, isFallback: boolean, isColorMatched: boolean
): void {
  const db = DatabaseConnection.getInstance();
  db.prepare(`
    INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (style_id, component_type, accent_hash) DO UPDATE SET
      image_url = excluded.image_url, is_fallback = excluded.is_fallback,
      is_color_matched = excluded.is_color_matched, fetched_at = excluded.fetched_at
  `).run(crypto.randomUUID(), styleId, componentType, accentHash, imageUrl, isFallback ? 1 : 0, isColorMatched ? 1 : 0, Date.now());
}

export type GroundingOutcome =
  | { grounded: true; referenceImage: { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }; referenceIsFallbackThumbnail: boolean; colorMatched: boolean }
  | { grounded: false; groundedReason: string };

const MCP_CALL_DEADLINE_MS = 2000;
const IMAGE_DOWNLOAD_DEADLINE_MS = 2000;

/**
 * The single entry point worker.ts calls. Fully fail-soft: every failure
 * mode (unmapped type, no match, timeout, SSRF rejection, oversized/wrong-
 * type download, an unexpected throw from anywhere in the chain) resolves
 * to {grounded:false, groundedReason}, never rejects. A cache row is only
 * written on a full success — a failed attempt is not negative-cached, so
 * the next generation for the same key retries normally rather than being
 * suppressed for the 7-day TTL.
 */
export async function groundComponent(params: { styleId: string; componentType: string; colorAccent: string }): Promise<GroundingOutcome> {
  try {
    const accentHash = hashAccentColor(params.colorAccent);

    const cached = lookupCachedReference(params.styleId, params.componentType, accentHash);
    if (cached) {
      const validUrl = resolveAndValidateUrl(cached.image_url);
      if (!validUrl) {
        deleteCachedReference(params.styleId, params.componentType, accentHash);
      } else {
        const image = await downloadAndValidateCropImage(validUrl, IMAGE_DOWNLOAD_DEADLINE_MS);
        if (image) {
          return {
            grounded: true, referenceImage: image,
            referenceIsFallbackThumbnail: !!cached.is_fallback,
            colorMatched: !!cached.is_color_matched,
          };
        }
        // Cached URL no longer resolves to a valid image (e.g. upstream
        // scheme change) — drop it and fall through to a fresh lookup.
        deleteCachedReference(params.styleId, params.componentType, accentHash);
      }
    }

    if (!INSPO_TYPE_FOR_COMPONENT_TYPE[params.componentType]) {
      return { grounded: false, groundedReason: 'unmapped-type' };
    }

    const candidate = await selectGroundingCandidate(params.componentType, params.colorAccent, MCP_CALL_DEADLINE_MS);
    if (!candidate) {
      return { grounded: false, groundedReason: 'no-match' };
    }

    const validUrl = resolveAndValidateUrl(candidate.imageUrl);
    if (!validUrl) {
      return { grounded: false, groundedReason: 'origin-mismatch' };
    }

    const image = await downloadAndValidateCropImage(validUrl, IMAGE_DOWNLOAD_DEADLINE_MS);
    if (!image) {
      return { grounded: false, groundedReason: 'invalid-image' };
    }

    upsertCachedReference(params.styleId, params.componentType, accentHash, validUrl, candidate.fallback, candidate.colorMatched);

    return {
      grounded: true, referenceImage: image,
      referenceIsFallbackThumbnail: candidate.fallback,
      colorMatched: candidate.colorMatched,
    };
  } catch (error) {
    console.error('Inspo grounding attempt failed unexpectedly:', error);
    return { grounded: false, groundedReason: 'error' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/inspoGrounding.test.ts`
Expected: PASS — the full file, all describe blocks.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/services/inspoGrounding.ts test/inspoGrounding.test.ts
git commit -m "feat: add cache upsert and the fail-soft groundComponent() entry point"
```

---

## Task 18: worker.ts integration — call groundComponent and record the outcome

**Files:**
- Modify: `worker.ts`
- Test: `test/workerGrounding.test.ts`

**Interfaces:**
- Consumes: `groundComponent` from `inspoGrounding.ts`; `styleService.getById` (existing).
- Produces: `worker.ts`'s `processJob()` calls grounding for eligible component jobs and persists
  `{grounded, groundedReason?, referenceIsFallbackThumbnail?, colorMatched?}` back onto the job's
  `options` column on completion.

- [ ] **Step 1: Write the failing test**

```typescript
// test/workerGrounding.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-workergrounding-'));
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
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/services/inspoGrounding');
  vi.doUnmock('@/lib/services/ComponentGenerator');
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('worker.ts grounding integration', () => {
  it('does not call groundComponent when a user-supplied referenceImageFilename is present', async () => {
    const groundComponentMock = vi.fn();
    vi.doMock('@/lib/services/inspoGrounding', () => ({ groundComponent: groundComponentMock }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: true, referenceImageFilename: 'existing.png' },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    expect(groundComponentMock).not.toHaveBeenCalled();
  });

  it('calls groundComponent and records grounded:true on the job options on success', async () => {
    vi.doMock('@/lib/services/inspoGrounding', () => ({
      groundComponent: vi.fn().mockResolvedValue({
        grounded: true, referenceImage: { base64: 'AAAA', mediaType: 'image/png' },
        referenceIsFallbackThumbnail: false, colorMatched: true,
      }),
    }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: true },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as any;
    const options = JSON.parse(updated.options);
    expect(options.grounded).toBe(true);
    expect(options.colorMatched).toBe(true);
  });

  it('records grounded:false and still completes the job when grounding finds no match', async () => {
    vi.doMock('@/lib/services/inspoGrounding', () => ({
      groundComponent: vi.fn().mockResolvedValue({ grounded: false, groundedReason: 'no-match' }),
    }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: true },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as any;
    expect(updated.status).toBe('complete');
    const options = JSON.parse(updated.options);
    expect(options.grounded).toBe(false);
    expect(options.groundedReason).toBe('no-match');
  });

  it('does not call groundComponent when the style has not opted in', async () => {
    const groundComponentMock = vi.fn();
    vi.doMock('@/lib/services/inspoGrounding', () => ({ groundComponent: groundComponentMock }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { componentType: 'Button', groundWithInspo: false },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    expect(groundComponentMock).not.toHaveBeenCalled();
  });

  it('does not call groundComponent for a job with an absent/unrecognized componentType (backward compat)', async () => {
    const groundComponentMock = vi.fn();
    vi.doMock('@/lib/services/inspoGrounding', () => ({ groundComponent: groundComponentMock }));
    vi.doMock('@/lib/services/ComponentGenerator', () => ({
      getComponentGenerator: () => ({ generate: vi.fn().mockResolvedValue({ path: 'out.html' }) }),
    }));
    vi.resetModules();
    const { processJob } = await import('@/worker');

    const { userId } = await seedSession();
    const style = await styleService.create({ name: 'X', createdBy: userId, parameters: '{"colorAccent":"#3b82f6"}' });
    await styleService.update(style.id, userId, { groundWithInspo: true });
    // No componentType in options at all -- simulates a job queued before this field existed.
    const job = await jobService.create({
      styleId: style.id, assetType: 'component', prompt: 'A button', outputKind: 'component',
      options: { groundWithInspo: true },
      createdBy: userId,
    });

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    await processJob(row);

    expect(groundComponentMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workerGrounding.test.ts`
Expected: FAIL — `worker.ts` doesn't call `groundComponent` yet, so `options.grounded` is never set.

- [ ] **Step 3: Update worker.ts**

Add the import at the top of `worker.ts`:

```typescript
import { groundComponent } from '@/lib/services/inspoGrounding';
import { styleService } from '@/lib/services/StyleService';
```

Right after the existing `referenceImage`/`componentType` reads (added in Task 14) and before the
`try { let result... }` block, add the grounding attempt:

```typescript
  let groundingResult: { grounded: boolean; groundedReason?: string; referenceIsFallbackThumbnail?: boolean; colorMatched?: boolean } | undefined;
  let groundedReferenceImage: { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined;

  const shouldAttemptGrounding =
    job.output_kind === 'component' &&
    options.groundWithInspo === true &&
    !referenceImage &&
    typeof componentType === 'string';

  if (shouldAttemptGrounding) {
    const style = await styleService.getById(job.style_id);
    const colorAccent = style ? (JSON.parse(style.parameters || '{}').colorAccent as string | undefined) : undefined;
    if (colorAccent) {
      const outcome = await groundComponent({ styleId: job.style_id, componentType: componentType!, colorAccent });
      if (outcome.grounded) {
        groundedReferenceImage = outcome.referenceImage;
        groundingResult = { grounded: true, referenceIsFallbackThumbnail: outcome.referenceIsFallbackThumbnail, colorMatched: outcome.colorMatched };
      } else {
        groundingResult = { grounded: false, groundedReason: outcome.groundedReason };
      }
    } else {
      groundingResult = { grounded: false, groundedReason: 'no-accent-color' };
    }
  }

  const effectiveReferenceImage = referenceImage ?? groundedReferenceImage ?? null;
```

Then, everywhere the `'component'` case currently uses `referenceImage ?? undefined`, change it to
`effectiveReferenceImage ?? undefined`:

```typescript
      case 'component': {
        const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
        const providerOverride = buildOllamaOverride(options);
        if (basedOnContent !== undefined && typeof options.basedOnAssetId === 'string') {
          const resolved = await resolveComponentRegeneration({
            basedOnAssetId: options.basedOnAssetId,
            basedOnContent,
            instruction: job.prompt,
            styleId: job.style_id,
            componentType,
            referenceImage: effectiveReferenceImage ?? undefined,
            providerOverride,
          });
          if (!resolved.ok) throw new Error(resolved.message);
          result = { path: resolved.filename };
        } else {
          result = await getComponentGenerator().generate(job.prompt, job.style_id, componentType, effectiveReferenceImage ?? undefined, basedOnContent, undefined, providerOverride) as { path: string };
        }
        break;
      }
```

Finally, change the completion `UPDATE` statement to also persist `groundingResult` into `options`
when it was attempted:

```typescript
    const finalOptions = groundingResult ? JSON.stringify({ ...options, ...groundingResult }) : job.options;
    db.prepare(`UPDATE jobs SET status = 'complete', result_path = ?, options = ?, updated_at = ? WHERE id = ?`)
      .run(result.path, finalOptions, Date.now(), job.id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workerGrounding.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 5: Run the full existing worker test suite to confirm no regression**

Run: `npx vitest run` (locate and confirm any existing `test/worker*.test.ts` files still pass —
search first with `find test -iname 'worker*'` if unsure of the exact filename)
Expected: PASS across the whole suite.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker.ts test/workerGrounding.test.ts
git commit -m "feat: call Inspo grounding from worker.ts and record the outcome on the job"
```

---

## Task 19: Frontend — ground_with_inspo toggle on the Style Bible edit page

**Files:**
- Modify: `app/dashboard/styles/[id]/page.tsx`

**Interfaces:**
- Consumes: `PUT /api/styles/[id]` with `{groundWithInspo: boolean}` (Task 12).

No automated test — this page has no existing test file (same as every other button on this page);
covered by Task 20's manual verification.

- [ ] **Step 1: Add toggle state and handler**

Add, alongside the existing `renaming`/`nameDraft` state in `app/dashboard/styles/[id]/page.tsx`:

```typescript
  const [savingGrounding, setSavingGrounding] = useState(false);

  async function handleToggleGrounding() {
    if (!style || savingGrounding) return;
    setSavingGrounding(true);
    setError(null);
    try {
      const res = await fetch(`/api/styles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groundWithInspo: !style.ground_with_inspo }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not update grounding setting.');
        return;
      }
      setStyle(body.data);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSavingGrounding(false);
    }
  }
```

- [ ] **Step 2: Add the toggle markup**

Insert into the JSX, right after the existing owner-only Rename/Delete button row:

```tsx
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={!!style.ground_with_inspo}
              onChange={handleToggleGrounding}
              disabled={savingGrounding}
            />
            Use real-site references when generating components
          </label>
        </div>
      )}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/styles/\[id\]/page.tsx
git commit -m "feat: add ground_with_inspo toggle to the Style Bible edit page"
```

---

## Task 20: Manual verification — Feature 2 end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server and worker**

Run: `npm run dev` (background) and `npm run dev:worker` (background).

- [ ] **Step 2: Enable grounding on a Style Bible with a real colorAccent**

Open a Style Bible that already has a `colorAccent` set (or seed one via Feature 1's Inspo import,
or the existing W3C import), toggle "Use real-site references when generating components" on.

- [ ] **Step 3: Generate a Button component and confirm grounding fires**

From the Components page, generate a Button with that Style Bible. After the job completes, inspect
the asset/job — confirm `options.grounded` is `true` (or a specific `groundedReason` if Inspo had no
match) by checking the job row directly:

Run: `sqlite3 data.db "SELECT options FROM jobs ORDER BY created_at DESC LIMIT 1;"` (or open
`data.db` with any SQLite browser)

- [ ] **Step 4: Generate a Form component with the same Style Bible and confirm no cache collision**

Generate a Form component next. Confirm (via the same job-options inspection, or by checking
`inspo_reference_cache` directly) that Button and Form have separate cache rows despite both
mapping to Inspo's `cta` type:

Run: `sqlite3 data.db "SELECT component_type, image_url FROM inspo_reference_cache;"`
Expected: one row per component type, with potentially different `image_url` values.

- [ ] **Step 5: Confirm a user-uploaded reference image still overrides grounding**

Generate one more component with the style's grounding still on, but this time attach a manually
uploaded reference image. Confirm the job's options show `groundedReason: 'user-supplied-reference'`
is NOT what gets recorded — grounding should not run at all in this case (per `shouldAttemptGrounding`'s
`!referenceImage` condition in Task 18), so `options.grounded` should be absent, not false-with-reason.

- [ ] **Step 6: Confirm fail-soft behavior**

Temporarily set `groundWithInspo` on for a Style Bible whose `colorAccent` doesn't parse (or
disconnect network access briefly), generate a component, and confirm the job still completes
successfully (status `complete`, a real result) rather than failing.

---

## Self-Review Notes

- **Spec coverage:** Every section of the spec has a corresponding task — Background/GameForge
  shapes inform Tasks 2-6; Feature 1's UX and server design map to Tasks 7-11; Feature 2's UX and
  server design map to Tasks 12-20; the spec's error-handling table is implemented across the route
  handlers (Tasks 7-9) and `groundComponent`'s reason taxonomy (Task 17); the spec's testing
  strategy is realized as the per-task test files throughout.
- **Non-goals respected:** no Hallmark prompt-rule work, no mandatory grounding (Task 18's
  `shouldAttemptGrounding` gate), no local archive mirroring (only the bounded reference-image and
  DESIGN.md caches), no Inspo self-hosting.
- **Type consistency check:** `ThemeTokens`, `FieldProvenance`, `MapDesignMdResult` (Tasks 5-6) are
  consumed unchanged by Tasks 7-8's routes. `InspoComponentResult` (Task 4) is consumed unchanged by
  `selectGroundingCandidate` (Task 16). `GroundingOutcome` (Task 17) is consumed unchanged by
  `worker.ts` (Task 18). `groundWithInspo` (boolean, camelCase) vs. `ground_with_inspo` (0/1,
  snake_case DB column) naming is kept consistent with this codebase's existing `is_deleted`/
  `isDeleted`-style convention throughout every task that touches it (12, 14, 18, 19).
- **One deliberate simplification, called out explicitly:** Task 8's `__source.capturedAt` is
  stored as `null` rather than threading the value the preview route already computes, to avoid
  trusting an unverified client-supplied date. This is a narrower behavior than the spec's literal
  text implies but doesn't violate anything the spec's own error-handling table or tests require —
  flagged here rather than silently deviating.
