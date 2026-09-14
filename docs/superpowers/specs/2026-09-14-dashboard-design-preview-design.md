# Dashboard Design Preview — Design Spec

## Motivation

GameForge's own dashboard UI (not the game themes it generates for users) has a design system:
`app/globals.css`'s `:root` block of CSS custom properties, consumed throughout the app's shared
classes (`.btn`, `.card`, `.rail-link`, etc.). Up to now, evaluating a proposed change to that design
system (a new accent color, a different font pairing) has meant either eyeballing raw hex values, or
standing up the `superpowers:brainstorming` skill's external visual-companion server for a one-off
mockup session.

Raised by the user mid-brainstorm on the 2026-09-14 dashboard visual refresh: "This is exactly
something that should be built into the dashboard as a feature that AIs should be able to make use
of. So its ready to go instead of you having to build it ever again." This spec is that follow-up: a
small, permanent, built-in page for live-editing GameForge's own UI tokens and seeing the result
rendered against real component classes, with no external tooling required.

**Out of scope, explicitly:** this previews GameForge's own dashboard chrome, not the game themes a
Style Bible generates (that's the existing, unrelated live-theme-tweaking feature at
`app/dashboard/jobs/[id]/edit/page.tsx`, built around a completely different token set —
`ThemeTokens` — for a different purpose). No DB persistence, no API routes, no file-write path —
confirmed unnecessary during brainstorming (see Architecture).

## Architecture

A single, fully client-side Next.js page: `app/dashboard/settings/design-preview/page.tsx`. No new
API route, service, or database table.

**Why no iframe (unlike the existing theme-preview tool):** `lib/utils/themePreview.ts`'s
iframe+`sandbox=""` approach exists because *generated* `ThemeTokens` use variable names
(`--color-bg`, `--font-heading`, …) that collide with GameForge's own `globals.css` names if rendered
in the same document — the iframe is what prevents a generated theme's `--font-body` from stomping the
dashboard's own `--font-body`. That collision risk doesn't apply here: this feature previews different
*values* for the *same* variable names GameForge's own UI already uses, on purpose. CSS resolves that
cleanly with ordinary specificity — an inline `style` attribute beats a `:root` rule — so the whole
feature is one `<div>` wrapping a mockup, with every previewed token set as an inline custom property
on that div:

```tsx
<div style={{ '--bg': state.bg, '--accent': state.accent, /* …every token… */ } as React.CSSProperties}>
  {/* mockup markup below, using the real shared classes */}
</div>
```

Every element inside that div that reads `var(--bg)` (directly, or transitively through a shared class
like `.btn-primary { background: var(--accent); }`) sees the overridden value. Nothing outside the div
is touched — the real `NavRail`, the rest of the real page, are unaffected. No sandboxing, no
`srcDoc` regeneration, no `postMessage` — ordinary React state and ordinary CSS cascade rules.

## Token model

19 tokens total, read from the real page's own computed styles on mount
(`getComputedStyle(document.documentElement).getPropertyValue('--bg')`, one call per token name) so
the form always starts from whatever is *actually* live in `globals.css` right now — no duplicated
source of truth to drift out of sync.

| Token(s) | Editor | Notes |
|---|---|---|
| `--bg`, `--surface`, `--surface-raised`, `--border`, `--ink`, `--ink-dim`, `--ink-faint`, `--accent`, `--accent-bright`, `--accent-dim`, `--accent-2`, `--accent-ink`, `--keeper`, `--keeper-dim`, `--reject`, `--reject-dim` (16 color tokens) | `<input type="color">` + a synced hex text field | Current values per `globals.css`: `#0A0A0A`, `#121212`, `#1A1A1A`, `#262626`, `#EDEDED`, `#9A9A9A`, `#6A6A6A`, `#FF4F00`, `#FF6A2B`, `#C23A00`, `#4FA8D8`, `#0A0A0A`, `#8ea885`, `#4a5c46`, `#c46a4f`, `#5c3a2c`. |
| `--radius` | Number input (px) | Current: `7`. Serialized back as `${value}px`. |
| `--font-display`, `--font-body`, `--font-mono` (3 font tokens) | `<select>` with exactly 3 options | GameForge self-hosts exactly 3 font families at build time (`next/font/local`/`next/font/google` in `app/layout.tsx`) — there is nothing else loaded to preview, so free-text input would only produce broken/unstyled text. The 3 options are the literal existing var chains: `var(--font-sentient), Georgia, serif` ("Sentient"), `var(--font-satoshi), -apple-system, 'Segoe UI', sans-serif` ("Satoshi"), `var(--font-plex-mono), 'IBM Plex Mono', monospace` ("IBM Plex Mono"). This lets someone preview, e.g., headings in Satoshi or body text in the mono font — a real typographic experiment within what's actually available — without ever claiming to load an unloaded font. |

`--font-sentient`/`--font-satoshi`/`--font-plex-mono` themselves (the actual font-loader-generated
variables) are not edited here — they're set once on `<html>`/`<body>` by `next/font/local`/
`next/font/google` in `app/layout.tsx` and inherited normally; this page only changes *which role* uses
which of the three.

## Mockup content

One compact preview column inside the overridden div, built from real shared classes (not a
hand-maintained duplicate stylesheet, so it can't silently drift from what `globals.css` actually
contains today):

- A miniature nav strip: the `GameForge` brand mark plus two or three `.rail-link`s, one with
  `data-active="true"`.
- A `.page-title` / `.page-subtitle` pair.
- A `.card` containing a `.stat-card-label` / `.stat-card-value` pair.
- All 4 button variants: `.btn`, `.btn-primary`, `.btn-keeper`, `.btn-reject`.
- A `.settings-item` (with its `.settings-item-desc`).
- An `.activity-row` (with its `.activity-row-meta`).

This set exercises every token-consuming shared class that exists in `globals.css` as of this spec;
it is not meant to be perfectly exhaustive forever — if a future refresh adds a genuinely new shared
class, extending this list is a one-line addition to this page, not a redesign.

## Copy CSS

A single "Copy CSS" button serializes the current form state into a ready-to-paste block:

```css
:root {
  --bg: #0A0A0A;
  --surface: #121212;
  /* …all 19 tokens, in the same order as globals.css's own :root block… */
}
```

via `navigator.clipboard.writeText(serializeTokensToCss(state))`. `localhost` counts as a secure
context, so the Clipboard API works in local dev without extra configuration. This is the *only*
output the feature produces — no "Apply" button, no file write. Whoever likes a proposed set of
values copies the block and pastes it into `app/globals.css` by hand, going through the project's
normal edit/review/commit flow exactly like any other code change. `serializeTokensToCss` is the one
piece of plain logic in this feature and gets a real unit test (plain string-building — given a token
state object, assert the exact output string).

## Navigation

A 6th card on the existing Settings hub (`app/dashboard/settings/page.tsx`), alongside Storage /
Aseprite / Seed Themes / Google Drive / Ollama — this is a machine/meta-level tool about the app's own
UI, not a game-asset tool, matching what already lives on that page. Added to `DASHBOARD_ROUTES` in
`lib/dashboardRoutes.ts` as `{ href: '/dashboard/settings/design-preview', label: 'Design Preview' }`
(a 6th hidden settings sub-route, following the exact same pattern as the other 5 — valid for the AI
copilot's `navigate_to_page` tool, not rendered in the main sidebar) and as a 6th entry in the Settings
hub page's own `SETTINGS_PAGES` list.

## Error handling

Minimal, deliberately — this is a single-operator local tool with no untrusted input anywhere in its
data flow (no network request, no user-supplied data beyond the operator's own typing in color/number/
select inputs, which the browser's own input types already constrain). If `getComputedStyle` ever
returns an empty string for a token (e.g. a future token get renamed in `globals.css` without this
page being updated to match), that field simply starts blank rather than throwing — the operator can
just type a value.

## Testing

Matches this codebase's established, deliberate convention: zero `@testing-library` usage anywhere in
this project, new dashboard UI is verified manually in a running dev server, not via automated
component-rendering tests. The one piece of plain logic — `serializeTokensToCss(state): string` — gets
a real unit test in `test/`, following the project's direct-assertion style (no mocks needed, pure
string building).

## Spec self-review

- **Placeholder scan:** none — every section above has concrete values (the real current hex codes,
  the real 3 font options, the real 6 mockup component classes), not TBDs.
- **Internal consistency:** the "no DB, no API route" architecture claim holds throughout — every
  later section (token model, copy CSS, error handling) stays purely client-side with no contradicting
  server-side step introduced.
- **Scope:** small and single-purpose enough for one implementation plan; no decomposition needed.
- **Ambiguity check:** the one genuinely judgment-laden point — whether font tokens should allow free
  text vs. a fixed dropdown — is resolved explicitly above with the reasoning (no other fonts are
  actually loaded at runtime, so free text would only ever produce broken previews).
