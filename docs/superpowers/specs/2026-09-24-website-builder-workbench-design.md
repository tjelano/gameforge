# Website Builder Workbench — Design

## Goal

Close the gap raised in [[project_gameforge_ux_backlog_2026_09_23]] item 3: GameForge's dashboard
doesn't distinguish UI-asset creation (Style Bibles, sprite/theme/component generation) from
website creation (Page Composer, Site Export), and there's no single place to build a full website
with everything needed in one place, including a live editor for the site's own content and
styling — not the dashboard's own theming (that's PR #28, a separate, already-shipped feature).

## Explicitly out of scope

- **Not replacing any existing page.** Style Bibles, Generate, Themes, Components, and the
  Style Hub's page-composition UI (`PageEditor`) all stay exactly as they are, for users who want
  fine-grained control or are just generating individual assets. This is a new, additional guided
  surface that calls the same underlying services.
- **Not new generation capability.** Sprite/theme/component generation still goes through the
  exact same services, jobs, and providers (Pixellab/Claude/Ollama/OpenRouter) as today. This
  feature is orchestration and live editing, not a new AI pipeline.
- **Not editing the real exported site.** The live preview renders from GameForge's own stored
  Page/Component/Style data (the same source Site Export already reads from) — it does not run or
  proxy into the actual exported Next.js project. Editing the hand-exported site's own files is
  reverse-sync's job (PR #22) and is unaffected by this feature.
- **Not a multi-step wizard.** Considered and rejected in favor of a single persistent workbench
  page (see "Approaches considered" below) — no step navigation, no progress bar.

## Architecture

A new page at `/dashboard/website`, under a new sidebar group ("Website", grouped separately from
the existing "Assets" group that covers Style Bibles/Generate/Themes/Components — this grouping
*is* the visual/structural distinction the backlog item's first ask wanted). Layout is a persistent
split view:

- **Left panel:** Style Bible picker, a list of pages being built for that Style Bible, and — for
  the currently selected page — the existing `PageEditor` component's add/remove/reorder/"Suggest
  layout" controls, embedded here instead of only living on the Style Hub page. An inline "Generate
  new component" action reuses the existing Components generation flow (same job/service, just
  triggered without leaving this page) so a user never has to navigate away mid-build.
- **Right panel:** a live preview of the currently selected page, rendered via `PreviewFrame` in a
  new `kind: 'page'` mode (extending its current `kind: 'component'`-only support).

## Approaches considered

1. **Single workbench page (chosen).** One page, no steps; the live preview updates continuously
   as pages/components are assembled. Best match for "everything needed in one place" as an
   ongoing editing surface, not just a first-time setup flow. Simplest state model — no
   step-transition logic.
2. **Multi-step wizard** (Style Bible → Theme → Pages → Components → Preview/Edit → Export).
   More hand-holding for a first build, but every later edit means navigating back through steps.
   Rejected: this project's own generation pages already establish "everything visible on one
   page" as the house pattern (Generate, Themes, Components are all single-page forms with an
   inline queue) — a step wizard would be inconsistent with that, and worse for iterative editing.
3. **Extend the existing Page Composer (Style Hub) page instead of a new page.** Rejected before
   design started — the sidebar-grouping ask specifically wants a distinct, visible "Website"
   destination, not a mode toggle buried inside the Style Hub.

## Data flow: composing a page for live, click-to-edit preview

Today, `/api/pages/[id]/render` (used for export/download) composes a page from its component
assets via `composePageHtml()`, but calls `stripElementIds()` first — the `data-gf-id` attributes
individual components carry (used by the existing single-component patch feature, PR #32) are
removed, since that route's only job today is producing a clean, final export document.

`data-gf-id` values are also only unique *within one component's own document* — merging several
components into one page's DOM without changes would let two different components' elements
collide on the same id.

**New "editable" render mode** (a query param on the same render route, or a small sibling
function alongside `composePageHtml` — implementation detail for the plan, not this design): skips
`stripElementIds()`, and wraps each component's HTML in a container carrying
`data-gf-component-asset-id="{assetId}"` before composing. The final page DOM looks like:

```html
<div data-gf-component-asset-id="asset-1"> ... component 1's HTML, data-gf-id scoped to it ... </div>
<div data-gf-component-asset-id="asset-2"> ... component 2's HTML, data-gf-id scoped to it ... </div>
```

**Click resolution** extends `lib/preview/inspectFrame.ts` — the one module in this codebase
allowed to read `iframe.contentDocument` directly (see the security note below). `FrameElementInfo`
gains one more field, `componentAssetId: string | null`, populated the same way `dataGfId` already
is: an ancestor walk (`closest('[data-gf-component-asset-id]')`) from the clicked element. No new
DOM-reading code path outside this already-audited module.

**Applying an edit reuses the existing patch endpoint unchanged.** Once a click resolves to
`{componentAssetId, dataGfId}`, the page-level UI POSTs to the *same*
`/api/assets/[id]/component/patch-element` route PR #32 already ships, just with `id` resolved
dynamically per click instead of being fixed to one asset the whole preview points at. No new
backend endpoint. The existing natural-language instruction flow, error codes
(`ELEMENT_CHANGED`/`CONFLICT`/`SANITIZE_REJECTED`/etc.), and `ElementPatchPanel` UI are reused as-is
— this is also how "unified content and styling in one editor" is satisfied: an instruction like
"change this heading to Welcome" or "make this button red" both go through the same mechanism
today, per component; page mode doesn't change that, it only changes which component a click
resolves to.

## Security

This reuses, and does not expand, the sandbox/CSP posture already designed and twice
adversarially-reviewed for single-component patching (see
`docs/superpowers/specs/2026-09-14-element-specific-patching-design.md`). The load-bearing
invariants from that design hold unchanged here:

- `PreviewFrame` still never sets `allow-scripts` — `allow-same-origin` (already relaxed for
  `kind: 'component'`) is what page mode also needs, and only that.
- All frame-DOM reads still go through `inspectFrame.ts`'s narrow, copy-only exports — adding
  `componentAssetId` to `FrameElementInfo` keeps the same shape discipline (a string extracted from
  an attribute, never a node, never markup).
- The render route's existing CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:;`)
  is unchanged; editable mode still composes through `sanitizeComponentHtml`/`sanitizeComponentCss`
  for AI-generated content exactly as today (the `edited_externally` trust bypass is also
  unchanged — per-component, not page-wide).

No new empirical verification is needed before implementation; the plan should still re-confirm
sanitization runs correctly on the composed (not just per-component) markup, since this is the
first time multiple components' *sanitized* output is combined in a mode that's actually clickable
rather than just rendered for export.

## Error handling

Reuses existing, already-shipped behavior rather than inventing new patterns:

- A page referencing a stale/deleted/invalid component asset already degrades gracefully in
  `composePageHtml`'s caller (skipped with a `console.error`, per the current render route) —
  editable mode inherits this unchanged.
- A patch conflict (the underlying component changed between load and patch) already has
  established error codes and a UI (`ElementPatchPanel`) — unchanged, just reached via a
  dynamically-resolved asset id instead of a fixed one.
- Empty states (no Style Bible yet; a Style Bible with no components yet) link out to the existing
  Style Bibles / Generate pages rather than duplicating those flows inline.

## Testing approach

- A real (non-mocked) test for the new editable-render composition: given 2+ component assets,
  confirms each is wrapped in its own `data-gf-component-asset-id` container, `data-gf-id`s survive
  (aren't stripped), and — the actual regression risk, since this extends code the existing
  download/export path also uses — confirms the *non*-editable mode is byte-for-byte unaffected.
- A unit test for `inspectFrame.ts`'s extended `componentAssetId` resolution against a real nested
  DOM fixture (multiple wrapped components, an icon-inside-button case mirroring the existing
  `dataGfId` test's own edge case).
- A component-level test for the workbench page's click → instruction → patch → live-update loop,
  following this project's established `PreviewFrame`/`ElementPatchPanel` test patterns.
- Manual browser verification of the full loop with a real Style Bible and real generated
  components, per this project's standing practice for UI work.

## Open questions for the implementation plan

- Exact `PageEditor` embedding: reused as a shared component as-is, or does the workbench need a
  trimmed variant (e.g. without the standalone "Download HTML" link, which makes more sense on the
  Style Hub's existing page list than mid-workbench)?
- Whether "New page" creation inside the workbench should also let you pick an existing page
  (edit) versus always starting fresh — the Style Hub's existing page list is the natural source of
  truth to pull from rather than duplicating page storage.
