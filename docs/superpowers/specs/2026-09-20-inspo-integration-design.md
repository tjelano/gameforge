# Inspo integration — design spec

## Goal

Bring `github.com/Nutlope/inspo` (an MCP server exposing a searchable archive of 2,320 real
production website pages across 832 sites — palettes, fonts, layout tokens, per-site DESIGN.md
files, cropped reference components) into GameForge, in two independent, loosely-coupled ways:

1. **Seed a new Style Bible from a real site**, searched or browsed from the archive — an
   alternative source alongside the existing "Import from design tokens" (W3C JSON) flow.
2. **Ground component generation with a real reference image**, opt-in per Style Bible — reusing
   GameForge's *existing* reference-image mechanism (the one already used for user-uploaded
   references), not a new prompt-injection pathway.

Both features are independently usable. Neither requires the other.

## Non-goals (explicitly out of scope for this spec)

- **Distilling Hallmark's anti-slop rules into GameForge's generation prompts.** This is a
  separate, still-unscoped piece of the same brainstorming conversation this spec came out of —
  deferred, not dropped. See the session's own notes (or ask the user) for where that stands.
- **Mandatory/always-on grounding.** Every generation call today works exactly as it does now,
  with or without this feature. Grounding is an opt-in Style Bible setting, and it fails silently
  closed (generation proceeds without a reference) rather than ever blocking or erroring a
  generation on Inspo being slow or unavailable.
- **Persisting or mirroring Inspo's archive locally.** GameForge calls Inspo's hosted endpoint
  live; it does not download/cache the archive itself, only a small per-(Style Bible, component
  type) reference-image cache (see below).
- **Self-hosting Inspo.** The design assumes the public hosted endpoint
  (`https://inspomcp.dev`), configurable via an env var for a future self-host if ever needed, but
  no self-host setup is part of this work.

## Background — confirmed facts this design depends on

(Verified directly against Inspo's source, 2026-09-20, commit `85acb10f`. Re-verify if this design
is picked up much later — an unauthenticated public API can change.)

- **Two invocation surfaces.** A plain, unauthenticated REST `GET` returns one known site's
  DESIGN.md as raw markdown: `https://inspomcp.dev/api/design/<slug>` (also mirrored at
  `/d/<slug>/DESIGN.md`). No MCP client needed — a single `fetch()`. Everything else that actually
  *searches or recommends* (`search_screens`, `recommend`, `find_components`, `find_by_color`,
  `get_filters`, etc.) is MCP-only, served as JSON-RPC 2.0 over Streamable HTTP at
  `POST https://inspomcp.dev/api/mcp`. Still just a server-to-server call, no agentic session — but
  it is a real `initialize`/`initialized`/`tools/call` handshake with possible SSE-framed
  responses, not a single plain-JSON POST (see Feature 1's server design below for why this design
  uses the official MCP SDK rather than hand-rolling that envelope).
- **No auth, free, rate-limited.** 120 requests/minute per warm Vercel lambda instance
  (IP-keyed, soft brake, not a hard account fence), 256KB request body cap. No API key for either
  surface.
- **DESIGN.md's real structure** (from `packages/db/src/design-md.ts`): conditionally-present
  sections — Header (source URL, captured date, mode, macrostructure, designer, stack), Tone,
  Colors (a markdown table of hex + a **heuristic-guessed role** — lightest swatch in light mode →
  "surface", darkest → "ink", middle → "accent", rest → "support"/"muted" — this is a computed
  guess from luminance/position, *not* extracted from real CSS unless the next section exists),
  Typography (detected faces + optional type-ramp table), Spacing scale (raw px values + an
  inferred base unit), Border radius, Container width, and — highest-signal when present — a
  fenced ```css :root {...}``` block of the site's **actual** extracted CSS custom properties
  (framework noise like `--tw-*`/`--radix-*` filtered out, capped at 60 entries). The doc's own
  "Notes for the agent" section says explicitly: the CSS-variables block is "higher signal than
  the heuristic guesses" — our mapper follows that same preference order.
- **`find_components(type, style?, industry?, macrostructure?, mode?, vibe?, color?, pageType?,
  device?, limit≤40)`** — real per-component crops for one of 10 types: hero, pricing, features,
  cta, nav, footer, testimonial, logo-cloud, faq, stat. Crop image URL:
  `${INSPO_BASE_URL}/api/component/<slug>/<idx>`. Falls back to the parent page's whole thumbnail
  (`fallback:true`) when no crop region exists yet for that site. **No dedicated "card" or "form"
  type** — the closest real fits are `features` (for Card) and `cta` (for Form, since inline-form-
  as-CTA is a named archetype; there's no first-class Form category in Inspo's taxonomy).
- **Licensing.** Repo is MIT (the code). The root README's only stated obligation ("every screen
  credits and links its source, takedowns honoured at `/dmca`") is Inspo's *own* obligation on its
  own screenshot pages — nothing in the LICENSE, DESIGN.md's own text, or the DMCA page imposes an
  attribution requirement on a downstream caller reusing *extracted numeric/text tokens* (hex
  values, px measurements, font names, CSS variable names) rather than the screenshot or JSX
  itself. DESIGN.md's own instruction to a consumer is design-ethics guidance ("Reference
  material for intentional design decisions: adapt, don't copy"), not a license term. This is not
  legal advice — flagging the actual finding, not a legal conclusion.

## GameForge's existing shapes this design must fit into

Verified directly against current source, 2026-09-20:

- **`ThemeTokens`** (`lib/services/themeTokens.ts`) is deliberately minimal — 8 fields:
  `colorBackground, colorForeground, colorAccent, colorBorder, fontHeading, fontBody, spaceUnit,
  radiusBase`. Every value is validated against a strict allowlist regex (`CSS_COLOR_RE`,
  `CSS_FONT_RE`, `CSS_LENGTH_RE`) before it can become part of a real CSS file GameForge serves —
  this is a hard security boundary (prevents a malicious/malformed extracted value from breaking
  out of a CSS custom-property declaration), not just a style preference. Any Inspo-derived value
  must pass through this exact schema; a value that doesn't validate makes the import fail with a
  clear error, the same as a malformed W3C tokens file does today.
- **The existing "import from an external token source" pattern** (`app/api/styles/import-tokens/
  route.ts` + `lib/services/themeImport/w3cImporter.ts`): a pure `parse<Source>(raw: string):
  {success:true, tokens:ThemeTokens} | {success:false, error:string}` function, called from a
  route that (1) validates login, (2) parses, (3) writes the resulting theme CSS to
  `storage/themes/`, (4) creates a Style Bible (`styleService.create`) with `parameters:
  JSON.stringify(tokens)`, (5) creates a `theme`-kind asset pointing at the written file. This
  spec's Inspo importer follows this exact shape and file-write ordering (write before any DB row,
  so a failed write never leaves an orphaned Style Bible).
- **`ReferenceImagePayload`** (`lib/services/referenceImage.ts`) is just
  `{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }`. The generate route
  (`app/api/generate/route.ts`) already accepts an optional `referenceImage` on the request body,
  saves it to `storage/references/` via `saveReferenceImage()`, and stores only the resulting
  *filename* in the job's options (`referenceImageFilename`) — `worker.ts` later loads it back via
  `loadReferenceImage(filename)` immediately before calling the generator. **This means grounding
  needs no change to the generator at all, and no new code path in the generate route** — it's an
  additive pre-step placed in `worker.ts`, right next to the existing `loadReferenceImage` call,
  that builds a `ReferenceImagePayload` from an Inspo crop exactly as if the user had uploaded one,
  only when no upload is already present. See Feature 2 below for why this lives in `worker.ts`
  rather than the route.

## Feature 1: Seed a Style Bible from Inspo

### UX

A new option alongside the existing "Import from design tokens" panel on the Style Bibles page:
"Import from Inspo". Two ways in:
- **Browse/search**: a query box + filter chips (industry, style, color, mode) sourced from
  `get_filters()`, backed by `search_screens()`. Results: a grid of thumbnails (title, host,
  accent-color swatch).
- **Describe a brief**: a single free-text box that calls `recommend(brief)` and jumps straight to
  its top matches — no manual filtering needed for a quick "something like a warm editorial SaaS
  site" request.

Either path ends at a picked site's slug. Clicking a result calls the preview endpoint, which shows
the *mapped* ThemeTokens (not the raw DESIGN.md) — the actual `colorBackground`/`colorAccent`/etc.
values that would become the new Style Bible, styled as small swatches, plus a per-field provenance
badge (`css-var` / `heuristic` / `default`) so the user sees GameForge's own interpretation, and how
confident it is, before committing (the same "show before you commit" habit Hallmark's own workflow
uses, independent of adopting anything else from Hallmark). If most fields fell back to defaults,
the preview is labeled "low-confidence import" instead of silently looking like a normal one.
Confirm → the *exact tokens shown in the preview* (not a fresh re-fetch/re-map of the slug) are sent
to the commit call, so a site that gets re-captured between preview and confirm can never produce a
Style Bible the user didn't actually see and approve.

### Server design

- **Slug validation, everywhere a slug crosses a trust boundary.** `slug` comes back from an
  unauthenticated third party and is interpolated into both a URL and (for grounding, see Feature
  2) a cache lookup. `lib/services/inspoClient.ts` exports `isValidInspoSlug(s: string): boolean`
  (`^[a-z0-9][a-z0-9-]{0,63}$`) and every function that accepts a slug — client and route — checks
  it before doing anything else. Same for `idx` (a component crop index): must be a non-negative
  integer within `find_components`'s own stated result-count bound before being used to build
  `/api/component/<slug>/<idx>`.
- **`lib/services/inspoClient.ts`** (new): `getDesignMd(slug): Promise<string>` — plain `fetch`
  against `/api/design/<slug>` after slug validation, with an `AbortController` deadline (2s) and
  a short in-memory `Map<slug, {content, fetchedAt}>` cache (10 min TTL) so opening the preview
  panel and clicking the same result twice doesn't spend the shared rate-limit budget twice; being
  in-memory and per-process is fine here since staleness cost is just "an extra live fetch" if the
  worker/dev-server restarts, not correctness.
  For everything else (`search_screens`, `recommend`, `find_components`, `find_by_color`,
  `get_filters`), use the official **`@modelcontextprotocol/sdk`** package's
  `StreamableHTTPClientTransport` + `Client` rather than hand-rolling the JSON-RPC envelope. The
  handshake genuinely is `initialize` → `notifications/initialized` → `tools/call` (2-4 round
  trips, not one POST), the response may arrive as `text/event-stream` rather than plain JSON, and
  a compliant server expects `Accept: application/json, text/event-stream` and an echoed
  `Mcp-Session-Id`/`Mcp-Protocol-Version` — reimplementing that correctly is more code and more
  risk than the one new dependency. Wrap `client.callTool(name, args)` in `callMcpTool<T>(name,
  args, deadlineMs)` with a per-call `AbortController` (separate budgets: 3s for search/recommend
  UI calls, 2s for the grounding-path calls in Feature 2). `INSPO_BASE_URL` env var, default
  `https://inspomcp.dev`, read lazily (matching `PIXELLAB_API_KEY`'s lazy-getter precedent in
  `ImageGenerator.ts` — not a module-level constant, so it's never evaluated before env vars land).
  A circuit breaker across calls is explicitly **not** built for v1 — every caller already has its
  own short deadline and fails soft or returns a foreground error, so a string of failures costs at
  most one timeout per call, not a cascading one; revisit only if that turns out wrong in practice.
- **`lib/services/themeImport/inspoImporter.ts`** (new): `mapDesignMdToTokens(designMd: string,
  slug: string): {success:true, tokens: ThemeTokens, provenance: FieldProvenance, lowConfidence:
  boolean} | {success:false, error:string}`, where `FieldProvenance` records, per `ThemeTokens`
  field, which tier produced it (`'css-var' | 'heuristic' | 'default'`). Parsing preference order,
  matching DESIGN.md's own stated signal quality:
  1. If the ` ```css :root {...}``` ` block is present, attempt to match its property *names*
     against a small lookup table of common conventions (`--bg`/`--background`/`--surface`/
     `--paper` → `colorBackground`, etc.). **This is inherently best-effort, not reliable** — these
     variable names come from each real site's own arbitrary authoring convention, not a shared
     vocabulary, so a confident name match will often not exist even when the block itself is
     present and rich. Real values also frequently won't survive `CSS_COLOR_RE`/`CSS_LENGTH_RE`
     (`color-mix()`, `clamp()`, `var()` chains, `oklch()`) — a rejected value is not an error, it
     just falls through to tier 2 for that field. Treat a name-match as a bonus when it both hits
     *and* validates, not the primary mechanism.
  2. The actual primary, always-available path: the Colors table's heuristic role guesses. This
     must branch on the document's `mode`: in light mode, lightest swatch→`colorBackground`,
     darkest→`colorForeground`; in dark mode, that inverts (darkest→`colorBackground`,
     lightest→`colorForeground`) — DESIGN.md's own `guessRole()` already accounts for `mode`
     internally, so the mapper reads the *role labels* it assigns (surface/ink/accent/support/
     muted), not raw luminance order, avoiding a second, possibly-conflicting inversion. `accent`→
     `colorAccent`. `colorBorder` has no dedicated role: prefer the **lowest-contrast**
     support/muted swatch against the chosen background (not simply "first"), since a border color
     needs to be visually subtle, and a vivid brand-tint swatch in that role would be wrong; if no
     support/muted swatch exists at all, fall back to the default.
  3. Typography: first two detected face names → `fontHeading`/`fontBody`. If only one face is
     detected, reuse it for both fields explicitly (not an unspecified collapse) — note doc order
     is not guaranteed to be heading-then-body order, so this is a best-effort pairing, not a
     guarantee. Falls back to a safe system stack matching this codebase's existing
     `MockComponentGenerator` fallback style if no faces are detected at all.
  4. Spacing: the inferred base unit from the Spacing scale section → `spaceUnit`; the first
     detected Border-radius value → `radiusBase`; both fall back to fixed defaults (`8px`, `4px`)
     if absent.
  5. Every candidate value is validated against `ThemeTokensSchema` before being accepted — a
     value that fails validation is dropped to that field's `'default'`-tier fallback rather than
     failing the whole import, so a partially-rich DESIGN.md still produces a usable Style Bible.
     After all 8 fields are resolved, count how many landed on `'default'`: if more than half
     (>4 of 8), set `lowConfidence: true`. This is the fix for an otherwise-unreachable failure
     mode — every field *always* has a default, so "fail unless every field is unmappable" would
     never actually fire; `lowConfidence` plus the returned `provenance` is what lets the preview
     UI (and the Style Bible's name) honestly represent a mostly-guessed import instead of looking
     identical to a well-extracted one.
  6. **Invariant, enforced at this module's boundary and asserted in its tests: no raw DESIGN.md
     text ever reaches a generation prompt.** Every value that survives step 5 has already passed a
     strict CSS-value allowlist regex — nothing free-text from an untrusted remote document is ever
     forwarded verbatim.
- **`POST /api/inspo/preview`** (new route, requires login): body `{ slug }` — validates the slug,
  calls `getDesignMd` → `mapDesignMdToTokens`, returns `{tokens, provenance, lowConfidence}`. No DB
  writes.
- **`POST /api/styles/import-inspo`** (new route, mirrors `import-tokens/route.ts`, requires
  login): body `{ name: string, slug: string, tokens: ThemeTokens }` — the exact tokens the user
  approved in the preview step, not a slug to re-resolve. Re-validates `tokens` against
  `ThemeTokensSchema` (cheap, and it's the same defense-in-depth every other write path in this
  codebase already applies to client-supplied data), then runs the same write-CSS-then-create-
  Style-Bible-then-create-asset sequence as the W3C importer, with `prompt: `Imported from Inspo:
  ${slug}`` matching the W3C importer's `'Imported from W3C Design Tokens JSON'` convention.
  Stores `parameters.__source = {slug, capturedAt: <now>}` alongside the tokens (mirrors what the
  W3C path already loses today, but worth capturing here since Inspo re-imports and future
  dedupe/update-in-place tooling need to know which Style Bibles came from which slug — no
  dedupe/update UI is built in this pass; re-importing the same slug just creates another Style
  Bible, same as re-importing a W3C file today).
- **`GET /api/inspo/search`** (new route, requires login — same as every other new route here;
  Inspo's `recommend()` forwards the user's free-text `brief` to what's likely an LLM-backed
  endpoint, so this must never be reachable by an unauthenticated caller): thin server-side proxy
  for `search_screens`/`recommend`/`get_filters`, with `brief` length-capped before being
  forwarded. The browser never talks to Inspo directly, keeping the endpoint URL and any future
  auth server-side, consistent with how every other external-API call in this codebase (Pixellab,
  Ollama, Claude) is proxied through GameForge's own API routes. A per-user request quota / token
  bucket in front of the shared 120 rpm budget is deliberately **not** built for v1: GameForge is a
  small, self-hosted, login-gated tool, not a public multi-tenant service with adversarial traffic,
  so the realistic risk is "a busy session gets an occasional 429," which the error-handling table
  below already covers as a normal foreground error. Revisit if GameForge's deployment shape
  changes.

## Feature 2: Reference grounding for component generation

### UX

A new toggle on the Style Bible (stored as a `NOT NULL DEFAULT false` boolean column on `styles`,
`ground_with_inspo`; migration is additive/forward-only, existing rows backfill to `false`): "Use
real-site references when generating components." Off by default. No per-generation UI change
beyond that — when on, generation just quietly tends to produce better-grounded output; when Inspo
doesn't have a good match or is unavailable, generation proceeds exactly as it does today. The
job's own metadata records whether grounding actually happened and why not when it didn't (see
below), so this is inspectable after the fact even though there's no separate UI for it in v1.

### Server design

- **Component-type → Inspo-type mapping** (a small fixed table, not configurable): Button→`cta`,
  Nav Bar→`nav`, Card→`features` (closest real fit — Inspo has no unified card category), Form→
  `cta` (closest real fit — inline-form-as-CTA is a named archetype; no first-class Form type
  exists), Other→ *no mapping, grounding skipped for this type*. This table lives in
  `lib/services/inspoClient.ts` alongside the client itself, documented with the "why" (the actual
  archetype-coverage gap found during research), not silently guessed. The mapping intentionally
  happens *before* the cache lookup/key, not after, so Button and Form — which map to the same
  Inspo type (`cta`) — still get separate cache entries keyed on GameForge's own component type;
  see the cache key below.
- **Color-matched selection**: when grounding fires, call `find_components(type, color:
  <hex derived from the Style Bible's own colorAccent>)` so the returned reference is actually
  palette-relevant to this Style Bible. The `color` parameter's expected format (name vs. hex vs. a
  `get_filters()`-listed key) hasn't been confirmed against the live `tools/list` schema — verify
  before implementing this call; if the server rejects the value, degrade to calling without
  `color` rather than failing the whole grounding attempt.
- **Deterministic result selection.** `find_components` can return multiple matches, some
  `fallback:true` (whole-page thumbnail, not a real crop). Selection rule: first non-fallback
  result; if none, the lowest-index fallback result. Record which was picked
  (`referenceIsFallbackThumbnail: boolean`) in both the cache row and the job metadata, so a
  thumbnail-standing-in-for-a-crop is visible after the fact rather than silently passed off as a
  real component reference.
- **Where grounding actually happens: `worker.ts`, not `app/api/generate/route.ts`.** The route
  only reads the target Style Bible's `ground_with_inspo` column (already loaded, no extra query)
  and stamps `groundWithInspo: boolean` into the job's options alongside the existing
  `referenceImageFilename` handling — a pure in-memory boolean, zero added latency to the
  queue-time request. The actual grounding attempt (cache lookup, possible `find_components` MCP
  call, possible image download) happens in `worker.ts`, in the same place it already calls
  `loadReferenceImage(filename)`, and only runs when (a) the job's `outputKind === 'component'`,
  (b) `groundWithInspo` is true, (c) no user-supplied `referenceImageFilename` is present (a user's
  own upload always wins — grounding only fills a gap), and (d) the component type maps to a real
  Inspo type. On success it builds a `ReferenceImagePayload` exactly as `loadReferenceImage` would
  have from an upload, and the **existing** generator code runs completely unchanged from there.
  This placement means grounding's latency lands on the worker's own per-job processing time (which
  already varies with generation latency) rather than on the user-facing queue-submission request —
  the "never delays the job" language below now means what it says, instead of contradicting a
  route-level implementation that would have added up to several seconds in front of every opted-in
  queue request.
- **Fail-soft, always.** The whole grounding attempt (MCP call + image fetch) is wrapped in a
  single try/catch with separate short deadlines (2s MCP call, 2s image download —  split rather
  than one shared 4s budget, since a slow MCP handshake shouldn't also eat the image fetch's
  budget). Any failure — timeout, 429 rate-limit, network error, no match found, image fetch
  failure, SSRF/validation rejection — is recorded as `{grounded: false, groundedReason: string}`
  in the job's own options/metadata (not just `console.error` — a per-job structured field is
  nearly free to add since the job row already exists and is already being written, and it's what
  actually answers "what fraction of opted-in generations got grounded" after the fact) and the job
  proceeds exactly as it would with `ground_with_inspo` off. Grounding is never a reason a
  generation job fails.
- **SSRF guard on every fetched URL.** Both a fresh `image_url` from `find_components` and a
  cached one are validated before being fetched: scheme must be `http`/`https` and
  `new URL(url).origin === new URL(INSPO_BASE_URL).origin`. A cached row that fails this check is
  deleted (handles the case where a future self-host switch left a stale cross-host URL behind) and
  grounding is treated as a miss for this call.
- **Downloaded crop validation.** Cap response size (~4 MB) and sniff `Content-Type` against an
  allowlist of `image/png`, `image/jpeg`, `image/webp` — matching `ReferenceImagePayload`'s own
  union. Anything outside the cap or allowlist is **rejected**, never coerced, and treated as a
  grounding failure (fail-soft, same as any other failure mode above).
- **Cache**: a new table, `inspo_reference_cache(style_id, component_type, accent_hash, image_url,
  is_fallback, fetched_at)`, `FOREIGN KEY(style_id) REFERENCES styles(id) ON DELETE CASCADE`,
  `UNIQUE(style_id, component_type, accent_hash)` — keyed on GameForge's own component type (fixing
  the Button/Form collision noted above) plus a short hash of the Style Bible's current
  `colorAccent`. Editing a Style Bible's accent changes the hash, so a palette edit naturally misses
  the old cache entry instead of serving a stale color-matched reference for up to 7 days; the old
  row simply ages out via the TTL sweep rather than needing an explicit invalidation step. Before
  calling Inspo, check for a fresh (TTL: 7 days — chosen to cut load on the shared rate limit, not
  because references need to be highly current) cached row matching the key; if present and its
  URL passes the SSRF guard, fetch that image directly (skip `find_components` entirely). Writes
  use an upsert (`INSERT ... ON CONFLICT (style_id, component_type, accent_hash) DO UPDATE`) so two
  concurrent cache-miss generations for the same key resolve atomically at the DB layer without an
  app-level lock. A persisted table (not in-memory) because `worker.ts` and `next dev`'s API routes
  are separate processes in this codebase's own architecture, and the whole point of caching is
  surviving across many generations over days. New migration required; additive/forward-only, same
  as the `ground_with_inspo` column.
- **Screenshot retention.** Downloaded crops are saved via the same `saveReferenceImage()` path a
  user upload already uses, landing in `storage/references/` under GameForge's existing
  `cleanupOrphanedImages()` lifecycle (which already protects in-flight job images and cleans up
  the rest) — no new retention policy needed, this reuses infrastructure that already exists rather
  than inventing a second one for Inspo-sourced images specifically.

## Error handling summary

| Failure | Behavior |
|---|---|
| Inspo down/slow during Style Bible preview or seeding | Route returns `{success:false, error}` with a distinct message per cause (429 rate-limited / 404 unknown slug / 5xx upstream error / timeout) rather than one generic "import failed" — this is a user-initiated, foreground action, so a specific, actionable error is the right response. |
| DESIGN.md maps to an invalid token (fails `ThemeTokensSchema`) | That one field falls back to a safe default; the field is recorded as `'default'`-tier in `provenance`. |
| More than half of the 8 fields fell back to defaults | `lowConfidence: true` is returned; the preview UI and the Style Bible's suggested name both flag it, rather than looking indistinguishable from a well-extracted import. |
| Preview and commit diverge (site re-captured between the two) | Impossible by construction — commit takes the exact tokens the preview returned, not a slug to re-resolve, so there is nothing to re-fetch that could have changed. |
| Inspo down/slow during grounding (worker-side) | Silent skip, job queues and processes without a reference image; `{grounded: false, groundedReason}` recorded on the job. Never blocks queue submission at all — the attempt happens entirely inside the worker's own per-job processing. |
| Crop image fails SSRF/size/content-type validation | Rejected (not coerced), treated as a grounding failure like any other. |
| Component type has no Inspo mapping (Other) | Grounding skipped, no call made at all; `groundedReason: 'unmapped-type'`. |
| User supplied their own reference image | Grounding never runs — an explicit user choice always wins; `groundedReason: 'user-supplied-reference'`. |

## Testing strategy

- `mapDesignMdToTokens`: unit tests with real DESIGN.md fixtures (at least one with a rich
  `:root` CSS block, one with only the heuristic color table, one mostly empty, one in dark
  `mode`) — following this codebase's existing `w3cImporter.test.ts`-style conventions. Includes:
  provenance tiers are reported correctly per field, `lowConfidence` flips at the >4-of-8-defaults
  threshold, dark-mode role inversion produces the opposite background/foreground pick from an
  otherwise-identical light-mode fixture, single-face typography reuses the one face for both
  fields, and an assertion that no raw DESIGN.md prose string ever appears in the returned tokens
  (the untrusted-text invariant, checked mechanically, not just by inspection).
- `inspoClient.ts`: unit tests with a mocked `fetch`/MCP transport for both the REST path
  (`getDesignMd`, including its in-memory TTL cache actually avoiding a second fetch) and the MCP
  path (including a simulated timeout, a simulated 429, and — since upstream drift is otherwise
  only caught by a manual check nobody runs in CI — at least one recorded-fixture "contract" test
  against real captured `tools/list`/`tools/call` responses, with a note to refresh the fixture if
  Inspo's shape changes).
- Slug/idx validation: unit tests for `isValidInspoSlug` covering the traversal/injection shapes
  DeepSeek's review specifically flagged (`../`, encoded slashes, query characters, out-of-range
  `idx`).
- `POST /api/inspo/preview`, `POST /api/styles/import-inspo`, `GET /api/inspo/search`: standard
  route tests, real temp-DB pattern, mirroring `importTokensRoute.test.ts` — including that all
  three reject an unauthenticated request, and that `import-inspo` re-validates a tampered/invalid
  `tokens` body against `ThemeTokensSchema` rather than trusting the client.
- Grounding's insertion point in `worker.ts` (not the generate route): tests asserting (a) a
  user-supplied `referenceImageFilename` is never overridden, (b) an Inspo-sourced
  `ReferenceImagePayload` is built identically to a user-uploaded one from the generator's point of
  view, (c) any Inspo failure still completes the job successfully with no reference image and a
  recorded `groundedReason`, (d) a crop URL failing the SSRF origin check is rejected and the cache
  row deleted, (e) an oversized or wrong-Content-Type download is rejected, not coerced.
- Cache table: service-level tests (real temp SQLite) confirming: a second grounding attempt for
  the same `(styleId, componentType, accentHash)` within the TTL skips `find_components`; changing
  the Style Bible's `colorAccent` produces a different key and misses the old entry; two concurrent
  upserts for the same key don't error or duplicate (the `UNIQUE` + `ON CONFLICT` path actually
  being exercised, not just asserted in prose); deleting a Style Bible cascades to its cache rows.
- Manual verification (required, per this project's UI/external-integration convention): actually
  search/pick/preview/seed a real Style Bible from Inspo's live endpoint, and actually queue a
  grounded component generation (both Button and Form, to confirm they no longer collide on the
  same cache entry), in a real browser — confirming the live endpoint behaves as documented here,
  not just as tested against mocks.

## Open questions / risks worth naming before implementation planning

- **Card/Form mapping quality, and section-level vs. component-level crops.** Neither Card nor Form
  has a clean Inspo equivalent (`features`/`cta` are approximations, and both are section-level
  crops rather than single-component crops — grounding a button with a whole CTA band is a
  plausible bias toward layout over element). Worth revisiting after real usage — if the
  approximation produces obviously wrong references often enough, the fix is likely "skip
  grounding for Card/Form too" rather than a better mapping, since Inspo genuinely doesn't have
  those categories.
- **`find_components`'s `color` parameter format is unverified.** Confirm against the live
  `tools/list` schema (or `get_filters()` output) before implementing the color-matched call —
  name vs. hex vs. filter-key are all plausible. The spec already states the degrade path (drop
  `color`, don't fail) if the assumed format is rejected.
- **Screenshot-crop licensing is a distinct question from token-value licensing, and is still
  open.** The Background section's licensing analysis covers Feature 1 (reusing extracted hex/font/
  spacing values has no stated attribution obligation on a downstream caller). It does **not**
  cover Feature 2: downloading and persisting someone else's site screenshot crop as a generation
  reference is a materially different use. This needs an explicit answer before Feature 2 ships,
  independent of Feature 1 — Feature 1 can ship on its own licensing footing regardless of how this
  resolves.
- **Shared rate limit.** 120 req/min is shared across everyone hitting the public hosted endpoint,
  not just GameForge. The DESIGN.md and reference caches both cut GameForge's own repeat-call
  volume, but a busy period could still hit 429s during search/seeding (foreground, user sees a
  distinct rate-limited error per the error table above) or grounding (background, silently skips
  with `groundedReason: 'rate-limited'`). A per-user quota in front of the shared budget was
  considered and deliberately deferred (see Feature 1's search route notes) since GameForge's
  actual deployment shape is small and self-hosted, not adversarial multi-tenant traffic;
  self-hosting Inspo remains the documented escape hatch if this changes (non-goal, above).
- **Color-role mapping accuracy.** Since the reliable path is DESIGN.md's own *heuristic* role
  guessing (lightest swatch → surface, darkest → ink, etc. — a luminance/position guess, not
  ground truth), a seeded Style Bible's colors will sometimes be wrong in ways a human glancing at
  the real site would immediately catch (e.g. a site whose actual "ink" color isn't the single
  darkest swatch on the page). This is why the design's "preview the mapped tokens before
  confirming" step matters — it's the actual correction point, not a nicety, and why `provenance`/
  `lowConfidence` are surfaced there rather than only logged.
- **No reimport/dedupe UI.** Re-importing the same slug creates a new Style Bible rather than
  updating an existing one, even though `parameters.__source.slug` now records enough to detect
  that case. Accepted as v1 behavior (matches how re-importing a W3C tokens file already works
  today) — an "update existing" flow is a reasonable follow-up once real usage shows it's wanted,
  not a blocker for this spec.
- **Phasing.** The two features are independent by design — the implementation plan can
  reasonably build and ship Feature 1 (seeding) completely before starting Feature 2 (grounding),
  or vice versa, rather than needing both finished before either is usable.
- **`get_filters()` facet staleness.** The search UI's filter chips are a live call, not baked in —
  fine for now; noting there's no local cache of the archive's own taxonomy, so that call is on the
  hot path of opening the search panel (acceptable latency for a foreground, one-time-per-session
  UI action, unlike grounding's per-generation concern), and it should carry the same short
  timeout/deadline discipline as the other MCP calls rather than being exempt from it.
- **`INSPO_BASE_URL` changes (a future self-host switch) leave stale cache rows.** Both the
  in-memory DESIGN.md cache (process-lifetime only, so a restart already clears it) and the
  persisted `inspo_reference_cache` table would hold URLs from the old host. Since self-hosting is
  explicitly a non-goal for this pass, the accepted v1 behavior is: switching `INSPO_BASE_URL` is
  an operational action that includes manually clearing `inspo_reference_cache`, documented as a
  one-line runbook note rather than built into the schema now.
