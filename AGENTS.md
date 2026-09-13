<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md - GameForge AI Directives

## Start here (read before anything else)

A session has no memory of prior sessions unless it checks for one. Do this first, every time:

1. **Check for in-progress SDD work** — `git worktree list`, then for each one under
   `.claude/worktrees/`, check `.superpowers/sdd/*/progress.md` for a ledger. A ledger's first line
   names its plan file; lines like `Task N: complete` are done, the first task without one is where
   to resume. Don't assume a feature is unstarted or finished without checking — a branch can look
   abandoned and still have 30 committed, reviewed tasks sitting on it.
2. **Check `docs/superpowers/plans/`** (sorted by date) for the most recent plan — it's the closest
   thing to "what was being worked on." Its paired spec under `docs/superpowers/specs/` has the
   reasoning; the plan has the task breakdown.
3. **Treat this file's "Shipped Features" list below as a snapshot, not a guarantee** — verify
   anything load-bearing against the actual code/git log before relying on it (the "No auth system"
   line below this sentence used to be wrong for months before someone checked).
4. **Use the `deepseek-review` skill proactively, without being asked, at BOTH the plan level and the
   per-task diff level** — it costs fractions of a cent per call (55 requests across a whole session
   billed $0.03 total; a 34-task plan re-review across 6 chunks was ~$0.02), so cost is never a
   reason to skip it. Two uses, both worth doing every time, not just for security-sensitive tasks:
   (a) before starting execution of any multi-task SDD plan, run it plan-wide (chunk by ~30-40KB
   section if the plan is long — the proxy has a real, non-deterministic payload ceiling around
   there) — caught a real, load-bearing bug this way in the 2026-09-12-audit-fixes plan (Tasks
   26/29's swallowed-error bug, see that plan's paired `*-review-log.md`) that would otherwise have
   propagated through 5+ downstream UI tasks; (b) run a DeepSeek diff review (Mode 2, single-pass PR
   -style) on each task's diff too, alongside — not instead of — the Claude task-reviewer. This was
   originally written down as redundant with the task-reviewer gate; that was wrong, and the user
   corrected it in the same session: a fresh Claude task-reviewer subagent is still the *same model
   family* reviewing another Claude subagent's work, which is exactly the "echo chamber" cross-model
   review exists to break, even with fully isolated context. Retroactively running it on Tasks 1-4
   found zero real defects (all false positives, since DeepSeek has no filesystem access and mostly
   guesses wrong) — but that's still worth confirming, especially on a security-sensitive diff, for
   the same reason a clean test run is worth having even when you expected it to pass. Verify every
   finding from either mode against the actual code/plan text yourself before acting — you are the
   final arbiter, not DeepSeek; expect roughly 1-in-5 "Important" findings to hold up, not more.
5. **Run `npm run lint` as a standard part of every task's own verification, not just `npx vitest
   run && npx tsc --noEmit`.** CI (`.github/workflows/ci.yml`) runs Typecheck, Lint, and Test as 3
   separate required steps — a plan whose tasks/reviewers only ever ran the first and third will
   pass every gate locally and still fail CI on push. This has happened twice already (PR #23's
   `react-hooks/set-state-in-effect` + pre-existing `react/no-unescaped-entities`; the
   `2026-09-13-ollama-generation-backend` plan's own identical `no-unescaped-entities` pair plus a
   fresh `set-state-in-effect` in a brand-new effect, caught only after the PR was already open).
   Lint locally before pushing, not after CI fails — `npx eslint app lib worker.ts` (scoping to the
   real source tree; a bare `npx eslint .` also sweeps other git worktrees and `.next` build
   artifacts on this machine and produces thousands of irrelevant hits).

## Shipped Features (chronological, by merged PR — see `git log --merges --oneline main` for the
authoritative, up-to-date list; this is a snapshot as of PR #22)

Style Bibles, asset generation (sprites/themes/components), Godot export → seed theme library →
theme export formats → contrast checking → dedup/multi-candidate generation → live theme tweaking
→ component generation/preview/theming → **login/auth** (PR #12 — session-cookie login, pick-your-
name-no-password, first account created is admin; see `lib/services/SessionService.ts`) → Google
Drive sharing → Style Hub export/share, stack/prompt presets → Page Composer, Site Export (hand-
editable Next.js site export) → `audit-fixes-pages-presets-sync` (PR #18) → image input (reference
images for generation) → W3C design tokens import → AI page-layout suggestion → **reverse-sync**
(PR #22 — hand-edited exported-site changes sync back into the dashboard; see
`docs/superpowers/specs/2026-09-09-reverse-sync-design.md`).

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
- **Real session-based auth exists** (PR #12, `lib/services/SessionService.ts`) — pick-your-name-no-
  password login (`app/login/LoginForm.tsx`), server-side session tokens (`sessions` table,
  `crypto.randomBytes(32)`, 90-day expiry), first account created becomes admin. `created_by` on
  styles/assets/jobs is a real user id, not a client-persisted UUID. Ownership checks
  (`requestingUserId` + `isAdmin` params, `{error:'FORBIDDEN'}` returns) are being retrofitted onto
  services one at a time — see `docs/superpowers/plans/2026-09-12-audit-fixes.md` Part A. Before
  assuming a given route/service checks ownership, check it directly; this file won't necessarily be
  updated task-by-task as that plan lands.
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
