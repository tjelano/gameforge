# Site Export — Design Spec

**Status:** Approved by user, ready for implementation planning.

## Background

GameForge generates Style Bibles (theme + components), and Page Composer
(shipped 2026-09-08, PR #16) lets a user assemble a Style Bible's promoted
components into named, ordered Pages, previewed live via
`GET /api/pages/[id]/render`. Nothing currently turns a Style Bible's Pages
into a real, standalone project a user can develop further outside
GameForge — this is that feature, "Site Export," the last item of the
2026-09-07 workflow backlog.

This spec's scope changed materially during brainstorming from the
backlog's original one-line framing ("zip/scaffold a real deployable
static HTML or Next.js/Astro project"). See "Rejected approaches" below
for why a plain static-HTML output and a new LLM-authored-JSX generation
pipeline were both ruled out.

## Goal

Given a Style Bible, write a real, runnable Next.js + Tailwind project to
a local folder, containing:
- One real page route per Page (App Router), with a shared auto-generated
  navigation bar linking all of them.
- One real `.tsx` component file per distinct component **asset** used
  across those Pages (deduplicated — a component reused across 3 Pages
  produces one file, imported 3 times), each styled via its own CSS
  Module.
- The Style Bible's theme mapped into Tailwind v4's CSS-first `@theme`
  block (an existing converter, `tokensToTailwindTheme()`, already
  produces this).

The user opens the folder, runs `npm install && npm run dev`, and has a
working site. They keep editing everything (themes, components, page
composition) inside GameForge as they already do; export re-runs to
produce a fresh project reflecting current state.

## Non-goals (explicitly out of scope)

- **LLM-authored JSX/React components.** Considered and rejected — see
  "Rejected approaches."
- **New interactivity/state.** Components stay exactly as
  presentational as they are today; nothing in this feature adds new
  behavior to component generation.
- **In-place re-export / merge with hand edits.** Exporting to an
  existing `subdir` is a hard error (see "Re-export safety").
- **Zip download.** Delivery is a folder written to disk, matching the
  existing Godot-export convention, not a browser download.
- **Astro.** The user's actual stated need ("open the folder, npm run
  dev, working site") is satisfied by Next.js alone; Astro was named in
  the original backlog line but never came up as a real requirement
  during brainstorming, and supporting two frameworks is pure YAGNI here.

## Rejected approaches

### Plain static HTML zip/folder (the backlog's original framing)

Early in brainstorming this looked like the default: reuse
`composePageHtml` per Page, write each as a standalone `.html` file. The
user's actual requirement — "open the folder and have a working site
when they start the dev server" — ruled this out directly: there's no
"dev server" to start for a folder of static HTML files without adding
one (a hand-rolled Node static server was considered, but became moot
once the user clarified they wanted `next dev`, i.e. a real framework
project, not a hand-rolled substitute).

### LLM-authored JSX/React components (originally "Option B")

The user's stated reason for wanting React involved ("most components
you get from the internet are mostly React") initially pointed toward
having the LLM generate real `.tsx` source directly, the same way it
generates HTML+CSS today. Researched this directly (see sources in the
brainstorming transcript: [Modal — running untrusted AI code
safely](https://modal.com/resources/run-untrusted-code-safely),
[SandboxEval](https://arxiv.org/pdf/2504.00018),
[Sandlock](https://arxiv.org/pdf/2605.26298)) and found the standard
industry answer — sandbox the execution — doesn't solve GameForge's
actual problem: the generated code is meant to **leave** GameForge and
run in the user's own real website, so sandboxing GameForge's own
preview does nothing to make the exported code itself safe. This is the
exact reasoning `componentSanitize.ts`'s own comment already applies to
HTML/CSS ("sanitization, not the sandboxed preview, is this feature's
actual safety guarantee"). Unlike HTML/CSS, JS/JSX is Turing-complete —
there is no equivalent of `ALLOWED_CSS_FUNCTIONS`'s finite allowlist that
closes off all danger from arbitrary code composition. Building this
safely would need a whole new generation-time safety model (e.g. an
LLM-emitted declarative JSON schema, Zod-validated, rendered by a
trusted, hand-written renderer — never LLM-authored executable syntax).
That is a real, substantial, separate feature, not something to fold
into export. **Parked, not designed here** — revisit only if a future
need for genuinely new LLM-authored interactivity emerges; nothing in
this feature's actual requirements calls for it.

### Rewriting component CSS as literal Tailwind utility classes

Considered so the "Tailwind" branding would be literal (utility classes
in JSX, not just a theme-config format). Rejected: there is no existing,
proven CSS-declaration-to-Tailwind-utility-class translator in this
codebase or its dependencies, and building one generically (handling
`calc()`, gradients, `clamp()`, arbitrary values, etc. — the same
function surface `ALLOWED_CSS_FUNCTIONS` already allows) is a large,
error-prone, lossy undertaking for a purely cosmetic win. Each
component's existing CSS is kept as real CSS, moved unchanged into a CSS
Module. "Tailwind" in this feature means the project's tooling and theme
config format (Tailwind v4's `@theme` block, which is exactly the CSS
custom-property mechanism `var(--color-accent)` etc. already depend on)
— not a rewrite of every style declaration.

## Architecture

```
storage/exports/{subdir}/
├── package.json          # next, react, react-dom, typescript deps; "dev": "next dev"
├── tsconfig.json
├── app/
│   ├── layout.tsx         # <html>/<body> shell, imports globals.css, renders <nav>
│   ├── globals.css        # @import "tailwindcss"; + @theme {...} (tokensToTailwindTheme output)
│   ├── page.tsx            # home = oldest-created Page (by created_at)
│   └── {page-slug}/page.tsx  # one per remaining Page
└── components/
    └── {AssetType}-{shortId}.tsx   # + adjacent .module.css, one pair per distinct component asset
```

Delivery: written directly to `storage/exports/{subdir}/` on disk — same
convention as the existing `GodotExporter` — not a zip. GameForge writes
source files only; it never runs `npm install` or any build/network
operation itself. The user runs `npm install && npm run dev` themselves.

Verified against the actual installed Next.js 16 docs
(`node_modules/next/dist/docs/01-app/01-getting-started/01-installation.md`):
`app/layout.tsx` is required and must contain `<html>`/`<body>`;
`app/page.tsx` is the home route; the standard `package.json` script is
`"dev": "next dev"`. No `next.config` file is required for a project this
simple. Dependency versions are pinned to match GameForge's own installed
versions (`react`/`react-dom` `^19.1.0`, `typescript` `^5.7.2`) rather
than `@latest`, so `npm install` in the exported project can't silently
pull in a future breaking major version.

Tailwind v4's CSS-first `@theme` directive (verified real via
[a description of CSS-first
configuration](https://medium.com/@madhushankhades1/css-first-configuration-in-tailwind-css-v4-a-game-changer-for-developers-1c752dd7fbd8)
and [a walkthrough of the `@theme`
directive](https://danholloran.me/posts/tailwind-css-v4-theme-directive-config))
needs no `tailwind.config.js` — a single `@import "tailwindcss";` plus an
`@theme { ... }` block in `globals.css` is sufficient, and
`tokensToTailwindTheme()` (already shipped, `lib/services/themeExport/
tailwindExporter.ts`) already produces exactly that block from a
`ThemeTokens` object unchanged.

## Data flow

1. `POST /api/styles/[id]/site-export` (mutating — requires
   `getCurrentUser`, 401 if null, matching every other mutating route in
   this codebase) with `{ subdir: string }` in the body.
2. `subdir` validated via `z.string().regex(/^[a-z0-9-]+$/)` — unlike
   `GodotExporter`'s existing `subdir` param (which only requires
   `.min(1)`, a real, pre-existing, out-of-scope path-traversal gap
   noted during this feature's research but not fixed here), this
   closes traversal at the schema level from the start.
3. `lib/services/SiteExporter.ts` (new — mirrors `GodotExporter.ts`'s
   class + exported-singleton shape: `class SiteExporterImpl`, exported
   as `siteExporter`), method `exportSite(styleId, subdir)`:
   - Loads the style's active (non-deleted) Pages via
     `pageService.getActivePagesForStyle(styleId)`, ordered by
     `created_at` (existing query order — oldest first). Zero Pages is a
     hard error (`NOTHING_TO_EXPORT`).
   - Checks `storage/exports/{subdir}` does not already exist — if it
     does, hard error (`ALREADY_EXISTS`), never overwrites (see
     "Re-export safety").
   - Resolves every Page's `component_asset_ids` to active `component`
     assets via `assetService.getById`, exactly mirroring the render
     route's existing stale-reference handling: skip (log) any
     asset that's missing, soft-deleted, or not `output_kind ===
     'component'`, rather than failing the whole export.
   - Deduplicates resolved component assets by id across ALL Pages (a
     `Map<assetId, Asset>` built once) — this is what makes the exported
     project's components real, reusable, non-duplicated files, a
     genuine improvement over the single-page render route's per-page
     recomposition.
   - For each distinct component asset: reads its file, re-sanitizes
     (`sanitizeComponentHtml`/`sanitizeComponentCss`, same defense in
     depth as every other read path off `storage/components/`), converts
     to JSX via `htmlToJsx()` (new, pure function — see "HTML→JSX
     conversion"), writes `components/{AssetType}-{shortId}.tsx` +
     `.module.css`.
   - Loads the style's theme CSS via the existing
     `assetService.loadThemeCssForStyle(styleId)`, converts to
     `ThemeTokens` via the existing `parseThemeCss()`, converts to a
     Tailwind `@theme` block via the existing `tokensToTailwindTheme()`.
   - Writes `app/layout.tsx` (nav bar links to every Page, ordered),
     `app/globals.css`, `app/page.tsx` (home), `app/{slug}/page.tsx` per
     remaining Page, `package.json`, `tsconfig.json`.
   - Returns `{ pagesExported, componentsExported, targetDir }`.

## HTML→JSX conversion

New pure function `htmlToJsx(html: string): string` in
`lib/services/siteExportDocument.ts` (no DB/fs imports — same
independently-testable-pure-function convention as `pageDocument.ts` and
`componentDocument.ts`).

Parses with `htmlparser2`'s `parseDocument` (promoted from an existing
transitive dependency of `sanitize-html`, version `^12.0.0`, to a direct
dependency — verified by actually running it against real markup during
this spec's research, not assumed): produces a walkable tree of `tag`/
`text` nodes with `.name`, `.attribs`, `.children`. Walks the tree
emitting JSX text:

- Tag names pass through unchanged (the sanitizer's `ALLOWED_TAGS` are
  all valid lowercase HTML tag names, which are also valid JSX
  intrinsic element names).
- Attribute name mapping: `class` → `className`, `for` → `htmlFor`,
  everything else unchanged (the sanitizer's `ALLOWED_ATTRIBUTES` has no
  other JSX-reserved-word collisions).
- Boolean attributes: `htmlparser2` represents a bare attribute like
  `disabled` as an empty-string value (verified: `<button
  disabled>` → `attribs.disabled === ''`) — emit these as the bare JSX
  shorthand (`disabled`), not `disabled=""`.
- Void elements (`br`, `hr`, `input`) emit self-closed (`<br />`), never
  `<br></br>`.
- Text node content: `htmlparser2` decodes entities automatically
  (verified: `&amp;` → literal `&` in `.data`) — do not re-encode `&`.
  Literal `{`/`}` characters DO need escaping (verified: a text node
  containing `{now}` comes through as literal `{now}`, which would be
  misparsed as a JSX expression if emitted verbatim) — wrap any text
  segment containing `{` or `}` as `{"..."}"` (a JS string literal inside
  a JSX expression container), rather than emitting it as raw JSX text.
- CSS is NOT touched by this function — it is written unchanged (already
  sanitized) into the component's own `.module.css` file, imported at
  the top of the generated `.tsx` file as `import styles from
  './{Name}.module.css'`, with every class reference in the emitted JSX
  rewritten from `className="btn-primary"` to `className={styles['btn-primary']}`.

## Component naming

Components have no display-name field (`Asset` has `asset_type` and
`prompt`, nothing else identifying). File and export names are derived
as `{PascalCase(asset_type)}{first 6 hex chars of the asset's id}`, e.g.
`Button-a1b2c3.tsx` exporting `export function ButtonA1b2c3()`. Not
pretty, but stable, collision-free (asset ids are UUIDs), and requires no
new schema field.

## Page routing & navigation

- Pages ordered by `created_at` ascending (existing `PageService` query
  order, unchanged) — oldest = home (`app/page.tsx`), every other Page
  gets `app/{slug}/page.tsx` where `slug = slugify(page.name) ||
  'page'` (same empty-name fallback convention already used by the
  render route's own `slugify(page.name) || 'page'`). Slug collisions
  (two Pages slugifying to the same string, including two empty names
  both falling back to `'page'`) are resolved by appending the page's
  own short id suffix, matching the component-naming convention above.
- Navigation is NOT stored anywhere — `app/layout.tsx` is generated fresh
  at export time with a `<nav>` containing one link per Page, in the same
  order, computed from the Style Bible's Pages at the moment of export.
  Re-exporting after adding/removing/renaming Pages produces a nav
  reflecting the new state (into a new `subdir`, per "Re-export safety").

## Re-export safety

Exporting to a `subdir` that already exists is a hard error
(`ALREADY_EXISTS`), never an overwrite. Export is a pure function of a
Style Bible's current Pages/Components/Theme, similar to how the render
route recomputes on every request — but unlike the render route, its
OUTPUT is a real project the user may have already started hand-editing.
Silently overwriting that would be a destructive, hard-to-reverse
mistake. The UI surfaces this plainly (a clear "that folder already
exists — choose a different name" error) rather than offering a
"force overwrite" option; if this friction turns out to matter in
practice, it can be revisited later, but the safe default costs nothing
today.

## UI

A new "Export site" section on `app/dashboard/styles/[id]/page.tsx` (the
Style Bible Hub page), below the existing "Pages" section — NOT the
existing generic `/dashboard/export` page, which is style-agnostic
(exports every active image across all styles for Godot) and has no
concept of a single style's Pages. Mirrors that page's own form pattern
(a subdir text input + submit button, disabled while running, a result
message on success/error) but scoped to this style's id, calling the new
`POST /api/styles/[id]/site-export` route instead. Success shows the
page/component counts and the resulting path (matching the Godot export
page's existing result-message shape); the `ALREADY_EXISTS` error
surfaces as a plain "that folder name is already used — pick another"
message.

## Testing approach

- `htmlToJsx()`: pure unit tests, no DB/fs — mirrors `pageDocument.ts`'s
  test shape. Cover: tag/attribute mapping, boolean attributes, void
  elements, curly-brace escaping, entity non-re-encoding, CSS class
  reference rewriting.
- `siteExporter.exportSite()`: real temporary-directory + temporary-
  SQLite-DB tests, mirroring `test/godotExporterSkipsThemes.test.ts`'s
  and `test/pageService.test.ts`'s established pattern
  (`setProjectRootForTests` + `DatabaseConnection.resetForTests()`, real
  migrations copied into the temp root). Cover: multi-page export with a
  shared component deduplicated to one file; a stale component reference
  skipped without failing the export; zero-Pages error; `ALREADY_EXISTS`
  refusal; `subdir` traversal rejection.
- Route test (`test/siteExportRoute.test.ts`): auth gating (401 when
  logged out), the same `NextRequest`/`seedSession()` pattern as every
  other mutating route this session.
- Final task: `npx tsc --noEmit` + full `npx vitest run`, plus a manual
  walkthrough — export a real Style Bible with 2+ Pages, `npm install`
  and `npm run dev` the exported project for real, confirm it actually
  renders in a browser, confirm theme colors match, confirm nav links
  work.
