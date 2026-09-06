# Theme Export Formats — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge's theme generation (Seed Theme Library, shipped) produces theme assets as CSS
custom properties, useful inside GameForge's own preview but not directly usable in a real
website project. This is the second of a 6-item backlog for the theme feature (see
`project_theme_generation_backlog` memory); the Seed Theme Library was the first, already
shipped. The other four (accessibility checking, dedup-steering + multi-candidate generation,
live tweaking, full component generation) are separate, later initiatives and out of scope
here.

The idea: let a user export any theme asset into a format their actual tooling understands,
so a generated or seeded theme becomes a real starting point for a real project instead of a
GameForge-only artifact.

## Source research (done during brainstorming, not re-derived here)

The original brainstorm named three targets: Tailwind config, W3C design tokens JSON, and
Figma. Real research during brainstorming found:

- **"Figma export" is not a distinct format.** The entire Figma plugin ecosystem (Token
  Exporter, Variables Import/Export, Design Tokens Manager, Token Importer, and others,
  confirmed via direct search of Figma's own Community plugin listings) works by exporting
  Figma's native Variables *out* to JSON, and converges on the **W3C Design Tokens Format**
  as the shared import/export standard. There is no third, Figma-specific format to build —
  getting a theme into Figma means exporting valid W3C tokens JSON and using an existing
  community plugin (e.g. "Token Importer") to bring it in as native Variables. **Decision:
  drop "Figma" as a separate format; the W3C JSON export serves that use case, documented in
  the export UI's help text.**
- **W3C Design Tokens Format is a real, current, stable spec** (version 2025.10, shipped
  October 2025 by the W3C Design Tokens Community Group, backed by Adobe, Figma, Google,
  Microsoft, Shopify, Salesforce, and others — confirmed via direct search). Building against
  this is the right, current target, not a guess.
- **Tailwind CSS v4 (current) replaced `tailwind.config.js` with a CSS-native `@theme {...}`
  directive** as its recommended approach — confirmed via direct search of Tailwind's own
  docs and release blog. The old JS config format still works via a compatibility path but is
  being phased out. **Decision: target the v4 `@theme` CSS format, not the legacy JS config.**

**Decision: build two formats** — a Tailwind v4 `@theme` CSS file, and a W3C Design Tokens
JSON file (which also covers the Figma use case).

## Out of scope for this feature

- **No Figma-specific format or live API push** — superseded by the W3C JSON export, per the
  research above.
- **No legacy `tailwind.config.js` output** — targets v4's current `@theme` format only. If a
  real user need for the legacy format surfaces later, that's a separate, small addition, not
  part of this feature.
- **No export-format browsing/preview UI beyond a direct download** — clicking an export
  option downloads the file; there's no in-app preview of the converted output before
  download.
- **No batch/multi-theme export** — one theme at a time, matching the per-theme UI decision
  below.

## Data model

No new tables or columns. Nothing is persisted — export is a pure, on-demand computation from
an existing theme asset's already-stored `.css` file.

**The core new capability**: a `parseThemeCss(css: string): ThemeTokens` function (the
existing `tokensToCss()`, from `lib/services/ThemeGenerator.ts`, run in reverse). This is the
one new piece of parsing logic in this feature, and it's the reliable, universal source of
structured tokens for *any* theme asset — AI-generated or seeded alike — since the `.css`
file is the only place a theme's concrete final values are guaranteed to exist. (A Style
Bible's `parameters` field is not a reliable alternative: for seed themes it happens to hold
the same `ThemeTokens` JSON, but for AI-generated themes it holds the *input* aesthetic
description handed to Claude, not the *output* tokens — parsing the `.css` file avoids this
asymmetry entirely and needs no special-casing between the two theme origins.)

Because `tokensToCss()`'s output format is simple, fully GameForge-controlled, and
deterministic (`:root { --color-bg: X; --color-fg: Y; ... }` with fixed property names), a
reverse parser for this exact, known shape is straightforward and safe to write — this is not
a general CSS parser, just the inverse of a function this codebase already owns.

## Token mapping

Both new exporter functions take the same `ThemeTokens` object (the shape `ThemeGenerator.ts`
already defines: `colorBackground`, `colorForeground`, `colorAccent`, `colorBorder`,
`fontHeading`, `fontBody`, `spaceUnit`, `radiusBase`) and produce a format-specific string.

**Tailwind v4 `@theme` export** (`tokensToTailwindTheme(tokens): string`): produces a `.css`
file with an `@theme { ... }` block. Real, exact Tailwind v4 theme-variable naming
conventions (which `--color-*`/`--font-*`/`--spacing`/`--radius-*` names actually generate the
expected utility classes, and specifically whether `--spacing` genuinely acts as a
single base multiplier for Tailwind's whole numeric spacing scale, as this spec assumes) are
**not yet independently verified** — this must be confirmed against Tailwind's own current
documentation during plan-writing, the same rigor applied to the Seed Theme Library's OKLCH
math and DaisyUI/Bootswatch parsing, not asserted here from recollection.

**W3C Design Tokens JSON export** (`tokensToW3cTokens(tokens): string`): produces a `.json`
file conforming to the Design Tokens Format Module (2025.10). Color tokens use the
spec's confirmed real shape — `$type: "color"`, `$value: { colorSpace: "srgb", components:
[r, g, b] as 0-1 floats, alpha }` — requiring each `ThemeTokens` hex color to be decomposed
into this structure. The shapes for font-family tokens (`fontHeading`/`fontBody`), dimension
tokens (`spaceUnit`/`radiusBase`), and whether top-level tokens should be grouped (e.g. under
a `"color"`/`"typography"`/`"spacing"` namespace) or left flat are **not yet independently
verified** — confirm against the real Design Tokens Format Module spec during plan-writing.

## Export mechanism

**UI surface**: a per-theme "Export" control on the theme asset's card/detail page (not a
separate dedicated page — a theme is already being looked at when a user wants to export it).
Offers both formats as direct download links/buttons — no async state needed, since this is
instant local computation with no external network call (unlike the Seed Theme Library's
import button).

**API**: `GET /api/assets/[id]/export?format=tailwind|w3c`. On request:
1. Look up the asset by id.
2. If not found, 404.
3. If `output_kind !== 'theme'`, 400 (only theme assets can be exported this way).
4. If `format` is missing or not one of `tailwind`/`w3c`, 400.
5. Read the asset's `.css` file from `storage/themes/`. If unreadable, 500 with a clear
   message (consistent with this project's established "fail loud and specific" pattern for
   file-system operations).
6. Parse it via `parseThemeCss()`, convert via the requested format's exporter function.
7. Return the result with the right `Content-Type` (`text/css` for Tailwind, `application/json`
   for W3C) and a `Content-Disposition: attachment; filename="..."` header so the browser
   downloads it directly. The filename is derived from the asset's Style Bible name (looked up
   via the asset's `style_id`), slugified (lowercase, non-alphanumeric runs collapsed to a
   single `-`) plus the format's extension — e.g. a Style Bible named `"DaisyUI: Cyberpunk"`
   exporting as Tailwind produces `daisyui-cyberpunk.css`; as W3C JSON, `daisyui-cyberpunk.json`.
   This is friendlier than a generic `theme.css`/`tokens.json` for a user exporting several
   themes in one session, and needs no new data — the join already exists via `style_id`.

## Error handling

- Asset not found: 404, matching the existing convention for asset-lookup routes.
- Non-theme asset requested: 400 with a clear message ("this asset is not a theme").
- Unrecognized/missing `format` query param: 400 listing the valid values.
- Missing/corrupted `.css` file on disk: 500, logged via `console.error`, matching the
  project's established file-system error convention — this should be rare (the file is
  written at theme-creation time and only removed by `cleanupOrphanedThemes()`, which never
  removes a file still referenced by an active asset).

## Testing

- `parseThemeCss()` gets a round-trip test: `tokensToCss(tokens)` then `parseThemeCss(...)`
  must recover the original `ThemeTokens` object, checked against several realistic token
  sets (not just one trivial case).
- Both exporter functions (`tokensToTailwindTheme`, `tokensToW3cTokens`) get direct unit
  tests against a known `ThemeTokens` input, asserting the exact expected output string —
  the expected values must be derived from the real, verified format specs (see Token
  mapping above), not invented, matching this project's established rigor for new,
  correctness-critical conversions.
- The API route gets tests covering: successful export in each format (real temp DB + temp
  theme `.css` file, matching this project's established test pattern), the 404 case, the
  wrong-`output_kind` 400 case, the bad-`format` 400 case, and the missing-file 500 case.

## Security note

This feature does no new outbound network calls and touches no new trust boundary — it reads
an already-validated theme asset's own `.css` file (which only ever contains values that
already passed `ThemeTokensSchema`'s regex validation when the theme was created) and
reformats it into two other text formats. No new user input is accepted beyond the existing
`id` path param and a `format` enum query param, both of which get explicit validation before
any file read happens.
