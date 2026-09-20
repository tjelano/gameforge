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
  `POST https://inspomcp.dev/api/mcp`. Still just a server-to-server HTTP POST with a JSON
  body — no agentic session, no MCP SDK strictly required — but the caller has to construct the
  JSON-RPC envelope itself (`{jsonrpc:"2.0", id, method:"tools/call", params:{name, arguments}}`)
  and handle the `tools/list`/`initialize` handshake.
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
  needs no change to `worker.ts` or the generator at all** — it only needs the generate route to
  build a `ReferenceImagePayload` from an Inspo crop, exactly as if the user had uploaded one,
  before the existing `saveReferenceImage`/job-options logic runs.

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

Either path ends at a picked site's slug. Clicking a result shows a preview: the *mapped*
ThemeTokens (not the raw DESIGN.md) — the actual `colorBackground`/`colorAccent`/etc. values that
would become the new Style Bible, styled as small swatches, so the user sees GameForge's own
interpretation before committing (the same "show before you commit" habit Hallmark's own workflow
uses, independent of adopting anything else from Hallmark). Confirm → creates the Style Bible.

### Server design

- **`lib/services/inspoClient.ts`** (new): `getDesignMd(slug: string): Promise<string>` (plain
  `fetch` against `/api/design/<slug>`) and `callMcpTool<T>(name: string, args: object): Promise<T>`
  (hand-rolled JSON-RPC POST to `/api/mcp`, used by both features). `INSPO_BASE_URL` env var,
  default `https://inspomcp.dev`, read lazily (matching `PIXELLAB_API_KEY`'s lazy-getter
  precedent in `ImageGenerator.ts` — not a module-level constant, so it's never evaluated before
  env vars land).
- **`lib/services/themeImport/inspoImporter.ts`** (new): `mapDesignMdToTokens(designMd: string):
  {success:true, tokens: ThemeTokens} | {success:false, error:string}`. Parsing preference order,
  matching DESIGN.md's own stated signal quality:
  1. If the ` ```css :root {...}``` ` block is present, attempt to match its property *names*
     against a small lookup table of common conventions (`--bg`/`--background`/`--surface`/
     `--paper` → `colorBackground`, etc.). **This is inherently best-effort, not reliable** — these
     variable names come from each real site's own arbitrary authoring convention, not a shared
     vocabulary, so a confident name match will often not exist even when the block itself is
     present and rich. Treat a name-match as a bonus when it hits, not the primary mechanism.
  2. The actual primary, always-available path: the Colors table's heuristic role guesses
     (surface→`colorBackground`, ink→`colorForeground`, accent→`colorAccent`, first support/muted
     swatch→`colorBorder`) — DESIGN.md computes these for every site regardless of whether raw CSS
     vars were extracted, so this is the mapping GameForge should expect to lean on most of the
     time, with step 1 as an opportunistic upgrade when it happens to match.
  3. Typography: first two detected face names → `fontHeading`/`fontBody` (falls back to a safe
     system stack matching this codebase's existing `MockComponentGenerator` fallback style if
     none detected).
  4. Spacing: the inferred base unit from the Spacing scale section → `spaceUnit`; the first
     detected Border-radius value → `radiusBase`; both fall back to fixed defaults (`8px`, `4px`)
     if absent.
  5. Every candidate value is validated against `ThemeTokensSchema` before being accepted — a
     value that fails validation (e.g. an extracted font name containing characters
     `CSS_FONT_RE` rejects) is dropped to that field's fallback rather than failing the whole
     import, so a partially-rich DESIGN.md still produces a usable Style Bible.
- **`POST /api/styles/import-inspo`** (new route, mirrors `import-tokens/route.ts`): body
  `{ name: string, slug: string }`. Calls `inspoClient.getDesignMd(slug)` → `mapDesignMdToTokens`
  → on success, same write-CSS-then-create-Style-Bible-then-create-asset sequence as the W3C
  importer, with `prompt: `Imported from Inspo: ${slug}`` matching the W3C importer's
  `'Imported from W3C Design Tokens JSON'` convention.
- **`GET /api/inspo/search`** (new route): thin server-side proxy for `search_screens`/`recommend`/
  `get_filters` — the browser never talks to Inspo directly, keeping the endpoint URL and any
  future auth server-side, consistent with how every other external-API call in this codebase
  (Pixellab, Ollama, Claude) is proxied through GameForge's own API routes rather than called from
  the client.

## Feature 2: Reference grounding for component generation

### UX

A new toggle on the Style Bible (stored as a boolean on the `styles` row, e.g.
`ground_with_inspo`): "Use real-site references when generating components." Off by default. No
per-generation UI change beyond that — when on, generation just quietly tends to produce better-
grounded output; when Inspo doesn't have a good match or is unavailable, generation proceeds
exactly as it does today.

### Server design

- **Component-type → Inspo-type mapping** (a small fixed table, not configurable): Button→`cta`,
  Nav Bar→`nav`, Card→`features` (closest real fit — Inspo has no unified card category), Form→
  `cta` (closest real fit — inline-form-as-CTA is a named archetype; no first-class Form type
  exists), Other→ *no mapping, grounding skipped for this type*. This table lives in
  `lib/services/inspoClient.ts` alongside the client itself, documented with the "why" (the actual
  archetype-coverage gap found during research), not silently guessed.
- **Color-matched selection**: when grounding fires, call `find_components(type, color:
  <hex derived from the Style Bible's own colorAccent>)` so the returned reference is actually
  palette-relevant to this Style Bible, not an arbitrary one.
- **Where grounding actually happens**: in `app/api/generate/route.ts`, when (a) the job's
  `outputKind === 'component'`, (b) the target Style Bible has `ground_with_inspo` set, (c) the
  request did **not** already carry a user-supplied `referenceImage` (a user's own upload always
  wins — grounding only fills a gap, never overrides an explicit choice), and (d) the component
  type maps to a real Inspo type: fetch the crop image bytes server-side, base64-encode, build a
  `ReferenceImagePayload` exactly as if the user had uploaded it, and let the **existing**
  `saveReferenceImage`/job-options/`worker.ts`/generator code run completely unchanged from there.
  No new code path in the generation pipeline itself — grounding is entirely a queue-time
  "populate `input.referenceImage` before the existing logic runs" concern.
- **Fail-soft, always.** The whole grounding attempt (MCP call + image fetch) is wrapped in a
  single try/catch with a short timeout (proposed: 4 seconds — generous for a same-datacenter-tier
  API call, short enough that a hung request doesn't meaningfully delay queuing a job). Any
  failure — timeout, 429 rate-limit, network error, no match found, image fetch failure — logs
  once (`console.error`, matching this codebase's existing fire-and-forget error-logging
  convention for non-critical paths) and the job queues exactly as it would with `ground_with_inspo`
  off. Grounding is never a reason a generation job fails.
- **Cache**: a new small table, `inspo_reference_cache(style_id, component_type, image_url,
  fetched_at)`, unique on `(style_id, component_type)`. Before calling Inspo, check for a fresh
  (proposed TTL: 7 days — a Style Bible's palette rarely changes, and this cache exists to reduce
  load on the shared community rate limit, not to track something highly time-sensitive) cached
  `image_url`; if present, fetch that image directly (skip the `find_components` MCP call
  entirely) rather than re-querying on every single generation of the same type for the same
  style. A persisted table (not in-memory) because `worker.ts` and `next dev`'s API routes are
  separate processes/restarts in this codebase's own architecture, and the whole point of caching
  is surviving across many generations over days — an in-memory cache would reset on every worker
  restart and defeat that purpose. New migration required.

## Error handling summary

| Failure | Behavior |
|---|---|
| Inspo down/slow during Style Bible seeding | Route returns a clear `{success:false, error}` — this is a user-initiated, foreground action; a real error is the right response, same as a malformed W3C tokens file today. |
| DESIGN.md maps to an invalid token (fails `ThemeTokensSchema`) | That one field falls back to a safe default; import still succeeds unless *every* field is unmappable. |
| Inspo down/slow during grounding | Silent skip, job queues without a reference image, logged server-side only. Never fails or delays the job beyond the timeout. |
| Component type has no Inspo mapping (Other) | Grounding skipped, no call made at all. |
| User supplied their own reference image | Grounding never runs — an explicit user choice always wins. |

## Testing strategy

- `mapDesignMdToTokens`: unit tests with real DESIGN.md fixtures (at least one with a rich
  `:root` CSS block, one with only the heuristic color table, one mostly empty) — following this
  codebase's existing `w3cImporter.test.ts`-style conventions.
- `inspoClient.ts`: unit tests with a mocked `fetch` (both the REST and JSON-RPC paths, including
  a simulated timeout/429).
- `POST /api/styles/import-inspo`, `GET /api/inspo/search`: standard route tests, real temp-DB
  pattern, mirroring `importTokensRoute.test.ts`.
- Grounding's insertion point in `app/api/generate/route.ts`: tests asserting (a) a user-supplied
  `referenceImage` is never overridden, (b) an Inspo-sourced one is built identically to a
  user-uploaded one from the job's/worker's point of view, (c) any Inspo failure still queues the
  job successfully with no reference image.
- Cache table: a service-level test (real temp SQLite) confirming a second grounding attempt for
  the same `(styleId, componentType)` within the TTL doesn't call `find_components` again.
- Manual verification (required, per this project's UI/external-integration convention): actually
  search/pick/seed a real Style Bible from Inspo's live endpoint, and actually queue a grounded
  component generation, in a real browser — confirming the live endpoint behaves as documented
  here, not just as tested against mocks.

## Open questions / risks worth naming before implementation planning

- **Card/Form mapping quality.** Neither has a clean Inspo equivalent (`features`/`cta` are
  approximations). Worth revisiting after real usage — if the approximation produces obviously
  wrong references often enough, the fix is likely "skip grounding for Card/Form too" rather than
  a better mapping, since Inspo genuinely doesn't have those categories.
- **Shared rate limit.** 120 req/min is shared across everyone hitting the public hosted endpoint,
  not just GameForge. The cache mitigates GameForge's own repeat-call volume, but a busy period
  could still hit 429s during search/seeding (foreground, user sees an error) or grounding
  (background, silently skips). Self-hosting Inspo is the documented escape hatch if this becomes
  a real problem, deliberately not built now (non-goal, above).
- **Color-role mapping accuracy.** Since the reliable path is DESIGN.md's own *heuristic* role
  guessing (lightest swatch → surface, darkest → ink, etc. — a luminance/position guess, not
  ground truth), a seeded Style Bible's colors will sometimes be wrong in ways a human glancing at
  the real site would immediately catch (e.g. a site whose actual "ink" color isn't the single
  darkest swatch on the page). This is why the design's "preview the mapped tokens before
  confirming" step matters — it's the actual correction point, not a nicety.
- **Phasing.** The two features are independent by design — the implementation plan can
  reasonably build and ship Feature 1 (seeding) completely before starting Feature 2 (grounding),
  or vice versa, rather than needing both finished before either is usable.
- **`get_filters()` facet staleness.** The search UI's filter chips are a live call, not baked in —
  fine for now, just noting there's no local cache of the archive's own taxonomy, so that call is
  on the hot path of opening the search panel (acceptable latency for a foreground, one-time-per-
  session UI action, unlike grounding's per-generation concern).
