# Plan Review Log: Website Theme Generation implementation plan

Started 2026-09-04. MAX_ROUNDS=5.
Plan under review: docs/superpowers/plans/2026-09-04-website-theme-generation.md
Spec: docs/superpowers/specs/2026-09-04-website-theme-generation-design.md
Codex model: gpt-5.6-terra (reasoning effort: high) — CLI default from ~/.codex/config.toml, not pinned.
Thread: 01a06a32-0583-7201-b8d0-2cee5ee7a586

## Round 1 — Codex

Revise the plan before implementation.

**Data and queue**
- `AnthropicThemeGenerator.generate()` ignores `_styleId` and sends only `prompt`; it does not include Style Bible `parameters` as the spec requires. Fix: load the style by ID and build the Anthropic message from bounded parameters plus the job prompt.
- Migration 008 permits arbitrary `output_kind` text; one bad row makes `JobSchema.parse()` fail and can break `/api/jobs/active`. Fix: add `CHECK (output_kind IN ('image','theme'))` and test invalid inserts.
- The unique `assets.image_path` index and promotion lookup ignore `output_kind`; identical filenames in separate directories collide and promote the wrong asset. Fix: replace the index with `(output_kind, image_path)` and query existing assets by both fields.
- `MockThemeGenerator` names files with `Date.now()` only; concurrent worker jobs can overwrite one CSS file and collapse promotions. Fix: include `crypto.randomUUID()` in mock filenames.
- Theme jobs still parse and validate UI-sheet `options.pieces` before the planned output-kind branch, despite the plan claiming otherwise. Fix: reject non-empty theme options at `/api/generate` and branch before image-only option parsing.

**File lifecycle and sync**
- Retry and discard/delete call `deleteFileIfSafe()`, which always deletes from `storage/images/`; theme CSS is leaked. Fix: make the safety/delete helper select storage by `output_kind` and update both job routes.
- Git sync is omitted: `GitService` creates, stages, cleans, and restores only `storage/images/`, while asset import also omits `output_kind`. Fix: add theme-aware import/export/staging/cleanup and a real Git round-trip test.
- Existing Git asset JSON lacks `output_kind`; making `AssetSchema` require it breaks imports from older repositories. Fix: use `OutputKindSchema.default('image')` for imported rows and test an old JSON asset.
- Asset detail still renders `/api/images/*.css` and offers "Edit in Aseprite"; Godot export also tries to copy theme CSS from `storage/images/`. Fix: render a theme iframe and suppress image-only controls, and explicitly skip themes in Godot export.
- Cleanup can delete a CSS file after it is written but before `worker.ts` persists `result_path` — the "safe any time" claim is false. Fix: protect newly written files with a short mtime grace period or persist a protected processing path before writing.

**Security and reliability**
- Token fields are merely non-empty strings, then interpolated directly into CSS; a model/prompt can inject arbitrary declarations and network-fetching CSS into an unsandboxed same-origin iframe. Fix: strictly validate each token grammar/allowed font stack, add iframe `sandbox`, and set a restrictive CSP for preview documents.
- `/api/generate` accepts unbounded prompts and has no rate/cost control despite reaching a paid Anthropic key through an unauthenticated app. Fix: cap prompt/options sizes and restrict or rate-limit generation before exposing it beyond localhost.
- The Anthropic request has no timeout, while processing jobs have no stale-job recovery; a hung fetch leaves jobs stuck indefinitely. Fix: use `AbortSignal.timeout()` and mark/log timeout failures.
- The planned generator snippets violate the project's filesystem rule: `mkdir`/`writeFile` are not locally wrapped and logged. Fix: wrap each theme write sequence with path-specific `console.error` logging, then rethrow.
- Tests cover only happy paths; they miss style-parameter prompt construction, cross-kind filename collisions, retry/discard deletion, old Git JSON, Git CSS staging, CSS injection, and cleanup/write interleaving. Fix: add targeted tests for each before manual verification.

VERDICT: REVISE

### Claude's response

Verified every claim against the live codebase before acting (read PixellabGenerator.ts, GitService.ts, assetSafety.ts, the asset detail page, GodotExporter.ts, migration 004, importFromJsonFields.test.ts, push.test.ts). Findings and dispositions:

**Accepted and fixed:**
- Style Bible parameters never reached the Anthropic prompt — confirmed real. Added `buildThemePrompt()`, wired `AnthropicThemeGenerator` to call `styleService.getById(styleId)`. Note: the spec's own justification for this ("mirrors how pixel-art already does it") is factually wrong — `PixellabGenerator.generate()` accepts but never reads `styleId`. Kept the requirement (it's load-bearing regardless — Claude has no non-text style channel), flagged the spec's inaccurate framing in the plan header instead of silently absorbing it.
- Missing CHECK constraint — added `CHECK (output_kind IN ('image','theme'))` to migration 008, plus rejection tests.
- MockThemeGenerator filename collision — added `crypto.randomUUID()` suffix, matching AnthropicThemeGenerator's existing scheme.
- Theme jobs could carry UI-sheet options — added an explicit reject at `/api/generate` before job creation (not just a worker-side branch reorder).
- `deleteFileIfSafe`/`deleteFileIfSafeSync` hardcoded to storage/images/ — confirmed via direct read of assetSafety.ts and both call sites. Changed both to take an explicit `outputKind` param (callers already have the row in hand); updated both callers.
- Git sync omitted entirely for themes — confirmed via direct read of GitService.ts (ensureDirectoriesExist, stageFilesForCommit, importFromJson all hardcoded to storage/images/, and the asset INSERT never wrote output_kind at all — meaning even a correctly-exported theme asset would silently flip back to 'image' on any re-import). This is a real break of the app's git-native premise. Added a new Task 4 covering ensureDirectoriesExist, stageFilesForCommit (per-asset subdir by output_kind), and importFromJson's INSERT/ON CONFLICT clause, with tests using the project's real-temp-git-repo harness (mirrored from push.test.ts and importFromJsonFields.test.ts).
- Old Git JSON lacking output_kind — changed schema field to `.default('image')` on both Job and Asset (not just Asset), tested against a JSON fixture that omits the field entirely.
- Asset detail page still shows `/api/images/*.css` + "Edit in Aseprite" for themes — confirmed via direct read; added a branch on `asset.output_kind` in Task 6, same fix pattern as JobCard/AssetCard.
- Godot export attempts to copy theme CSS from storage/images/ — confirmed via direct read of GodotExporter.ts; added a one-line `output_kind === 'image'` filter plus a test.
- CSS injection via unvalidated token strings — confirmed the schema was `.min(1)` only, genuinely exploitable (a value can close the custom-property declaration and open a `url(...)` rule). Replaced with strict per-field allowlist regexes (colors: hex/rgb/rgba/hsl/hsla/named; fonts: letters/digits/space/comma/quotes/hyphen; lengths: px/rem/em only). Added `sandbox=""` to all three preview iframes as defense-in-depth (the regex is the actual fix; sandbox costs nothing since the preview has no scripts).
- No fetch timeout — added `AbortSignal.timeout(60_000)` to the Anthropic call.
- fs writes not wrapped in try/catch+log — this is a direct, explicit project Hard Rule (AGENTS.md) I should have followed from the first draft. Wrapped both MockThemeGenerator's and AnthropicThemeGenerator's mkdir/writeFile in try/catch with console.error + rethrow.
- Missing tests for all of the above — added throughout (regex-rejection tests, styleId-drives-prompt test, GitService theme tests, GodotExporter test, assetSafety outputKind tests).

**Rejected, with reasons:**
- `assets.image_path` unique index scoped to `(output_kind, image_path)` — rejected. Image filenames and theme filenames are extension-differentiated by construction (.png/.jpg vs .css) and both use crypto.randomUUID()-suffixed names, so real collision risk is effectively zero; the existing single-column unique index doesn't need restructuring for a collision that can't occur given how filenames are generated. Added an explicit regression test (`does not touch storage/images/ when deleting a theme filename that happens to collide with an image filename there`) covering the one place this could matter (deleteFileIfSafe now takes outputKind explicitly, so it's structurally impossible for it to touch the wrong directory even in a contrived same-name scenario).
- Cleanup write/persist race — rejected as a themes-only fix. Confirmed via direct read that `cleanupOrphanedImages()` has the exact same theoretical race today, unfixed, accepted (cleanup is a manual, occasional admin action per the Storage page's own copy: "nothing runs automatically here"). Fixing it well (e.g. reserving a filename before the write) would need to apply to both pipelines — that's a pre-existing-pattern fix, out of scope for a plan whose job is adding themes. Documented this reasoning directly in Task 5 rather than silently doing nothing.
- Full CSP via meta tag on the preview document — rejected as the primary defense in favor of the regex fix above. A `sandbox=""` iframe with no `allow-same-origin` gets an opaque origin, so a CSP `'self'` directive would refer to nothing and silently break the very `<link>` stylesheet the preview needs to load — over-engineering that adds a real footgun for marginal benefit once the token values themselves can't carry injectable CSS.
- Rate limiting / auth on `/api/generate` — rejected as out of scope. This mirrors the exact same unauthenticated-local-first design this app already has for Pixellab generation (confirmed: no auth system anywhere in this codebase, per AGENTS.md's own documented design). Did keep the cheap, generic part of this finding — a `.max(2000)` prompt length cap — since it costs nothing and applies to both output kinds, not just themes.

Rewrote the plan (now 8 tasks, was 7) with all accepted fixes. Sending for round 2.

## Round 2 — blocked

`codex exec resume` failed: `"You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Oct 4th, 2026 1:27 AM."` This is the user's Codex/ChatGPT account quota, not a bug in this loop — round 2 cannot run until the quota resets. Per the codex-review skill's own rule ("If neither [thread.started nor the verdict file] appears, the run failed — stop and tell the user"), stopping here rather than retrying blind or treating round 1's single pass as a false "approved."

### Status

Round 1's findings were substantial and, on independent verification against the live codebase, mostly real (12 of 15 accepted and fixed; 3 rejected with logged reasoning above). The plan has had one full adversarial round plus my own independent verification of every claim against real files (not just trusted), but has NOT had a second Codex pass confirming the fixes actually address round 1's concerns. This is a genuine gap, not a converged review — surfaced to the user rather than silently treated as done.

### Resolution

User chose to proceed with the plan as revised after round 1, without waiting for a second Codex pass (quota resets 2026-10-04, too far out to block on). This is a **deliberate, informed stop short of full convergence** — not a false "approved." Round count: 1 (of a possible 5). Final plan: docs/superpowers/plans/2026-09-04-website-theme-generation.md (8 tasks).
