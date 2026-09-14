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

20 tokens total (16 colors + `--radius` + 3 font roles).

**Reading starting values — two different mechanisms, because custom properties behave differently
depending on whether their value contains a nested `var()`:**

- The 16 color tokens and `--radius` have no nested `var()` in their declared value (e.g.
  `--bg: #0A0A0A;`), so `getComputedStyle(document.documentElement).getPropertyValue('--bg')` returns
  the literal authored text, `"#0A0A0A"` — confirmed directly in a browser: unlike a real typed CSS
  property (`color`, `background-color`, …), a custom property is never resolved into an `rgb()`
  value; it has no type until something consumes it with `var()`, so `getPropertyValue` always hands
  back the exact text as written in the stylesheet. `--radius` comes back as the literal `"7px"` and
  needs `parseInt(value, 10)` to drive the number input; serialized back as `` `${value}px` ``.
- The 3 font tokens (`--font-display`, `--font-body`, `--font-mono`) DO each contain a nested
  `var(--font-sentient)`/`var(--font-satoshi)`/`var(--font-plex-mono)` reference — and
  `getComputedStyle` *substitutes* nested `var()` references before returning the value (confirmed
  directly: reading `--font-display` back returns something like
  `'"__Sentient_xxxxx", Georgia, serif'`, next/font/local's generated internal font-family name, never
  the literal `var(--font-sentient), Georgia, serif` chain any dropdown option is written as). Reading
  these 3 via `getComputedStyle` would therefore never match a dropdown option on mount. **Fix:** don't
  read these 3 via `getComputedStyle` at all — hardcode their starting selection to the obvious
  default mapping (display→Sentient, body→Satoshi, mono→Plex Mono), which is what `globals.css`
  actually assigns today and the only state this page can assume without adding back a server-side
  parse of `globals.css`'s raw text (which the whole point of this architecture is to avoid).

| Token(s) | Editor | Notes |
|---|---|---|
| `--bg`, `--surface`, `--surface-raised`, `--border`, `--ink`, `--ink-dim`, `--ink-faint`, `--accent`, `--accent-bright`, `--accent-dim`, `--accent-2`, `--accent-ink`, `--keeper`, `--keeper-dim`, `--reject`, `--reject-dim` (16 color tokens) | `<input type="color">` + a synced hex text field | Current values per `globals.css`: `#0A0A0A`, `#121212`, `#1A1A1A`, `#262626`, `#EDEDED`, `#9A9A9A`, `#6A6A6A`, `#FF4F00`, `#FF6A2B`, `#C23A00`, `#4FA8D8`, `#0A0A0A`, `#8ea885`, `#4a5c46`, `#c46a4f`, `#5c3a2c`. Sync rule: the color picker is the primary control and updates the hex text field immediately on every `input` event; the hex text field only pushes its value back to the color picker on blur/Enter, and only if it parses as a valid 6-digit hex color — this avoids fighting the picker mid-drag while someone is also mid-typing a hex value. `globals.css` itself mixes letter case (`#0A0A0A` vs `#8ea885`); the serializer normalizes every hex value to uppercase on output so Copy CSS's result is consistent regardless of which case the operator typed or `<input type="color">`'s own native casing returns. |
| `--radius` | Number input (px) | Current: `7` (parsed from the computed `"7px"` via `parseInt`). Serialized back as `${value}px`. If the operator clears the field, `state.radius` becomes an empty string — the serializer treats an empty/non-numeric value as `7` (the real current default) rather than emitting invalid CSS like `--radius: px;`. |
| `--font-display`, `--font-body`, `--font-mono` (3 font tokens) | `<select>` with exactly 3 options | GameForge self-hosts exactly 3 font families at build time (`next/font/local`/`next/font/google` in `app/layout.tsx`) — there is nothing else loaded to preview, so free-text input would only produce broken/unstyled text. The 3 options are the literal existing var chains: `var(--font-sentient), Georgia, serif` ("Sentient"), `var(--font-satoshi), -apple-system, 'Segoe UI', sans-serif` ("Satoshi"), `var(--font-plex-mono), 'IBM Plex Mono', monospace` ("IBM Plex Mono"). This lets someone preview, e.g., headings in Satoshi or body text in the mono font — a real typographic experiment within what's actually available — without ever claiming to load an unloaded font. Starting selection is hardcoded (see above), not read from `getComputedStyle`. **State representation:** each font token's React state holds the full chain string directly (e.g. `'var(--font-sentient), Georgia, serif'`), not a separate label — so `<option value={chain}>{label}</option>` and the serializer both consume the same value with no label→chain lookup table needed. |

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
  /* …all 20 tokens, in the same order as globals.css's own :root block… */
}
```

via `navigator.clipboard.writeText(serializeTokensToCss(state))`. `localhost` counts as a secure
context, so the Clipboard API works in local dev without extra configuration — but only when accessed
as `http://localhost:<port>`; if the dev server is bound to `0.0.0.0` and reached over the LAN by IP
(`http://192.168.x.x:<port>`), that origin is NOT a secure context and `navigator.clipboard` is
`undefined`. Fallback: if `navigator.clipboard` isn't available, render the same CSS text in a visible,
selected/focused `<textarea readOnly>` instead of attempting the copy, so the operator can still
manually select-and-copy rather than hitting a silent failure. This is the *only* output the feature
produces — no "Apply" button, no file write. Whoever likes a proposed set of values copies the block
and pastes it into `app/globals.css` by hand, going through the project's normal edit/review/commit
flow exactly like any other code change.

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
component-rendering tests. The plain logic gets real unit tests in `test/`, following the project's
direct-assertion style (no mocks needed, pure string building/parsing):
- `serializeTokensToCss(state): string` — given a token state object, assert the exact output string,
  including that token order matches `globals.css`'s own `:root` block order and that the 3 font
  tokens serialize as their literal `var(--font-sentient), Georgia, serif`-style chains, not just the
  font name.
- The radius parse step (`"7px"` → `7` on read, `7` → `"7px"` on write) — assert both directions.

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

See `docs/superpowers/specs/2026-09-14-dashboard-design-preview-design-review-log.md` for the DeepSeek
adversarial review round that followed this self-review — it caught one genuine, load-bearing bug (the
font-token mount-read approach above would never have matched a dropdown option) that this self-review
missed, plus a real token-count arithmetic error and two worthwhile completeness additions (hex/picker
sync semantics, a Clipboard-API LAN-access fallback). One claimed defect (colors resolving to `rgb()`
instead of staying literal hex) was checked directly in a live browser and found to be false — custom
properties preserve their authored text unless they themselves contain a nested `var()`, unlike real
typed CSS properties.
