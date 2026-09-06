# Accessibility Contrast Checking — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge's theme generation (Seed Theme Library and Export Formats, both shipped) produces
themes with no visibility into whether their own text is actually readable. This is the third
of a 6-item backlog for the theme feature (see `project_theme_generation_backlog` memory);
items 1 and 2 are shipped, the other three (dedup-steering + multi-candidate generation, live
tweaking, full component generation) are separate, later initiatives and out of scope here.

The idea: check every theme's background/foreground color pair against the real WCAG contrast
formula and surface a pass/fail indicator — purely informational, never blocking anything —
so a user can see at a glance whether a theme's text is actually legible before using it.

## Source research (done during brainstorming, not re-derived here)

The real WCAG 2.1 contrast formula (Success Criterion 1.4.3, "Contrast (Minimum)") was fetched
directly from the W3C's own Understanding-WCAG documentation, not assumed from memory:

- **Relative luminance**: each of R, G, B (normalized to 0–1 from the 0–255 hex value) is
  gamma-linearized: `c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`. Relative luminance is then
  `L = 0.2126·R + 0.7152·G + 0.0722·B`.
- **Contrast ratio**: `(L1 + 0.05) / (L2 + 0.05)`, where L1 is the lighter color's luminance
  and L2 is the darker color's.
- **AA threshold for normal text**: exactly 4.5:1. The spec explicitly warns computed values
  must not be rounded before comparison — "4.499:1 would not meet the 4.5:1 threshold."

These constants were independently sanity-checked, not just trusted from the fetch: the
coefficients (0.2126/0.7152/0.0722) and gamma constants (0.04045/12.92/1.055/2.4) are the same
bedrock sRGB-linearization values used identically in the CSS Color 4 spec and virtually every
contrast-checking library, not a niche or recently-changed fact. Hand-deriving the formula's
own black-vs-white case gives exactly 21:1 (white linearizes to L=1, black to L=0, coefficients
sum to 1 so this holds for any gray value) — the single most universally-cited WCAG fact,
confirming the fetched formula is genuinely correct, not garbled.

## Decisions made during brainstorming

- **Color pair checked: background vs. foreground only.** `ThemeTokens` has no font-size
  concept, and background/foreground is the pair WCAG 1.4.3 actually governs (body text
  legibility). `colorAccent`/`colorBorder` are excluded — accent-as-text and border contrast
  are genuinely different questions (the latter is a different WCAG criterion, 1.4.11, with its
  own 3:1 threshold) and out of scope for this item.
- **Threshold: AA only, pass/fail.** Not AA/AAA three-tier. `meetsWcagAA(ratio)` returns a
  boolean (`ratio >= 4.5`, unrounded).
- **Enforcement: purely informational.** Never blocks generation, promotion, or seeding — this
  is a badge/number, not a gate. No workflow changes anywhere else in the app.
- **UI surface: both.** A small pass/fail badge on every theme card in the Assets list view
  (`AssetCard`, rendered only on `app/dashboard/assets/page.tsx` — confirmed there is no
  separate promoted-themes grid elsewhere; the Themes page shows in-progress/pending generation
  jobs via a different component, `JobCard`, which is out of scope here) for at-a-glance
  scanning, plus the exact numeric ratio on the asset detail page.
- **Retroactive by construction, not by backfill.** Contrast is computed on demand from a
  theme's own `.css` file (via the existing `parseThemeCss()`, built for Export Formats) —
  never stored. This means it automatically applies to every existing theme, including all 58
  already-seeded ones, with zero migration or backfill work needed.

## Architecture decision: a new sibling route, not an enriched list response

`AssetCard` (used in card grids) only receives the theme's `.css` file URL, loaded inside a
sandboxed iframe for the preview — it never has the actual color values, so a badge needs a
small server round-trip regardless of shape. Two options were weighed:

- **Enrich `GET /api/assets`'s response** with a computed `contrast` field per theme item.
  Rejected on inspection, not assumption: `Asset` is a strict `z.infer<typeof AssetSchema>`
  type, returned unmodified by `assetService.getPage()` and consumed by exactly one page,
  `app/dashboard/assets/page.tsx`. Attaching a computed field here means widening a
  schema-derived type on both server and client, and making a currently one-line pagination
  route also compute per-item derived data — real complexity added to shipped, working code
  for a feature that's purely cosmetic.
- **A new sibling route, `GET /api/assets/[id]/contrast`** (mirrors the existing `[id]/export`
  route's exact pattern). **Chosen.** Touches nothing existing — zero chance of regressing the
  three files that already depend on `Asset`'s exact shape. Both `AssetCard` (badge) and the
  asset detail page (exact ratio) call this same new endpoint independently on mount. This adds
  one small local fetch per rendered theme card, bounded by the existing pagination limit (50
  per page) — not unbounded, and not qualitatively different from the per-card iframe fetch
  every theme card already makes for its preview.
- **A batch endpoint** (one request for N theme ids) was considered and deliberately rejected:
  this is a local, single-user tool with no rate-limiting concerns, not a production service
  under load — batching N cheap local computations into one request is complexity this specific
  app doesn't need yet, consistent with AGENTS.md's "simple over generic."

## Out of scope for this feature

- **No blocking/warning on generation, promotion, or seeding** — purely informational, per the
  decision above.
- **No accent or border contrast checks** — background/foreground only.
- **No AAA tier or large-text thresholds** — AA normal-text pass/fail only.
- **No stored/persisted contrast values** — always computed on demand, no new columns.
- **No batch/bulk contrast endpoint** — one small request per theme, per the architecture
  decision above.

## Data model

No new tables or columns. Nothing is persisted — contrast checking is a pure, on-demand
computation from an existing theme asset's already-stored `.css` file, exactly like Export
Formats.

## Component design

**`getContrastRatio(hex1: string, hex2: string): number`** and **`meetsWcagAA(ratio: number):
boolean`** — two small, pure functions implementing the verified formula above. Live in a new
file, `lib/services/contrastChecker.ts`. Take hex color strings directly (the same `ThemeTokens`
field values `parseThemeCss()` already produces) — no new color-parsing complexity, since the
project's existing hex-to-RGB decomposition pattern (already built for the W3C token exporter)
can be reused or duplicated at this small scale.

**`GET /api/assets/[id]/contrast`** — mirrors the existing `[id]/export` route's structure
exactly:
1. Look up the asset by id. 404 if not found.
2. If `output_kind !== 'theme'` or no `image_path`, 400.
3. Read the theme's `.css` file from `storage/themes/`. 500 if unreadable, logged via
   `console.error`.
4. Parse it via the existing `parseThemeCss()`. 500 if unparseable, logged.
5. Compute `getContrastRatio(tokens.colorBackground, tokens.colorForeground)` and
   `meetsWcagAA(ratio)`.
6. Return `{ success: true, data: { ratio: number, meetsAA: boolean } }` — a normal JSON
   envelope (unlike the export route, which returns a raw downloadable file; this route's
   output is small structured data, so it follows the more common envelope convention already
   used by `GET /api/assets/[id]`).

**UI**: `AssetCard.tsx` becomes a small client component (it currently has no `'use client'`
directive and no hooks) that, for theme assets only, fetches this endpoint on mount and renders
a small badge (e.g. "AA ✓" / "AA ✗") once the result arrives — absent until then, no loading
spinner needed for something this fast and non-blocking. The asset detail page
(`app/dashboard/assets/[id]/page.tsx`, already a client component) does the same fetch and
shows the exact ratio (e.g. "Contrast: 8.2:1 — passes WCAG AA") alongside the existing preview
and export links.

## Error handling

Same shape as the Export Formats route: 404 for a missing asset, 400 for a non-theme asset,
500 (logged) for a missing/unreadable/unparseable theme file. The UI's fetch failure path is
silent-by-omission — if the contrast fetch fails, the badge/detail simply doesn't render,
consistent with this being purely informational and never blocking.

## Testing

- `getContrastRatio`/`meetsWcagAA` get direct unit tests against two algebraically-exact,
  hand-provable reference values: black (`#000000`) vs. white (`#ffffff`) must be exactly 21,
  and any color against itself must be exactly 1 (same luminance on both sides of the ratio).
  A real theme value (e.g. from the shipped mock tokens) gets a hand-computed reference test
  too, verified during plan-writing with the same rigor as the OKLCH/W3C-token work — not
  invented here.
- The route gets tests covering: a real theme asset's contrast computing correctly (real temp
  DB + temp file, matching this project's established pattern), the 404/400/500 cases, and a
  known-good and a known-bad (contrast-failing) theme both returning the correct `meetsAA`
  value.
- `AssetCard`'s new fetch-and-badge behavior gets a lighter-weight check (component test if this
  project has a component-testing setup — confirm during plan-writing; otherwise, manual
  verification matching the established convention for UI-only changes in this codebase).

## Security note

No new outbound network calls, no new trust boundary — reads an already-validated theme
asset's own `.css` file (already passed `ThemeTokensSchema`'s regex validation at creation
time) and runs pure arithmetic on its two color values. The only new input surface is the
existing `id` path param, validated the same way the sibling `[id]/export` route already does.
