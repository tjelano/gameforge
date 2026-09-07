# Page Composer — Design

**Status:** Approved by user, pending spec review.
**Item 5 of the GameForge workflow backlog.**

## Problem

GameForge generates individual assets (Style Bibles, themes, real HTML+CSS
components, pixel-art images) but has no concept of a page or site above
the Style Bible level. Nothing groups multiple promoted components into an
actual assemblable webpage. Item 6 (Site Export — turning a composed page
into a real deployable project) depends on this existing first.

## Scope, confirmed with user during brainstorming

- **Simple vertical stack.** A page is an ordered list of existing
  promoted components, stacked top to bottom. No grid/column layout
  control.
- **One Style Bible per page.** A page lives inside exactly one Style
  Bible, matching every other asset kind. One theme applies to the whole
  page.
- **Editable.** Add, remove, reorder components at any time — not
  write-once.
- **No stored document.** A page is purely an ordered list of component
  references (asset ids). The combined HTML document is computed on
  demand, the same way a component's own preview is already re-composed
  on every request rather than baked to a file.
- **No ownership restriction**, matching Presets — shared, any logged-in
  user can edit/delete any page.
- **UI lives on the Style Bible Hub page**, as a new "Pages" section
  alongside the existing Themes/Components/Images sections — not a
  separate top-level nav entry.
- **A basic "Download as one HTML file" button is in scope for this
  item.** Item 6 (Site Export) still owns the bigger job — a real
  deployable project scaffold (Next.js/Astro, multiple pages, etc.).

## The CSS-collision problem and its verified fix

Generated components use plain, unscoped CSS class names (confirmed by
reading `lib/services/ComponentGenerator.ts`'s prompt — it asks Claude
for HTML+CSS referencing theme variables, with no scoping/prefixing
convention). Concatenating two independently-generated components' CSS
onto one page risks one component's styles bleeding into another's (both
could define `.title` differently, for example).

**Fix, confirmed with user: auto-scope each component at compose time.**
For each component, in page order:

1. Parse its stored document with the existing `parseComponentHtml` (from
   `lib/services/componentDocument.ts`) to get `{html, css}`.
2. Rewrite every selector in its CSS with a unique per-item prefix (e.g.
   `.page-item-2 .btn-primary`), using `postcss` — already a dependency,
   already used by `componentSanitize.ts`. **This was verified with a
   real, executed test against the actual installed `postcss` (8.5.28),
   not assumed:**
   ```js
   root.walkRules(rule => {
     rule.selector = rule.selectors.map(s => `.page-item-${i} ${s}`).join(', ');
   });
   ```
   `rule.selectors` correctly splits ONLY on top-level commas (confirmed:
   `.btn, .btn-primary:hover` → two entries) and correctly does NOT split
   inside a nested selector list like `:is(.a, .b) > .c` (confirmed: stays
   one entry). A component's CSS containing a broad selector like `body`
   or `*` gets scoped to `.page-item-N body` / `.page-item-N *` — which
   safely matches nothing real inside the wrapper div (there's no actual
   `<body>` tag inside it) rather than leaking document-wide. This is a
   safe side effect, not a bug to guard against separately.
3. Wrap its HTML in `<div class="page-item-2">...</div>`, carrying the
   same scope class.

CSS custom property references (`var(--color-accent)`) inside
declaration VALUES are completely unaffected by selector-level scoping —
only the selector is rewritten, not the values — so theme variables
continue to resolve normally through the wrapper.

The page's theme CSS is injected once, globally, at the top of the
combined document — reusing the exact `loadThemeCssForStyle` logic that
already exists for component previews (find the style's most-recently-
promoted theme asset, read + `sanitizeComponentCss` its file). **This
currently lives as an unexported function inside
`app/api/components/[filename]/route.ts`** — per AGENTS.md's "extract
shared helpers for safety-critical logic on sight," this needs to move to
a shared location before a second caller (the page-render route) needs
it. It becomes a new exported method on `AssetService.ts` (the natural
home — it already owns `getActiveThemeAssetsForStyle`), and the component
route updates to call it from there instead of its own local copy.

**Stale/invalid component references degrade gracefully, not fatally.**
If a page's `component_asset_ids` contains an id that no longer resolves
to an active `'component'`-kind asset (soft-deleted, wrong kind,
nonexistent), the compose step skips that entry and logs — matching the
established convention elsewhere in this codebase (`loadThemeCssForStyle`
itself already returns `null` rather than throwing for any reason a theme
can't be used). A page never fails to render because one reference went
stale.

## Data model

New table, migration `013_add_pages.sql`:

```sql
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  style_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  component_asset_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of asset ids, ordered
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

One JSON-array column for the ordered component list, not a join table —
matches `styles.parameters`/`jobs.options`/`presets.components`'s
established convention, and keeps "reorder" a plain array replace instead
of needing an explicit `order` column and multi-row updates.

Zod schema (`lib/database/schema.ts`), mirroring `PresetSchema`:

```ts
export const PageSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  component_asset_ids: z.string(), // JSON-serialized string[]
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Page = z.infer<typeof PageSchema>;
```

## Service layer

`lib/services/PageService.ts`, mirroring `PresetService.ts`'s shape:

- `getActivePagesForStyle(styleId): Promise<Page[]>`
- `getById(id): Promise<Page | null>`
- `create(input: {styleId, name, createdBy}): Promise<Page>` — starts
  with `component_asset_ids: '[]'`.
- `update(id, patch: {name?, componentAssetIds?}): Promise<Page | null>`
  — one method covers rename, add, remove, and reorder; all three of the
  latter are just "replace the array with a new one," computed client-side
  before the call. No ownership check, matching Presets.
- `softDelete(id): Promise<void>`

`lib/services/pageDocument.ts` (client-safe, no Node imports — mirrors
`componentDocument.ts`'s own reason for existing: a future in-app editor
preview may need this without pulling in DB/fs imports):

- `composePageHtml(items: {html: string, css: string}[], themeCss?: string): string`
  — the scoping + wrapping + concatenation logic described above. Pure
  function: takes already-parsed component tokens in order, returns one
  combined document. Does not know about the database, style ids, or
  asset ids — those are resolved by the caller (the render route).

## API routes

- `GET/POST /api/styles/[id]/pages` — list a style's active pages / create
  a new one. Matches `/api/styles/[id]/assets`'s existing convention
  (unauthenticated GET, login-gated POST).
- `GET/PUT/DELETE /api/pages/[id]` — read / rename+reorder / soft-delete
  one page. Matches the preset CRUD routes' shape exactly (unauthenticated
  GET, login-gated PUT/DELETE, no ownership check).
- `GET /api/pages/[id]/render` — unauthenticated, matching every other
  serve/preview route in this app (`GET /api/components/[filename]`,
  `GET /api/themes/[filename]`). The composed HTML document: 404 if the
  page doesn't exist; otherwise resolves `component_asset_ids` to active
  component assets (skipping stale ones), reads + parses each, loads the
  page's own Style Bible's theme CSS (`page.style_id`, the same field
  used to scope the component picker) via the extracted `AssetService`
  method, calls `composePageHtml`, returns the result with the same
  `Content-Security-Policy` header the component-serve route already
  sends (defense-in-depth for GameForge's own iframe preview only — never
  baked into anything downloadable). With `?download=1`, adds
  `Content-Disposition: attachment; filename="<slugified-page-name>.html"`
  instead — same document, different response headers, no separate route
  needed.

## UI

### Style Bible Hub page (`app/dashboard/styles/[id]/page.tsx`)

New "Pages" section, positioned after the existing Images section,
mirroring the Themes/Components/Images sections' card-grid pattern:

- Each page card: name, a live `<iframe>` preview (`src` pointed at
  `/api/pages/[id]/render`, same sandboxing convention as every other
  preview iframe on this page), Edit and Delete buttons.
- "New Page" button opens the editor (see below) with an empty component
  list.
- "Edit" on an existing card reopens the same editor, pre-filled from
  that page's current name + `component_asset_ids`.

### Page editor (new shared component, `app/components/PageEditor.tsx`,
mirroring `PresetForm.tsx`'s standalone-exported-component pattern)

- Name field.
- A picker listing the Style Bible's active promoted components (reusing
  data the Hub page already has fetched via `GET /api/styles/[id]/assets`
  — no new fetch needed), each with an Add/Remove toggle.
- The current ordered list of added components, each with Up/Down buttons
  to reorder (no drag-and-drop library — matches this app's plain-button
  convention elsewhere, e.g. the Presets page's component list).
- Save button — calls `POST` (new) or `PUT` (edit) with `{name,
  componentAssetIds}`.
- A "Download HTML" link/button pointing at
  `/api/pages/[id]/render?download=1` (only shown once the page has been
  saved at least once, since it needs a real `id`).

## Testing approach

- `PageService` and `composePageHtml`: real temp-SQLite-DB tests for the
  service (matching every other DB-touching service this session), plain
  unit tests for `composePageHtml` (pure function, no DB/fs needed) —
  specifically covering: multiple components' CSS doesn't collide after
  scoping (assert two components' identically-named classes produce
  differently-scoped output), a component with a broad selector (`body`,
  `*`) is safely neutralized not leaking page-wide, theme CSS appears
  exactly once regardless of component count, and `var(--...)` references
  inside declaration values are byte-for-byte unchanged by scoping.
- Route-level tests: the established `NextRequest`/session-cookie pattern.
- The `render` route's graceful-degradation behavior (a stale/deleted
  component id in `component_asset_ids`) gets its own test proving the
  page still renders the remaining valid components rather than erroring.
- The `AssetService` extraction of `loadThemeCssForStyle`'s logic gets a
  test confirming the component-serve route's existing behavior is
  unchanged after the refactor (same inputs, same outputs) — a pure
  refactor, not a behavior change, and the test should prove that.

## Migration numbering

Next available migration is `013_add_pages.sql` — `012_add_presets.sql`
is the last one currently in the repo (confirmed by listing
`lib/database/migrations/` directly after pulling the merged Presets PR).
