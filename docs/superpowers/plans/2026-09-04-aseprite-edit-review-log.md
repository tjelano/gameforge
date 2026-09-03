# Plan Review Log: Edit in Aseprite

Plan under review: `docs/superpowers/plans/2026-09-04-aseprite-edit.md`
Spec: `docs/superpowers/specs/2026-09-04-aseprite-edit-design.md`
Started 2026-09-04. MAX_ROUNDS=5. Codex model: gpt-5.6-terra (reasoning effort: high, CLI default, unpinned).

## Round 1 — Codex

VERDICT: REVISE

1. Remote callers (README explicitly documents VPN/tunnel access as supported) can `PUT` an arbitrary Aseprite path, then `POST` to launch it — unauthenticated remote code execution, since the app has no auth anywhere.
2. `asset.image_path` has no format validation in `AssetSchema` (`z.string().nullable()`), and git-imported asset JSON goes through `AssetSchema.parse()` unchecked — a crafted `image_path` containing `../` could resolve outside `storage/images` when `path.join()`'d.
3. `child_process.spawn()`'s failure mode is an asynchronous `'error'` event, not a synchronous throw — the plan's `try/catch` around the spawn call won't catch it, and an unhandled `'error'` event on a Node EventEmitter crashes the process.
4. The settings `PUT` route rejects an empty string (`z.string().min(1)`), but Task 5's own manual-verification step requires temporarily clearing the path — the plan is internally inconsistent, there's no way to clear it via the UI it just built.
5. `decideEditAction` only checks `fs.existsSync`, not that the path is actually a regular file — a directory or otherwise-invalid path passes the check and produces a confusing spawn failure.
6. `DatabaseConnection.runMigrations()` reads applied-migrations state once, then applies each file in its own transaction — two processes calling `getInstance()` around the same time (this app's own documented normal startup: `npm run dev` + `npm run dev:worker` in two terminals) can both decide a migration is unapplied and both try to run it, and the second one fails on already-existing schema objects.
7. The new Settings page's mount `useEffect` has no `try/catch`/`finally` — a failed fetch or bad JSON leaves `loading` stuck `true` forever, unlike every other page in this codebase using the same ignore-flag pattern (which all have this).
8. The plan's example JSX has `placeholder="C:\Program Files\Aseprite\Aseprite.exe"` — invalid JS escape sequences silently mangle the rendered placeholder text.

### Claude's response

Verified all 8 findings against the live codebase before acting (not just trusting the critique):
- README (`README.md:21-22`) does say "put it behind your own VPN or tunnel" — #1 is a real, documented exposure path, not speculative.
- `lib/database/schema.ts:29` confirms `image_path: z.string().nullable()` — no format check. `app/api/images/[filename]/route.ts:17-20` already has the exact traversal guard this route needs (`includes('/') || includes('\\') || includes('..')`) — #2 confirmed, and there's already an established pattern to mirror.
- `lib/database/index.ts:44-91` confirmed: `appliedNames` read once at line 68-69, before the per-file loop — #6 confirmed as a real, pre-existing, live-reachable race (not specific to this feature, but this app's own documented startup procedure hits it on every restart after a new migration is added).

Accepting and revising the plan for #2, #3 (attach an `.on('error', ...)` listener so an async spawn failure logs instead of crashing the server, plus a short bounded wait to report launch failures accurately instead of a blind "success"), #4 (drop `.min(1)` — empty string already means "unset" everywhere else in the decision logic, no new endpoint needed), #5 (upgrade to `fs.statSync(...).isFile()`), #7, #8 — all folded into the plan below.

Partially accepting #1: building real network-level auth is out of proportion for this feature (the whole app has zero auth on every other route already — git push/pull, asset deletion, spending real API credits are all equally unauthenticated today; singling out just this route for a bespoke access-control mechanism that Next.js App Router doesn't cleanly support without a custom server would be inconsistent and disproportionate). Instead: restrict the configured path to a filename matching `/^aseprite.*\.exe$/i` (case-insensitive, via `path.basename` — slightly looser than the literal `aseprite.exe` first floated here, to allow legitimate self-built binaries with version suffixes), closing the sharper edge of #1 — "launch any already-present executable" — down to "only ever launches something named aseprite*.exe." Documenting the residual risk explicitly in the spec's Security note rather than pretending a partial fix eliminates it. Asking Codex for a reaction to this trade-off in round 2, plus the specific `BEGIN IMMEDIATE` fix proposed for #6, since both are real design decisions worth a second opinion rather than solo judgment calls.

**Rejecting #8, with proof.** Compiled the plan's exact JSX (`placeholder="C:\Program Files\Aseprite\Aseprite.exe"`, written as a bare quoted JSX attribute, not a `{'...'}` expression) through this project's own TypeScript compiler (`npx tsc --jsx react`) to see the actual generated JS: it produces `placeholder: "C:\\Program Files\\Aseprite\\Aseprite.exe"` — correctly double-escaped, backslashes intact. JSX attribute string literals are not parsed with JavaScript string-escape rules (unlike an actual JS string literal `'...'`, which is what #8's stated failure mode requires) — the compiler treats quoted JSX attribute text as raw, HTML-attribute-like content and re-escapes it correctly when generating `createElement` calls. The plan's original code was already correct; no change made.
