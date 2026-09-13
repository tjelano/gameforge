# Plan Review Log: Reverse-sync between dashboard and exported/edited site
Started 2026-09-11. Reviewer: DeepSeek V4 Flash (deepseek-review skill, Codex unavailable).

## Mechanics note
The plan (2299 lines / ~99KB) is far larger than a single chat-completion payload this proxy can
reliably handle. Discovered through bisection: a ~23KB message works, ~62KB gets HTTP 200 but the
model hallucinates a tool call instead of replying (no `tools` were ever passed), and ~97KB+ gets
a hard HTTP 500 "Unexpected proxy error." Cumulative history size (not just the new message) also
counts — a continuous resumable thread hit the wall by round 3 even though each individual message
was small. Worked around by reviewing the plan in 8 independent (non-resumed) chunks of roughly
one task each, each under ~20KB, each reminded inline that the model has no tool/filesystem access.
Even so, the proxy intermittently 500'd on some chunks regardless of size (2 of 3 retries failed on
one chunk that succeeded on the 3rd try with byte-identical content) — matches the documented
2026-09-08 outage precedent: genuine upstream flakiness, not a deterministic size cutoff.

4 of 8 chunks got a real DeepSeek pass: design spec, global constraints + Tasks 1-2, Tasks 3-4,
Task 6. Tasks 5, 7, 8, 9, 10 exhausted 3 retries each with HTTP 500 and got Claude's own manual
line-by-line review instead (reading the actual plan code directly, same rigor as the DIFF-mode
cross-check in the audit-fixes precedent).

## Findings, as verified against the real codebase (not taken on faith)

### Real, actionable
1. **Page-level hand-edits aren't protected on re-export (Task 4 gap) — CONFIRMED.** Task 4 adds
   hash-check-and-skip protection only for component files (`.tsx`/`.module.css`). `page.tsx`
   files are unconditionally regenerated and overwritten by every re-export (Task 3's write loop,
   never hash-gated in Task 4). A user who hand-edits `page.tsx` directly (reorders tags, adds
   custom JSX) loses that edit if a re-export happens before they run "Check for changes." This
   undercuts the feature's stated goal ("never silently clobber hand-edits"). Fix: extend Task 4's
   exact same pattern to page files — compare on-disk hash against the manifest's `pageFileHash`
   before overwriting, skip + report if it diverged, mirroring the component logic already built.
2. **Sync preview/apply routes don't participate in the Task 5 export lock — CONFIRMED.** Read
   both route implementations directly: neither checks nor acquires the lock. A re-export running
   concurrently with a sync preview/apply can race on the manifest file or the export directory's
   on-disk state. Fix: have preview/apply check the lock's heartbeat file (read-only, no need to
   acquire) and return a "try again, export in progress" error if live — reuses Task 5's existing
   lock file.
3. **Stale-lock recovery has no ownership fencing — CONFIRMED, low severity.** `release()`
   unconditionally `rm`s whatever sits at the lock path; if the original holder resumes after a
   long stall (OS suspend, GC pause) past the 2-minute staleness window, it can delete a second
   claimant's lock rather than its own — classic lease-without-fencing-token. Realistic risk is low
   for this app (manual, infrequent exports, not a crash-prone distributed system), but the fix is
   cheap: write a random token into the lock dir at claim time, have `release()` verify it first.

### Minor / documentation-level, not blocking
- `readManifest`'s error logging is inconsistent (EACCES gets logged, a malformed-JSON file
  doesn't) — cosmetic, behavior (`return null`) is correct either way.
- `Asset.edited_externally` is `0|1` at the schema/DB layer but `boolean` at the service-call
  layer — already converted correctly in the plan's own code, just worth calling out explicitly so
  Tasks 8/10 don't get confused.
- Task 4's prose instruction to "remove the old lines" when restructuring the write loop is vague
  without the surrounding file open — low risk since the plan already shows the full replacement
  block, but worth reading the current `SiteExporter.ts` alongside it during implementation.
- `componentsExported` isn't decremented when components are skipped — the plan already flags
  checking `test/siteExportRoute.test.ts` for this; no separate action needed.

### Raised, checked against real code, and rejected as false
- "Migration test never applies the migration" — **false**. `DatabaseConnection.getInstance()`
  auto-runs every `.sql` file in the migrations directory ([lib/database/index.ts:20](../../../lib/database/index.ts#L20)); the test's `beforeEach` copies the new
  migration into the temp project root before the first `getInstance()` call, same pattern as
  every other migration test in this repo.
- "Task 4's re-export tests write files under the wrong path (`tempRoot` vs `getProjectRoot()`)" —
  **false**. `setProjectRootForTests(tempRoot)` sets the module-level cached root directly
  ([lib/utils/projectRoot.ts:45-48](../../../lib/utils/projectRoot.ts#L45-L48)); `getProjectRoot()` returns exactly `tempRoot` for the rest of the test, so the
  paths match.
- "Hash newline mismatch between write-time and read-time concatenation breaks hand-edit
  detection" — **false**. Node's `fsPromises.writeFile` writes the string byte-for-byte with no
  appended newline; `buildComponentFile()` is a pure function of the same component data, so the
  written, the re-read, and the hashed-at-manifest-time strings are identical.
- "ExportSync's page.tsx reads aren't error-protected" — **false**. They are — wrapped in
  try/catch with `console.error` + `continue` (plan lines ~1362-1368).
- "`pageService.getActivePagesForStyle`'s soft-delete contract is unclear" — **false**. Read
  [lib/services/PageService.ts:14-20](../../../lib/services/PageService.ts#L14-L20) directly: it filters `is_deleted = 0` explicitly.
- "`droppedDeletedAssetIds` isn't surfaced downstream" — **false**. Task 9's UI renders it
  explicitly (the `syncDiff.droppedDeletedAssetIds.length > 0` block).
- "Task 8's route is missing an ownership/auth check" — **false**, and backwards. Task 8
  explicitly mirrors the existing job-level edit route; read [app/api/jobs/[id]/component/route.ts](../../../app/api/jobs/[id]/component/route.ts)
  directly — it has **no** login check at all. Task 8 actually adds a `getCurrentUser` gate that
  the route it mirrors doesn't have, making it stricter, not weaker.
- Several smaller speculative items (duplicate-component ordering, component file naming drift,
  multi-line JSX tag regex limits beyond what the spec already documents, DB test isolation across
  parallel Vitest runs) were checked against the actual diff/order logic and the established
  per-test temp-root isolation pattern used throughout this codebase — none hold up as real gaps
  given how this app actually works.

## Resolution
Two real, moderate-severity gaps (findings 1 and 2) and one low-severity one (finding 3). None were
deadlocked disagreements — all are straightforward extensions of patterns the plan already uses
elsewhere (Task 4's own hash-check-skip logic, Task 5's own lock file).

User chose to revise. Plan updated:
- **Task 4**: added a `writePageIfUnedited` helper mirroring the existing component hash-check-skip
  exactly, applied to both the home page and the per-page loop; `SiteExportResult` gains
  `skippedPages: string[]` alongside `skippedComponents`; added a failing test for the hand-edited-
  page-gets-skipped case; updated the Final Verification manual walkthrough to cover it too.
- **Task 5**: added an exported `isExportInProgress(subdir): Promise<boolean>` read-only lock
  check (reuses the existing lock path and staleness logic, doesn't acquire); added 3 tests.
- **Task 7**: both `preview` and `apply` now call `isExportInProgress` before touching the export
  directory or DB, returning 409 if a re-export is in flight; added 1 test to each route.

Finding 3 (lock recovery has no ownership fencing) deferred — low realistic risk for this app's
actual usage pattern (manual, infrequent, single-admin exports, not a crash-prone distributed
system), and the existing two fixes already close the gaps with real user-visible impact. Revisit
if this ever runs somewhere exports get genuinely concurrent or crash-prone.
