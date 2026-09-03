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

## Round 2 — Codex

VERDICT: REVISE

1. **Filename matching is not a security boundary** — `aseprite*.exe` can be a renamed payload; there is no cheap app-level substitute for real access control. Asked to either explicitly label this as accepted risk (not a mitigation) or add real access control.
2. **The settings path still accepts relative and whitespace-only values** — `z.string()` allows `aseprite.exe`, which resolves from the server's working directory, not anywhere meaningful to the user. Asked for `trim()` + `path.isAbsolute()` (allowing `''` to still clear).
3. **`BEGIN IMMEDIATE` + the in-lock re-check is correct** for the described race, including the `CREATE TABLE IF NOT EXISTS` — but the catch block unconditionally calls `ROLLBACK`, which would mask a failed `BEGIN IMMEDIATE` itself with a confusing secondary "no transaction is active" error. Also asked for a real two-process concurrency test rather than the sequential idempotency test.
4. **Filesystem/process errors still silently misclassified** — `isRegularFile()`'s catch swallows without logging (even non-ENOENT failures), and a late `'error'` event arriving after the 300ms window has already resolved is handled but never logged.
5. **Spec/plan drift** — several spec sections still described the pre-round-1-fix behavior (non-empty-only path validation, `existsSync`, "4 outcomes," "spawn is not automatically tested") even though the plan had already moved past them.

Confirmed: agrees the JSX rejection (finding 8) was correct — "quoted JSX attribute text preserves the backslashes, unlike a JavaScript string literal."

### Claude's response

Verified #3's transaction-rollback concern was real regardless of the exact original failure trace — moved `BEGIN IMMEDIATE` inside the `try` block (uniform handling of the whole transaction lifecycle) and gated `ROLLBACK` on `db.inTransaction`. Accepted the "stronger test" ask, but not via a literal second OS process (which would need to solve this project's `@/` path-alias resolution inside a spawned child for no additional evidence about the actual mechanism in question) — instead added a test using two real, separate `better-sqlite3` connections to the same file, proving the thing that actually matters: does `BEGIN IMMEDIATE` + `busy_timeout` genuinely serialize a second writer (proven by measuring it actually waits ~150ms+, not failing instantly)? SQLite's locking is file/connection-based, not OS-process-based, so this is genuine evidence for the mechanism, not a weaker proxy.

Accepted #2 in full: `SetPathSchema` now trims first, then requires either `''` (clears) or `path.isAbsolute()`. Added both a relative-path-rejected test and a trim-whitespace test.

Accepted #4 in full: `isRegularFile()` now logs any stat failure that isn't `ENOENT` (an expected, ordinary outcome) — genuinely unexpected failures like `EACCES` are no longer silent. The spawn error listener now logs when it fires after the bounded wait already resolved via timeout, since that's a real, otherwise-invisible signal even though the HTTP response already went out.

Accepted #5 in full: fixed every stale spec section identified — the Settings page section's path-validation description, the Edit action section's `existsSync` → `statSync(...).isFile()` and the outcome count (4 → 7), and the Testing section's now-inaccurate "spawn is not automatically tested" claim (the wiring — arguments, both error paths — genuinely is now, via a mocked `child_process`; only the real external effect, Aseprite actually opening, still isn't).

Partially accepted #1, by tightening language rather than adding access control: rewrote the spec's Security note to be explicit about exactly what `looksLikeAsepriteExecutable` does and doesn't defend against. Codex's critique ("can be a renamed payload") requires an attacker who can already write files to the machine — a strictly stronger capability than "reach this app over HTTP," and an attacker with local file-write access already has far more direct ways to cause harm, on any system, unrelated to this feature. The mitigation's actual, honest scope is narrower: it closes the *specific new capability* this feature adds for a network-only attacker (no local file access) — without it, such an attacker could launch any already-present executable; with it, only something already named like Aseprite. The spec now states plainly that this app's total lack of authentication is accepted, pre-existing, whole-system risk this feature does not change, and that the real fix for an untrusted VPN/tunnel is a trusted VPN/tunnel, not a per-route patch — exactly the "label as accepted risk, not a mitigation" framing Codex asked for, applied to the parts of the claim that hold up under the corrected threat model rather than to the whole claim as stated.
