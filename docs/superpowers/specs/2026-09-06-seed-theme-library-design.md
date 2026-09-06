# Seed Theme Library — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge's theme generation (shipped in two prior PRs) only produces themes
via a real Claude API call. A fresh install starts with an empty Assets
library — no theme exists until someone spends a generation. This is the
first of a 6-item backlog for the theme feature; the other five (export
formats, accessibility checking, dedup-steering + multi-candidate
generation, live tweaking, full component generation) are separate,
later initiatives and out of scope here.

The idea: seed the dashboard with ready-made, human-designed themes pulled
from existing, well-known open-source color/theme collections — no AI
generation cost, immediate value, and no reason to reinvent color theory
that's already been done well and released permissively.

## Source research (done during brainstorming, not re-derived here)

Four candidate categories of external source were checked before settling
on two:

- **Raw color-scale libraries** (Tailwind CSS's `colors` export, Open
  Color, Radix Colors) — all real, MIT-licensed, currently maintained.
  Rejected as the primary source: each ships individual color
  *families* (many shades of "blue", "red", etc.), not composed themes —
  turning one into a background+foreground+accent+border set requires an
  algorithm we don't have, whereas what this feature actually needs is
  content that's already "a theme."
- **DaisyUI** (`github.com/saadeghi/daisyui`, MIT) — ~35 pre-composed,
  named themes (`light`, `dark`, `cyberpunk`, `dracula`, `synthwave`,
  `luxury`, `cupcake`, etc.), each defining a real, cohesive set of
  design tokens. **Accepted.** v4's static CSS file
  (`unpkg.com/daisyui@4.9.0/dist/themes.css`) was fetched directly and
  confirms the real variable names and value format: `--p` (primary),
  `--a` (accent), `--n` (neutral), `--b1`/`--b2`/`--b3` (background
  layers), each holding a **bare OKLch triple** (`"65.69% 0.196
  275.75"` — lightness/chroma/hue, no `oklch()` wrapper, no hex). This
  is the real complication: GameForge's existing `CSS_COLOR_RE` (a
  deliberate CSS-injection guard on generated tokens) only accepts hex,
  `rgb()`/`rgba()`, `hsl()`/`hsla()`, and bare named colors — it does not
  accept OKLch. Importing DaisyUI's real values requires a genuine
  OKLch→sRGB-hex color-space conversion, not a string reformat.
- **Bootswatch** (`github.com/thomaspark/bootswatch`, MIT) — ~26
  Bootstrap theme variants (`Flatly`, `Darkly`, `Materia`, `Superhero`,
  etc.), each overriding Bootstrap's own SCSS design-token variables.
  **Accepted.** Has an official JSON API (`api.bootswatch.com`) and,
  critically, Bootstrap's own variable system uses plain hex/rgb colors
  — no color-space conversion needed, dropping straight into the
  existing `CSS_COLOR_RE` validation unchanged.
- **shadcn/ui "theme presets"** — rejected. Not an official shadcn/ui
  resource; the only presets found (`@madooei/shadcn-theme-presets`) are
  a third-party package derived from a *different* third-party tool
  (tweakcn), two steps removed from anything authoritative. More
  license/maintenance uncertainty for no real gain over DaisyUI/Bootswatch.
- **Flowbite** — rejected. Only 5 presets, and they read as
  typography/spacing tone-shifts more than distinct color palettes. Not
  enough variety to justify a third source.
- **Chakra UI** — rejected as a wrong fit for this category entirely. It
  doesn't ship pre-made named themes — it ships a theming *system* plus
  third-party color-generation tools, closer to the rejected raw-scale
  category than to DaisyUI/Bootswatch.

Decision: **use both DaisyUI and Bootswatch** — roughly 61 total seed
themes, both real design-token overrides (not just color swatches), one
straightforward to map (Bootswatch, hex) and one requiring new
color-conversion logic (DaisyUI, OKLch) but offering more themes and more
distinctive naming/personality.

## Out of scope for this feature

- **No raw color-scale sources** (Tailwind/Open Color/Radix) — explicitly
  rejected above; revisit only if DaisyUI+Bootswatch prove insufficient.
- **No custom/generated seed themes** — every seed theme is a faithful
  derivation of a real, named source theme, not a new creative work.
- **No live sync with upstream.** If DaisyUI or Bootswatch add new themes
  later, re-running the import picks them up (see "Idempotency" below),
  but there's no background job watching for upstream changes.
- **No UI for browsing/filtering the two sources separately before
  import** — the single Import button pulls everything from both at
  once; the other 5 backlog items (this spec's siblings) may eventually
  add richer browsing, but that's not this feature's job.

## Data model

No new tables or columns. A seed theme becomes exactly what an
AI-generated, promoted theme already is:

- One new `styles` row (a Style Bible) per seed theme, since each
  DaisyUI/Bootswatch theme is its own distinct aesthetic — grouping all
  61 under one "seed" Style Bible would contradict the existing rule
  that a Style Bible represents one shared aesthetic (established for
  AI-generated content, kept consistent here).
- One new `assets` row per seed theme, `output_kind = 'theme'`,
  `image_path` pointing at a real `.css` file under `storage/themes/`
  (built via the *existing* `tokensToCss()` function — no new CSS-writing
  code, this feature only produces `ThemeTokens` objects and hands them
  to code that already exists).
- Seed assets are inserted **already active** (`is_deleted = 0`, no
  corresponding `jobs` row) — they're not AI output, so there's nothing
  to review or promote. This matches the earlier decision: seed content
  lands directly as ready-to-use Assets, not through the Jobs queue.
- `created_by` on both the seeded `styles` and `assets` rows uses a fixed
  constant (e.g. `'system-seed'`) rather than a real client UUID, since
  no browser session created them. This is consistent with the existing
  "only the creator can edit" rule — a real user forks a seeded Style
  Bible (the existing fork mechanism, unchanged) to make their own
  editable copy, exactly like forking anyone else's Style Bible today.

**Naming, for attribution and idempotency:** each Style Bible is named
`"DaisyUI: <ThemeName>"` or `"Bootswatch: <ThemeName>"` (e.g. `"DaisyUI:
Cyberpunk"`, `"Bootswatch: Flatly"`) — human-readable attribution with no
new schema needed, and the exact string the import logic checks before
creating a duplicate on a second run (see Idempotency).

## Token mapping

Both sources produce a `ThemeTokens` object (the same shape
`AnthropicThemeGenerator`/`ClaudeApiThemeGenerator` already produce) via a
per-source mapper function. Two fields have no equivalent in either
source and get a fixed default for every seed theme:

- `spaceUnit`: always `'8px'` — neither source defines a spacing-scale
  concept per-theme (Bootstrap/DaisyUI's spacing is a shared, global
  scale, not something that varies by theme).
- `fontHeading`/`fontBody`: neither source specifies fonts. A small,
  curated lookup table (one entry per theme name, roughly 61 rows total)
  assigns a heading/body font pair chosen to match each theme's own
  vibe — e.g. `cyberpunk`/`synthwave` get a techy/monospace-leaning
  pairing, `luxury`/`elegant-luxury`-type themes get an elegant serif
  pairing, `cupcake`/playful ones get a rounded sans pairing. This table
  is a one-time authoring task during implementation, not a per-run
  computation.

**DaisyUI mapping** (from the confirmed real v4 variable names):
- `--b1` → `colorBackground`
- `--a` → `colorAccent`
- `--n` → `colorBorder`
- `--bc` → `colorForeground` (confirmed by fetching the real `light`
  theme block — this is DaisyUI's base-content/text variable).
- `--rounded-btn` → `radiusBase`. Confirmed already a plain CSS length
  (`0.5rem` for the `light` theme) — **not** OKLch, so radius needs no
  color conversion at all, only the four color fields do.
- Every DaisyUI color value (background, foreground, accent, border)
  passes through a new OKLch→hex conversion function before being handed
  to `ThemeTokensSchema` — this is the one genuinely new piece of
  correctness-critical logic in this feature (see Testing below for how
  it gets verified).

**Bootswatch mapping** — confirmed by fetching a real theme end to end,
which surfaced a genuine complication the initial research missed:
Bootswatch's `_variables.scss` (linked from its own API response) only
contains **theme-specific overrides**, some of them SCSS aliases (e.g.
`$primary: $blue`, not a raw hex value) — `$body-bg`/`$body-color`/
`$border-radius` aren't declared there at all, since they inherit
Bootstrap's own core defaults unless a theme explicitly overrides them.
Actually resolving a theme's *effective* values from the SCSS source
would require a real Sass compilation step.

The working alternative, confirmed against a real fetch: Bootstrap
5.3+'s **compiled** CSS output (the API response's `cssMin` /
`cssCdn` link, e.g. `bootstrap.min.css`) exposes the final, resolved
values as plain native CSS custom properties in its own `:root` block:
`--bs-body-bg` → `colorBackground`, `--bs-body-color` →
`colorForeground`, `--bs-primary` → `colorAccent`, `--bs-border-color`
→ `colorBorder`, `--bs-border-radius` → `radiusBase`. All confirmed
already hex/rem in the real fetched file — no SCSS compilation, no
color-space conversion, just parsing a `:root { ... }` block out of a
plain CSS file fetched from the URL the API response already provides.

Both mappers produce `ThemeTokens` objects that go through the
**existing, unmodified** `ThemeTokensSchema.parse()` — the same
regex-based validation AI-generated tokens already pass through. If a
converted/mapped value somehow fails that validation (e.g., a conversion
edge case producing an out-of-range hex), that one theme is skipped and
logged, not silently corrected — consistent with this project's
established "fail loud and specific, not silent" pattern for generation
failures.

## Import mechanism

A single button, **"Import Seed Themes,"** on a Settings page (new
section, or added to the existing Storage settings page — a plan-level
layout decision, not a data-model one). Matches this project's existing
pattern for manual, on-demand admin actions (Storage cleanup, Aseprite
path). Clicking it:

1. Fetches DaisyUI's theme CSS and Bootswatch's theme API (the one place
   this feature makes real outbound network calls — both to fetch static,
   public, unauthenticated data, no API key needed for either).
2. Parses both into token sets via their respective mapper functions.
3. For each resulting theme, checks whether a Style Bible with that exact
   attributed name (`"DaisyUI: X"` / `"Bootswatch: X"`) already exists;
   skips it if so.
4. For every theme that doesn't already exist, creates the Style Bible +
   asset pair described above.
5. Reports back how many were imported and how many were already present
   (skipped) — mirroring the existing Storage-cleanup button's
   "Removed N files" result-message pattern.

**Idempotency is the whole point of the name-based existence check**:
clicking the button again later (e.g., after DaisyUI or Bootswatch add
new themes upstream) only creates what's genuinely new, never duplicates
what's already there.

## Error handling

- If fetching either source fails (network error, source unreachable),
  that source is skipped with a clear error surfaced in the result
  message; the other source still imports normally — a Bootswatch outage
  shouldn't block DaisyUI import or vice versa.
- If a specific theme's mapped tokens fail `ThemeTokensSchema`
  validation, that one theme is skipped and logged (see Token mapping
  above) — one bad theme doesn't abort the whole batch.
- The import action itself requires no new secrets/API keys — both
  sources are public, unauthenticated endpoints.

## Testing

- The OKLch→hex conversion function gets direct unit tests against
  hand-verified reference values (a small number of known
  OKLch-triple-to-hex conversions, checked against a reliable external
  color-conversion reference during implementation) — this is new,
  correctness-critical math with no prior test coverage anywhere in this
  codebase, so it earns real scrutiny on its own.
- Both source mappers (DaisyUI CSS → `ThemeTokens`, Bootswatch JSON →
  `ThemeTokens`) are tested against realistic fixture data (a real
  excerpt of DaisyUI's actual CSS, a real-shaped Bootswatch API response)
  with `fetch` mocked — the same "mock only the external HTTP boundary"
  pattern this project already uses for `ClaudeApiThemeGenerator`'s
  tests, not a new testing philosophy.
- The idempotency check (name-based skip on re-import) gets a direct
  test: run the import twice against the same mocked source data, assert
  the second run creates zero new rows.
- The font-pairing lookup table gets a completeness test — every theme
  name either source can produce has a corresponding font-pair entry, so
  a newly-added upstream theme fails loudly (missing table entry) rather
  than silently falling back to some default that was never actually
  decided.

## Security note

Both fetch targets (`unpkg.com`, `api.bootswatch.com`) are well-known,
long-standing public CDN/API hosts serving static, public data — no
credentials involved, nothing user-controlled reaches these requests
(the button takes no input). The only new trust boundary is the fetched
content itself, which flows through the same `ThemeTokensSchema` regex
validation as every other theme source before it can reach a `.css` file
— no new injection surface beyond what AI-generated themes already have
and are already defended against.
