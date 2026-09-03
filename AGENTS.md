<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md - GameForge AI Directives

## STRICT RULES FOR AI CODE GENERATION

### FORBIDDEN
- ❌ Wrapper classes around existing services
- ❌ DTOs (use Zod schemas directly)
- ❌ Factory patterns
- ❌ Repository patterns (use DataStore directly)
- ❌ Custom error classes (use standard Error)
- ❌ Utility libraries (lodash, ramda, etc.)
- ❌ Storing URLs in the database (store filenames only)
- ❌ Aliasing a single fs import to serve both sync and async calls —
  when a file needs both, import them under distinct names:
  `import fs from 'fs'` and `import fsPromises from 'fs/promises'`

### REQUIRED
- ✅ Flat, procedural logic over deep nesting
- ✅ Direct SQL queries over ORM
- ✅ Direct Zod validation over DTOs
- ✅ `try/catch` for ALL file system operations, with logging on error
- ✅ `fs.mkdir(dir, { recursive: true })` before every file write
- ✅ `path.join(getProjectRoot(), ...)` for all physical paths
- ✅ Check `signal?.aborted` immediately in async generators
- ✅ Disable UI buttons on submission to prevent double-click
- ✅ Extract shared helpers for safety-critical logic on sight —
  not once it's been copy-pasted a certain number of times

### POSITIVE BEHAVIORAL MODEL
- ✅ **Flat over nested:** A 50-line route handler is BETTER than splitting across files.
- ✅ **Direct over abstracted:** Use direct SQL and direct Zod validation.
- ✅ **Simple over generic:** Write specific code that does exactly one thing well.
- ✅ **200-line guideline:** Not a rigid limit. Prefer readability over artificial fragmentation.

## Project-specific notes (learned during implementation, not in the original blueprint)

- **Schema**: `styles`/`assets`/`jobs` columns and the `jobs.status` enum
  (`pending | processing | complete | promoted | discarded | failed`) were designed during
  implementation — the blueprint never pinned these down. See `lib/database/schema.ts` (Zod, source of
  truth for shapes) and `lib/database/migrations/001_init.sql` (actual columns).
- **No auth system.** `created_by` is a client-persisted UUID (`lib/utils/clientId.ts`), not a real user
  account. The "only the creator can edit" rule still holds, it just isn't backed by real authentication.
- **`cleanupOrphanedImages()` protects in-flight job images** (`pending`/`processing`/`complete`), not
  just asset images — confirm this is still the intended behavior before changing it; it was an inferred
  design decision, not an explicit requirement.
- **Testing**: migration 004, `resolveConflicts()`, and `cleanupOrphanedImages()` all have tests that run
  against a real (temporary) SQLite file and/or a real (temporary) git repo — not mocks. Follow that
  pattern for new git-sync or migration logic: `setProjectRootForTests()` +
  `DatabaseConnection.resetForTests()` point both at an isolated temp directory per test.
- **Real Pixellab generation is wired up** (`lib/services/PixellabGenerator.ts`, `create-image-pixflux`
  endpoint, schema confirmed against their live OpenAPI spec). `getImageGenerator()` in
  `lib/services/ImageGenerator.ts` picks Pixellab vs `MockGenerator` based on `PIXELLAB_API_KEY` —
  **lazily, on first call, not at module-import time.** This matters: `next dev` auto-loads `.env.local`,
  but a bare `tsx worker.ts` process does not, so `dev:worker` passes
  `--env-file-if-exists=.env.local` explicitly. If `imageGenerator` were an eagerly-constructed
  module-level constant instead of a lazy getter, ESM import hoisting would evaluate it before that flag's
  env vars even land in `process.env`, silently falling back to the mock. Caught this by actually running
  the worker as a separate process and watching it produce `mock-*.png` instead of `pixellab-*.png` — the
  same class of bug as the promotion-idempotency one, only found by executing, not reading.
- **Fork lineage**: `styles.forked_from` (migration 005) is a nullable self-reference, set by
  `StyleService.fork()`. The Style Bibles page resolves it to a parent name by looking it up client-side
  in the same already-fetched active-styles list — falls back to a short id if the parent was
  soft-deleted (so isn't in that list).
