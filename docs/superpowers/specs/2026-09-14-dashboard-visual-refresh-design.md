# Dashboard Visual Refresh — Design

## Goal

Replace GameForge's current amber/charcoal visual language with a Persimmon-on-Obsidian palette and
a Sentient/Satoshi typeface pairing, restructure the sidebar (11 visible items instead of 15, settings
collapsed behind a hub page), and add a new Overview landing page — all inspired by the user's own
"Voltair" studio portal, cross-checked against Vercel's Geist design system and Linear's dark-mode
conventions for a sleeker, less cluttered feel.

Explicitly deferred, raised during this same brainstorm: a persistent, in-app design/mockup preview
tool (so future design decisions don't need the external brainstorming-companion server). Unrelated
subsystem, its own future brainstorm — not touched here.

## Scope

**In scope:**
- New color and font tokens in `app/globals.css`, propagated automatically to every existing page via
  the shared CSS classes they already compose from (`.card`, `.btn`, `.btn-primary`, `.frame-label`,
  `.page-title`, `.page-subtitle`, `.empty-state`) — no per-page TSX changes for the visual language
  itself.
- Sentient (display/headings) and Satoshi (body) loaded via `next/font/local` from self-hosted Fontshare
  variable-font files the user provides; `next/font/google`'s Space Grotesk and Inter are dropped.
  IBM Plex Mono (`--font-mono`) is unchanged — no reference named a replacement for it.
- A new `/dashboard` Overview page (replacing today's redirect-to-`/dashboard/generate`): stat cards
  (active styles, total assets, in-flight jobs — reusing the existing `getProjectContextSummary()`),
  quick-action buttons, and a recent-activity feed derived from existing timestamped data.
- A new `/dashboard/settings` hub page listing the 5 existing settings pages (Storage, Aseprite, Seed
  Themes, Google Drive, Ollama) — those 5 routes and their pages are otherwise untouched.
- `NavRail` restructured: Overview + 9 tool links, a divider, one "Settings" link to the new hub —
  down from today's flat 15-link list.
- One new `JobService` method for the activity feed's job-side data (see Section 3).

**Out of scope:**
- The persistent in-app design-preview tool (separate future idea, not this refresh).
- Any change to the 5 individual settings pages' own content/behavior — only their sidebar visibility
  changes.
- A dedicated activity-log table or write-side event logging — the feed is derived from existing data
  only (see Section 3 for why).
- Changing `--font-mono` / IBM Plex Mono.
- Any change to the AI copilot's own behavior beyond the two new `DASHBOARD_ROUTES` entries it needs
  to stay accurate (see Section 2).

## Why this is feasible now (what it reuses vs. what's new)

- **Every existing page already renders through a shared token/class system** (`app/globals.css`'s
  `:root` custom properties, plus `.card`/`.btn`/`.frame-label`/etc. used throughout `app/dashboard/**`)
  — confirmed by grep across the existing pages this session already touched (Themes, Components,
  Generate, and others all compose from these same classes). Redefining the tokens and the shared
  classes is enough; no page-by-page migration.
- **`getProjectContextSummary()`** (`lib/services/projectContext.ts`, extracted during the AI-copilot
  work) already computes exactly the three numbers the Overview page's stat cards need
  (`styles[].assetCount` summed for "total assets", `styles.length` for "active styles",
  `inFlightJobs`) — reused as-is, no new aggregation logic for that part.
- **`DASHBOARD_ROUTES`** (`lib/dashboardRoutes.ts`, also from the copilot work) is already the single
  source of truth `NavRail` and the AI copilot's `navigate_to_page` tool both depend on — this refresh
  adds two entries to it rather than inventing a second route list.
- **`StyleService.getActiveStyles()`** already returns styles newest-first (`ORDER BY created_at
  DESC`) — reused directly for the activity feed's "recently created styles" half.

## Architecture

### Section 1 — Visual tokens

Replace in `app/globals.css`'s `:root` block:

```css
--bg: #0A0A0A;              /* was #1c1a17 */
--accent: #FF4F00;          /* Persimmon, was #e8a33d */
--accent-bright: #FF6A2B;   /* new — hover states */
--accent-dim: #C23A00;      /* new — pressed/active states */
--accent-2: #4FA8D8;        /* new — secondary/metadata tone (card labels etc.), explicitly not
                                purple/violet per user direction */
--font-display: var(--font-sentient), Georgia, serif;   /* was Space Grotesk */
--font-body: var(--font-satoshi), -apple-system, sans-serif;  /* was Inter */
```

`--font-mono`, `--surface`/`--surface-raised`/`--border`/`--ink`/`--ink-dim`/`--ink-faint` are re-tuned
(not necessarily kept at their current hex values) so they read as clear, distinct gray steps against
true black rather than against the current charcoal-brown — the exact values are a small implementation
judgment call (matching the mockup's `#121212` cards / `#262626` borders / `#EDEDED`-`#6A6A6A` ink
ladder shown and approved in the brainstorming-companion preview), not independently re-litigated per
value. `--keeper`/`--keeper-dim`/`--reject`/`--reject-dim` (promote/discard semantic colors) are
unchanged — no reference or user direction touched them, and changing them isn't part of this refresh.

Radius: cards, buttons, and inputs move to a consistent ~7-8px radius (`--radius` currently `3px`) —
matches both the Voltair reference and Vercel Geist's "one small radius everywhere" convention.

### Section 2 — Fonts

`app/layout.tsx` currently loads Space Grotesk, Inter, and IBM Plex Mono via `next/font/google`.
Sentient and Satoshi are Fontshare fonts, not on Google Fonts — they load via `next/font/local`
instead, from variable-font `.woff2` files the user downloads from fontshare.com and places at
`public/fonts/Sentient-Variable.woff2` and `public/fonts/Satoshi-Variable.woff2` (a new `public/fonts/`
directory; `public/` already exists in this project for static assets). IBM Plex Mono's
`next/font/google` loading is untouched.

```tsx
import localFont from 'next/font/local';

const sentient = localFont({
  src: '../public/fonts/Sentient-Variable.woff2',
  variable: '--font-sentient',
  display: 'swap',
});
const satoshi = localFont({
  src: '../public/fonts/Satoshi-Variable.woff2',
  variable: '--font-satoshi',
  display: 'swap',
});
```

(Exact `src` path depends on where the user places the files — this is illustrative, not final. If the
font files aren't available yet when implementation starts, this task blocks on them specifically;
everything else in this spec — colors, nav restructure, new pages — has no dependency on the fonts and
can ship independently.)

### Section 3 — Sidebar restructure

`lib/dashboardRoutes.ts`'s `DASHBOARD_ROUTES` gains two entries:

```ts
{ href: '/dashboard', label: 'Overview' },
{ href: '/dashboard/settings', label: 'Settings' },
```

(placed first and appropriately, respectively) — the 5 existing `/dashboard/settings/*` entries stay
in the array unchanged, since they're still real, individually navigable pages the AI copilot can send
a user to directly (e.g. "take me to Ollama settings" still resolves straight to
`/dashboard/settings/ollama`, bypassing the new hub — the hub is a manual-browsing convenience, not a
routing gate).

`NavRail.tsx` stops rendering `DASHBOARD_ROUTES` as one flat list. It renders: the `Overview` entry,
then every entry whose `href` doesn't start with `/dashboard/settings/` (i.e. the 9 tool routes, in
their existing order), then a visual divider, then just the `Settings` hub entry — hiding the 5
individual settings sub-routes from the visible rail without removing them from `DASHBOARD_ROUTES`.
This is the one place `NavRail`'s rendering and `DASHBOARD_ROUTES`'s full contents deliberately
diverge; the copilot's tool schema keeps using the complete, unfiltered array.

### Section 4 — Overview page (`app/dashboard/page.tsx`)

Currently a client-less redirect to `/dashboard/generate`. Replaced with a real page:

- **Stat cards**: active styles count, total assets, in-flight jobs — from `getProjectContextSummary()`
  (already returns `{styles: [{id,name,assetCount}], totalActiveAssets, inFlightJobs}`), fetched via
  the existing `GET /api/context` route, same pattern as any other dashboard page's data fetch.
- **Quick actions**: buttons linking to `/dashboard/generate`, `/dashboard/styles` (new Style Bible),
  and `/dashboard/settings/ollama` — three fixed links, not configurable, matching the mockup.
- **Recent activity**: see Section 5 below for where this data comes from.

### Section 5 — Recent activity data source

No new table, no write-side event logging (explicitly rejected during brainstorming — GameForge has
no existing activity-log concept, and instrumenting every mutation site across the app is a much
larger, ongoing-maintenance change than this refresh calls for). Instead, one new method:

```ts
// lib/services/JobService.ts — new method
async getRecentlyResolved(limit: number): Promise<Job[]> {
  const db = DatabaseConnection.getInstance();
  const rows = db.prepare(
    `SELECT * FROM jobs WHERE status IN ('promoted', 'discarded', 'failed')
     ORDER BY updated_at DESC LIMIT ?`
  ).all(limit);
  return rows.map(row => JobSchema.parse(row));
}
```

merged with the first few entries of the already-sorted `StyleService.getActiveStyles()` (newest
`created_at` first), interleaved by timestamp, capped at ~6-8 total items. Following the
`getProjectContextSummary()` precedent (aggregation logic lives in a service function, the route just
calls it), this merge lives in a new `getRecentActivity(limit)` function in a new
`lib/services/recentActivity.ts`, called from a new `app/api/dashboard/activity/route.ts`.

### Section 6 — Settings hub page (`app/dashboard/settings/page.tsx`, new)

A static list of the 5 existing settings pages (name + one-line description, taken from each page's
own real `page-subtitle` copy — same "reuse the app's own existing copy" approach the AI copilot's
knowledge doc used) as clickable rows linking to each real route. No new data fetching — this page is
pure navigation, not a dashboard of settings state.

## Error handling

- `getRecentlyResolved()` follows the same pattern as every other direct-SQL service method in this
  codebase — a DB-level failure surfaces as an uncaught exception, caught by the Overview page's data
  route and returned as a normal `{success:false, error}` 500, same as every other dashboard page.
- If the font files aren't present when `next/font/local` tries to load them at build/dev-server start,
  Next.js fails loudly at build time (not a silent runtime fallback) — this is the correct behavior
  here (a missing font file is a real configuration error, not something to degrade gracefully from).

## Testing

- `getRecentlyResolved()`: a unit test against a real temporary SQLite file (this codebase's
  established pattern), covering: only `promoted`/`discarded`/`failed` jobs are returned (not
  `pending`/`processing`), ordering is newest-`updated_at`-first, and the `limit` is respected.
- No React rendering tests for the new Overview/Settings-hub pages or the restructured `NavRail` —
  matches this codebase's established, deliberate convention (confirmed zero `@testing-library` usage
  anywhere) from the AI-copilot work; verified manually in a browser instead.
- Manual verification checklist (to include explicitly in the eventual plan, learning from the AI
  copilot plan's own final-review finding that a missing manual-check line let a real bug ship): open
  `/dashboard` fresh after login, confirm stat cards show real counts; open `/dashboard/settings`,
  confirm all 5 links work; confirm the AI copilot can still navigate directly to a settings sub-page
  it's told to (e.g. "take me to Ollama settings") even though that link is no longer in the visible
  rail.

## Follow-ups explicitly deferred, not forgotten

- A persistent, in-app design/mockup preview tool (raised mid-brainstorm; separate subsystem, its own
  future brainstorm).
- Any further page-specific layout redesign beyond the shared token/component restyle — this refresh
  is deliberately Approach A (token-first), not a page-by-page redesign (Approach B, considered and
  rejected as unnecessary scope for what the reference and research both showed as achievable through
  a consistent shared component system).
