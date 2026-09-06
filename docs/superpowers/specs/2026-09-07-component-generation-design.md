# Full Component-Level Generation — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge's theme-generation feature (Seed Theme Library, Export Formats, Contrast Checking,
Dedup-Steering/Multi-Candidate, Live Theme Tweaking — all shipped) operates on an 8-field
design-token model: colors, fonts, spacing unit, and border radius as CSS custom properties.
This is the sixth and final item in that backlog, and the only one that was never scoped beyond
a one-line mention when the backlog was first approved — every other item had a clear, narrow
shape from the start; this one didn't, and needed real from-scratch brainstorming to even
define.

Confirmed with the user: "component" means real, reusable website UI pieces — buttons, nav
bars, cards — as actual HTML+CSS, styled to match a Style Bible, going beyond design tokens into
real markup and layout. This is a genuinely different kind of output from anything else this
codebase generates: the pixel-art pipeline produces raster images with no code semantics at all,
and the theme pipeline produces a fixed 8-field token set with narrow per-field regex
validation. A component has neither — no fixed field set, and no realistic way to validate
arbitrary markup against a narrow allowlist the way `ThemeTokensSchema` does for token values.

## Decisions made during brainstorming

- **Format:** plain HTML + CSS, not React/JSX. Framework-agnostic — matches the existing theme
  export feature's own philosophy (Tailwind/W3C token exports are also framework-agnostic), and
  avoids locking the output to one stack when this codebase can't know what the user's own
  projects are built with.
- **Selection:** both a curated list of common component types (Button, Card, Nav Bar, Form, ...)
  AND a free-text prompt for anything else or for variation within a type — not one or the other.
- **Theme linkage:** generated CSS references the Style Bible's theme variables
  (`var(--color-accent)`, etc. — the same custom properties `tokensToCss()` already writes) rather
  than baking in concrete hex/font values. A later theme change re-styles every component that
  references it; the tradeoff is that a component only looks right when that theme's CSS is also
  loaded alongside it, which is an acceptable, expected cost for a component tied to a specific
  Style Bible.
- **Editing:** included in this first version, not deferred — a code-editor-style raw HTML/CSS
  edit, not a typed-field form (there's no fixed field set to build a form around).
- **Out of scope:** multi-candidate generation and dedup-steering (item 4) do not extend to
  components — item 4's OKLab distance math is inherently a color-similarity metric and doesn't
  generalize to arbitrary-markup similarity. Components get a straight
  generate/accept/discard/regenerate/edit flow, one candidate at a time.

## Real gaps found during self-audit — now part of the design

Two rounds of self-audit surfaced real issues, verified by reading and researching the actual
code rather than assumed:

### 1. Sanitization is the actual security boundary, not the sandboxed preview

Every prior generation feature's AI output was constrained by a narrow per-field regex allowlist
(theme colors/fonts/lengths). Free-form HTML/CSS has no equivalent clean grammar to allowlist
against — the only real defense is sanitizing dangerous constructs before anything is written to
disk, on both generation and every edit-save.

Researched `sanitize-html` (npm, ~10M weekly downloads, actively maintained through Aug 2026) as
a real, well-established choice for the HTML side — this is a deliberate, justified exception to
this codebase's "no utility libraries" rule (the same way `zod` is an accepted dependency), not a
convenience shortcut. Its own documentation is explicit about a real limitation, though: "Style
tags... cannot realistically be afforded XSS protection... unless a full CSS parser is added" —
it sanitizes the HTML tree, not arbitrary CSS text inside a `<style>` block.

This matters because a bare `sandbox=""` iframe still permits normal resource loading (images,
fonts, `@import`) — it isn't gated by the sandbox's script/interaction restrictions. A generated
component could make an outbound network request to an arbitrary URL just by being *previewed*,
before any human review happens, purely via `background: url(...)` or `@font-face`.

**Fix, matching a policy this codebase already has implicitly**: `ThemeTokensSchema`'s font
fields are plain family names, never `@font-face`/URLs; colors are never `url()`-based. Extending
that same "no external resource references, ever" policy to components is simpler and more
auditable than building a nuanced CSS-URL allowlist: reject any generated or edited CSS
containing the substring `url(` at all, on both generation and edit-save.

Additionally, `GET /api/components/[filename]` sets a `Content-Security-Policy: default-src
'none'` **response header** (not baked into the stored file) as defense-in-depth for GameForge's
own preview rendering — the stored file itself stays a clean, portable snippet, since the actual
deliverable is meant to be copied out into the user's own, unrelated website.

### 2. This codebase's "exactly two output kinds" assumption is baked in as binary logic in several places, not exhaustive dispatch

A comprehensive search across every `output_kind`/`outputKind` usage in the codebase, verified by
reading each file directly rather than assumed, found:

**Genuinely broken for a third kind — real changes required:**
- `worker.ts:76-80` — job processing dispatch is `job.output_kind === 'theme' ? ThemeGenerator :
  ImageGenerator` (with a further ternary for UI-sheet options). A component job would silently
  route to the image generator.
- `lib/services/shared/assetSafety.ts`'s `storageDirFor(outputKind: 'image' | 'theme'): string`
  — literally `outputKind === 'theme' ? 'themes' : 'images'`, an else-fallback, not a real switch.
  This is used by `deleteFileIfSafe`/`deleteFileIfSafeSync` (the discard/delete path) AND by
  `GitService.ts`'s `stageFilesForCommit()` (the git-sync staging path). A component's file would
  resolve to the wrong physical directory everywhere this function is used — most seriously,
  **a promoted component asset would silently never actually get staged/committed to git**, since
  the staging logic's existence-check would look for the file in `storage/images/` instead of
  `storage/components/`, fail silently (caught and swallowed as a `null` in a `.filter()`), and
  simply never add it. This is exactly the kind of bug that wouldn't surface until someone
  noticed components missing from their repo much later — caught here during brainstorming
  instead.
- `lib/services/AssetService.ts`'s `cleanupOrphanedIn(subdir: 'images' | 'themes')` — no third
  case; a discarded/orphaned component's file would never get garbage-collected by the existing
  cleanup pass, accumulating forever in `storage/components/`.
- `app/components/JobCard.tsx` and `app/components/AssetCard.tsx` — both have a binary
  if/else rendering path (`output_kind === 'theme'` → iframe preview; everything else →
  `<img src="/api/images/...">`). A promoted/queued component asset would fall into the image
  branch and try to render an `.html` file as a raster image.

**Already safe by construction — verified, no change needed:**
- `app/api/assets/[id]/export/route.ts` and `app/api/assets/[id]/contrast/route.ts` both
  explicitly check `output_kind !== 'theme'` and reject cleanly (a positive check, not an
  else-fallback) — a component asset hitting either just gets a clean 400.
- `lib/services/GodotExporter.ts` filters explicitly for `output_kind === 'image'` (a positive
  allowlist) — already correctly excludes any third kind.
- `app/api/assets/from-job/route.ts` (promotion), `app/api/jobs/retry/route.ts`, and
  `app/api/jobs/[id]/route.ts` (DELETE) are all fully generic pass-throughs of whatever
  `output_kind` the job already has — no changes needed themselves, though the DELETE/retry
  paths depend on `deleteFileIfSafe`/`storageDirFor` being fixed (above) to behave correctly for
  a component job.

This means item 6's real scope is not just "add new files for a new feature" — it also requires
hardening the shared dispatch points above so the codebase's two-kind assumption becomes a
genuine three-kind (and future-extensible) one.

## Out of scope

- **No multi-candidate generation or dedup-steering** for components (see decisions above).
- **No React/JSX output** — plain HTML+CSS only.
- **No editing of already-promoted component assets** — same review-step-only scope boundary
  established by item 5's theme editor.
- **No component-to-component composition** (e.g. "assemble a page from these 3 components") —
  a single component per generation, matching the confirmed scope ("real UI code" for individual
  pieces, not a page-builder).
- **No CSS sanitization beyond the `url(` rejection** — no attempt to build a general-purpose CSS
  parser/sanitizer. This is a deliberate, narrow policy choice (see gap #1 above), not a
  half-finished broader sanitizer.

## Data model

`OutputKindSchema` (`lib/database/schema.ts`) extends from `z.enum(['image', 'theme'])` to
`z.enum(['image', 'theme', 'component'])`. `GenerateSchema`'s `outputKind` field in
`app/api/generate/route.ts` gets the same extension. No other schema changes — `jobs`/`assets`
tables are already generic enough (`asset_type` stays a free display label, `result_path`/
`image_path` are already just generic filename strings).

Storage: a new `storage/components/` directory, holding one self-contained `.html` file per
job/asset (an embedded `<style>` block plus body markup, combined into one valid document) —
matching the existing one-physical-file-per-job convention already used for images and themes.

## Component design

**Sanitization** (`lib/services/componentSanitize.ts`, new file):
- `sanitizeComponentHtml(html: string): string` — via `sanitize-html`, allowlisting a set of
  common structural/content tags (divs, headings, paragraphs, lists, links, buttons, images,
  nav/header/footer/section, forms and their standard input types) and their standard attributes,
  with `sanitize-html`'s own script/event-handler stripping doing the heavy lifting.
- `sanitizeComponentCss(css: string): string` — throws if the CSS contains the substring `url(`
  (case-insensitive) anywhere; otherwise returns it unchanged. No other CSS transformation.
- Both are called at generation time (before the file is first written) and at every edit-save
  (before the file is overwritten) — the same two-call-site pattern the theme editor's
  `ThemeTokensSchema.parse()` already follows.

**Generation** (`lib/services/ComponentGenerator.ts`, new file, mirroring
`lib/services/ThemeGenerator.ts`'s existing shape):
- `ComponentTokens` interface: `{ html: string; css: string }` (no schema validation of
  structure — sanitization is the defense here, not a regex allowlist, since there's no fixed
  grammar to validate arbitrary markup against).
- `combineComponentHtml(tokens: ComponentTokens): string` — produces one complete, valid HTML
  document: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>${html}</body></html>`.
- `parseComponentHtml(document: string): ComponentTokens` — the reverse: extracts the `<style>`
  block's contents as `css` and the `<body>` contents as `html`, for the editor's initial load
  and the "capture original on first edit" step (mirroring `parseThemeCss`'s role for themes).
- `ComponentGenerator` interface with `generate(prompt: string, styleId: string, componentType?:
  string): Promise<GeneratedComponent>`, mirroring `ThemeGenerator`'s interface shape.
  `ClaudeApiComponentGenerator` (real implementation, forced tool-use emitting separate `html`
  and `css` strings — kept separate at the API boundary so sanitization can apply distinct rules
  per field, then combined after) and `MockComponentGenerator` (fixed sample output, for tests
  and no-API-key dev, mirroring `MockThemeGenerator`).
- `getComponentGenerator()` lazy singleton, mirroring `getThemeGenerator()`'s existing
  lazy-init-to-avoid-env-var-hoisting pattern.

**Hardening the three shared dispatch points** (see gap #2 above — all three need to become
real 3-way dispatch, not binary):
- `worker.ts`: add a `job.output_kind === 'component'` branch calling
  `getComponentGenerator().generate(...)`, alongside the existing theme/image branches.
- `lib/services/shared/assetSafety.ts`'s `storageDirFor`: widen the type to `'image' | 'theme' |
  'component'` and make it an exhaustive mapping (e.g. a lookup object or a real switch with a
  default that throws on an unrecognized value, rather than an else-fallback that silently
  absorbs anything unrecognized into `'images'`).
- `lib/services/AssetService.ts`'s `cleanupOrphanedIn`: widen to `'images' | 'themes' |
  'components'`; add `cleanupOrphanedComponents()` mirroring the two existing wrappers.
  `lib/services/GitService.ts`'s two call sites (both places that already call
  `cleanupOrphanedImages()` + `cleanupOrphanedThemes()` as a pair) each get a third call to
  `cleanupOrphanedComponents()` added alongside.

**Review UI:**
- `app/components/JobCard.tsx` and `app/components/AssetCard.tsx` each get a real third
  rendering branch: `output_kind === 'component' && result_path/image_path` → an
  `<iframe src={`/api/components/${result_path}`} sandbox="" />` (pointing `src` directly at the
  served file, not `srcDoc` — since the stored file is already a complete, valid document, no
  wrapper-building step is needed the way theme's `buildThemePreviewHtml` needs one).
- `JobCard.tsx`'s Edit link condition extends to also show for `output_kind === 'component' &&
  status === 'complete'`, pointing at a new, separate edit route (not the existing theme editor —
  genuinely different editing UI: two textareas instead of a typed-field form).
- New generation page, `app/dashboard/components/page.tsx` (parallel to
  `app/dashboard/themes/page.tsx`): a component-type dropdown (Button, Card, Nav Bar, Form,
  Other) alongside a free-text prompt field and the existing `StyleBiblePicker`.

**API routes:**
- `GET /api/components/[filename]` — serves the stored file as `text/html`, with the
  `Content-Security-Policy: default-src 'none'` response header described above. Same
  path-traversal guard convention as `/api/themes/[filename]`.
- `PATCH /api/jobs/[id]/component` and `POST /api/jobs/[id]/component/reset` — mirror item 5's
  `PATCH /api/jobs/[id]/theme` and `POST /api/jobs/[id]/theme/reset` exactly in shape, but for
  `{html, css}` instead of 8 typed fields, with `jobs.options.originalComponent` as the
  reset-capture target instead of `originalTokens`. Deliberately applying every fix item 5's own
  review chain needed a cycle to find, from the start rather than rediscovering them:
  - Status guard (`job.status !== 'complete'` → 409) on **both** routes, not just PATCH.
  - `output_kind !== 'component'` guard on **both** routes.
  - `updated_at` bumped on **every** successful edit, not just the first (so an actively-edited
    job doesn't silently age out of the 5-minute active-jobs window).
  - Sanitization runs on **every** edit, matching generation-time sanitization exactly.
- New page, `app/dashboard/jobs/[id]/edit-component/page.tsx` (a separate route from the theme
  editor — a genuinely different editing UI, not a conditional branch inside the same page): two
  `<textarea>`s (HTML, CSS), a live sandboxed preview using the same cache-busted `?v=` query
  trick item 5's fix round established, debounced autosave, a Reset button that clears any
  pending debounce timer before resetting, and load-failure errors rendered before the loading
  spinner (not after) — again, applying item 5's own hard-won fixes from the start.

## Error handling

Mirrors item 5's final, hardened shape exactly: 404 for a missing job, 409 for wrong status
(both PATCH and reset), 400 for wrong `output_kind` (both routes) or sanitization-rejected
content (e.g. CSS containing `url(` → 400 with a clear message that external resource references
aren't supported), 500 for filesystem failures (logged, per `AGENTS.md`'s "log on every fs
error" rule). Generation-time sanitization failures degrade the same way generation-time
`ThemeTokensSchema` validation failures do for themes — the job is marked `failed`, not silently
retried or half-written.

## Testing

- `componentSanitize.ts` gets dedicated unit tests: a `<script>` tag is stripped, an `onclick=`
  attribute is stripped, a `javascript:` href is stripped, CSS containing `url(` (in any of a few
  realistic forms — `background: url(...)`, `@import url(...)`, mixed case `URL(...)`) is
  rejected, and a legitimate, realistic sample (a button or card's worth of HTML+CSS) passes
  through unchanged.
- `combineComponentHtml`/`parseComponentHtml` get a round-trip test, mirroring
  `tokensToCss`/`parseThemeCss`'s existing round-trip test pattern.
- The `PATCH`/reset routes get the same test shape as item 5's theme routes: valid edit persists,
  invalid (sanitizer-rejected) content is rejected with no file write, `originalComponent` is
  captured once and never overwritten, wrong status/output_kind rejected on both routes,
  `updated_at` advances on a second edit.
- `storageDirFor`, `cleanupOrphanedIn`, and `worker.ts`'s dispatch each get a test confirming the
  new `'component'`/`'components'` case resolves correctly — these are exactly the three places
  gap #2 found silently mishandling a third kind, so each needs a test proving the fix, not just
  the fix itself.
- Plan-writing will need to confirm `sanitize-html`'s real, current API surface (import shape,
  default option keys) directly rather than guessing, matching this session's "confirm real
  signatures before writing tasks" discipline already applied to `usePolling`, `ThemeTokensSchema`,
  and others.

## Security note

This is the first feature in this backlog where the AI's raw output is the actual shipped
deliverable, not an internal representation validated before being consumed elsewhere — the
generated HTML+CSS is meant to be copied directly into the user's own, real website. That makes
sanitization the core safety guarantee for the *deliverable itself*, not just for GameForge's own
preview rendering (which gets the CSP header as a separate, additional layer). Both defenses are
necessary and neither alone is sufficient: sanitization protects what ships; the CSP protects
GameForge's own review UI in case the sanitizer ever has a bug or bypass.
