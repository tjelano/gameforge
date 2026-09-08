# Plan: Fix 3 gaps from the 2026-09-08 audit
_Round 0 — initial draft by Claude_

## Goal
Fix three real, verified gaps found during a codebase audit: (1) Pages and Presets never
propagate across machines via git sync, (2) Git LFS is required but never checked/installed
during setup, (3) a real TOCTOU race in Site Export's directory-creation check. A fourth
audit finding (Pages having no ownership check) was investigated and dropped — Presets,
Assets, and Jobs all have the identical, deliberately-documented "no ownership check, shared"
design; only Style Bibles get creator-owns-it/fork-to-modify. The user confirmed: leave Pages
consistent with that precedent, don't make it the odd one out.

## Approach

### 1. Sync Pages and Presets via git
- Add `getAll()` to `PresetService` and `PageService` — `SELECT * FROM <table> ORDER BY
  created_at DESC`, no `is_deleted`/`style_id` filter, mirroring `StyleService.getAll()` /
  `AssetService.getAll()` exactly (soft-deletes must sync too, or a delete on one machine
  never reaches another).
- Add `'data/presets'` and `'data/pages'` to `GitService.ts`'s `DATA_DIRS`.
- `exportToJson()`: write one JSON file per preset (`preset-${id}.json`) and per page
  (`page-${id}.json`), same shape as the existing styles/assets loops.
- `importFromJson()`: add import loops for presets and pages, using the same
  `ON CONFLICT(id) DO UPDATE SET ...` pattern as styles/assets. **Order matters**: pages have
  `style_id TEXT NOT NULL REFERENCES styles(id)` (a real FK), so pages must import AFTER
  styles. Presets have no FK to anything sync-relevant. New order: users → styles → assets →
  presets → pages.
- `assertNoConflictMarkers()` already iterates `DATA_DIRS`, so the two new dirs are covered
  with no separate change.
- New tests `test/gitServicePages.test.ts` / `test/gitServicePresets.test.ts`, mirroring
  `test/gitServiceUsers.test.ts`'s real-temp-SQLite + real-temp-project-root pattern: export
  writes JSON, import round-trips into a fresh DB, and one test proving import order doesn't
  FK-fail (create a style + a page referencing it, export, reset DB, import, assert the page
  imported without error and is attached to the right style).

### 2. Git LFS setup check
- `setup.sh`: after the existing `git` presence check, check for `git-lfs`
  (`command -v git-lfs`). If present, run `git lfs install` (idempotent, safe to run every
  time). If absent, print a warning (not a hard exit — matches the existing "no origin remote"
  warn-and-continue precedent right above it) that PNG/JPG/GLB/GLTF assets need Git LFS or
  they'll be committed as regular blobs instead of pointers.
- `setup.bat`: same check via `where git-lfs`, same warn-don't-exit behavior.

### 3. Fix the TOCTOU race in Site Export
- `SiteExporter.exportSite()` currently does `fsPromises.access(targetDir)` (throws ENOENT if
  free) then, later, `fsPromises.mkdir(path.join(targetDir, 'app'), {recursive:true})` —
  `recursive:true` never throws EEXIST even if `targetDir` now exists, so two exports racing on
  the same subdir both pass the access-check and interleave writes into the same folder.
- Fix: replace the access-check with a single atomic `fsPromises.mkdir(targetDir)`
  (non-recursive) wrapped in try/catch — `EEXIST` becomes the `ALREADY_EXISTS` result, any other
  error rethrows (matches the existing "don't silently swallow non-ENOENT errors" comment style
  already in this file). Add a defensive `mkdir(storage/exports, {recursive:true})` immediately
  before it, so this doesn't depend on `setup.sh` having created that parent dir already —
  matches the existing `ensureDirectoriesExist()` defensive pattern used elsewhere in
  `GitService.ts`. All nested mkdirs after this point stay `{recursive:true}` since `targetDir`'s
  uniqueness is now guaranteed by the atomic top-level create.
- New test in `test/siteExporter.test.ts`: fire two `exportSite()` calls at the same subdir via
  `Promise.allSettled`, assert exactly one resolves with a real result and the other resolves
  with `{error:'ALREADY_EXISTS'}` — never both "succeeding".

## Key decisions & tradeoffs
- Pages/Presets import order (users → styles → assets → presets → pages) is load-bearing:
  wrong order FK-fails the whole import on any machine pulling for the first time.
- Not touching Pages' ownership model — confirmed with the user, matches 3 other entities'
  identical documented precedent.
- Not building a generic multi-provider LLM abstraction for the cheaperinference
  Anthropic-shape-vs-OpenAI-shape coupling found in the same audit — no second content-generation
  backend has been requested yet; that's speculative work, out of scope for this PR.

## Risks / open questions
- None load-bearing; this is 3 bounded, independently-testable fixes in files this project
  already has strong real-SQLite/real-git test coverage for.

## Out of scope
- The cheaperinference provider-coupling finding (documented, not fixed — see above).
- Any new sitemap-AI / competitor-parity feature work from the same audit (separate backlog
  decision, not a bug fix).
