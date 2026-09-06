# Dedup-Steering + Multi-Candidate Generation — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge's theme generation (Seed Theme Library, Export Formats, Contrast Checking — all
shipped) produces one theme per generation request with no awareness of what already exists.
This is the fourth of a 6-item backlog for the theme feature; the last two (live tweaking in
the review UI, full component generation) are separate, later initiatives and out of scope
here. With 58 real seed themes and growing AI-generated ones already in the dashboard, "avoid
remaking the same thing" (the user's own framing) is now a genuinely live concern, not a
hypothetical one.

The core idea, confirmed during brainstorming: **dedup-steering is the actual goal;
multi-candidate generation is the mechanism that makes it practical.** One generation request
produces several candidates; each gets checked for how close it is to what already exists, and
near-duplicates are flagged (not silently discarded) rather than presented as if they were
fresh options.

## Decisions made during brainstorming

- **Relationship:** dedup is the goal, multi-candidate generation is the mechanism — not two
  independent features shipped separately.
- **Similarity metric:** perceptual distance in OKLab color space, not raw RGB distance. RGB
  distance is well known to correlate poorly with how similar colors actually look; OKLab is
  specifically designed so Euclidean distance in that space tracks perceived difference.
- **Similarity scope:** colors only (`colorBackground`/`colorForeground`/`colorAccent`/
  `colorBorder`) — fonts are excluded. Two themes with an identical palette but different
  fonts already read as meaningfully different; adding font comparison was judged unnecessary
  complexity for this feature.
- **Candidate count:** user-selectable per generation (a 1/3/5 selector on the generation
  form), defaulting to 3 — not a fixed system-wide number.
- **Upfront steering:** yes. The generation prompt includes a short list of the Style Bible's
  own existing theme colors ("avoid palettes close to: ...") so the model attempts to produce
  something different from the start. This is a best-effort nudge, not a guarantee — real
  avoidance is enforced by the review-time check below, not the prompt.
- **Comparison scope:** a candidate is compared against other themes from the **same Style
  Bible only**, not the whole dashboard. A Style Bible already represents one shared
  aesthetic (an established rule from this codebase), so its own theme history is the
  meaningful, and most likely, source of real near-duplicates; comparing across unrelated
  aesthetics (e.g. a cyberpunk-neon Style Bible's themes against a pastel-bakery one's) isn't
  meaningful and would bloat the comparison set for no benefit.
- **Display behavior:** show every candidate, badge the too-similar ones with what they're
  close to — nothing gets silently filtered or hidden. This matches the established,
  already-shipped Contrast Checking pattern (purely informational, user decides). It also
  reflects a real cost fact surfaced during brainstorming: every candidate in a batch has
  already been generated (and paid for) by the time any similarity check runs, so filtering
  vs. badging doesn't change what was spent — only what the user gets to see and decide on.

## Real gaps found during self-audit (before this spec was written) — now part of the design

Three real architectural issues were found and are addressed directly in this spec, not
glossed over:

1. **Sibling candidates in the same batch don't know about each other during generation.**
   Upfront steering can only reference *already-promoted* assets — it cannot know about the
   other N-1 candidates being generated in the same batch, since none of them exist yet when
   generation starts (and jobs are not guaranteed to run in a way that lets job 2 see job 1's
   output). This means 3 candidates from one batch could all come back near-identical to each
   other and still show zero badges if the check only looks at previously-promoted assets.
   **Fix:** the review-time similarity check compares a candidate against BOTH the Style
   Bible's existing promoted theme assets AND its own batch-siblings. Steering (best-effort,
   upfront) only ever knows about promoted assets; the informational badge (after the fact,
   real data) checks both.
2. **This needs an actual schema change, not just computed-on-demand logic.** Every dedup
   decision this feature has shipped so far (contrast, export) computed derived values on
   demand from data that already existed. "Which jobs came from the same generation request"
   is different — it is new information that doesn't exist in the data today and can't be
   reliably inferred (matching `style_id`/`prompt`/timestamp is fragile: two genuinely separate
   requests with an identical prompt submitted close together would be wrongly merged). This
   spec adds a new, small, honest column for it rather than a heuristic workaround.
3. **The OKLab math needed here is not just "run the existing function backward."** The Seed
   Theme Library feature verified and shipped `oklab_to_linear_srgb` (OKLab → sRGB). This
   feature needs the reverse direction, `linear_srgb_to_oklab` (sRGB → OKLab) — a different,
   separate set of matrix coefficients (the actual matrix inverse), not derivable by casually
   "reversing" the existing function. This must be independently fetched and verified from the
   same primary source (Björn Ottosson's own page, which publishes both directions) during
   plan-writing — not hand-derived, not approximated.

## Out of scope for this feature

- **No font or spacing/radius similarity** — colors only, per the decision above.
- **No cross-Style-Bible comparison** — scoped to the same Style Bible only.
- **No blocking of promotion** — a too-similar candidate can still be promoted; this is
  informational, matching the established Contrast Checking pattern.
- **No automatic retry when all candidates are flagged as too similar** — every candidate a
  batch produces is shown; there is no silent re-generation loop that would spend additional,
  un-requested API cost. If a user wants different results, they submit a new generation
  request themselves.
- **No live/streaming candidate delivery** — candidates arrive through the existing job queue
  and polling mechanism exactly as single generations do today; this feature doesn't change
  how results are delivered, only how many get requested at once and how they're compared.

## Data model

**One real schema change, kept as small as possible:** a new nullable `batch_id` column on
`jobs` (a UUID, generated once per generation request and shared by all N jobs it creates;
`NULL` for the existing single-generation path and for non-theme jobs, so this is fully
backward compatible with everything that already exists). `assets` does not need this column —
once a job is promoted, it becomes an ordinary promoted theme asset for its Style Bible, and
future generations compare against it the same way they compare against any other promoted
asset of that style; the batch grouping only matters while candidates are still sitting in the
review queue as jobs.

No other schema changes. Everything else (the similarity score, which candidates get badged)
is computed on demand at review time, never persisted — consistent with how Export Formats and
Contrast Checking already work in this codebase.

## Component design

**A new OKLab conversion function**, the verified reverse of the existing OKLCh→sRGB pipeline:
`hexToOklab(hex: string): { L: number; a: number; b: number }` — converts a hex color into its
OKLab coordinates via gamma-decoding (already verified and shipped in the Contrast Checking
feature's `linearizeChannel`), then the real, independently-verified `linear_srgb_to_oklab`
matrix (to be fetched from Ottosson's page during plan-writing, not invented here).

**A theme-distance function**: `getThemeDistance(tokensA: ThemeTokens, tokensB: ThemeTokens):
number` — converts each of the four compared color fields
(`colorBackground`/`colorForeground`/`colorAccent`/`colorBorder`) to OKLab via `hexToOklab`,
computes the Euclidean distance for each field, and averages the four into one theme-level
distance score. Lower means more similar.

**The exact "too similar" threshold is not decided here.** It needs real empirical calibration
against the 58 real seed themes' actual pairwise distances during plan-writing (to understand
what "distinct by design" themes typically measure as, and set a cutoff meaningfully below
that) — the same discipline already applied to the WCAG threshold research, adapted for a
metric with no external published standard to look up.

**Generation flow**: the existing `/api/generate` route (or an equivalent point in the
generation flow — confirmed during plan-writing) accepts a candidate count (1, 3, or 5,
default 3). For count > 1, a single `batch_id` is generated once and shared across all N job
rows created for that request. Each job's prompt includes a short, capped list of the Style
Bible's existing promoted theme colors (steering context) — exactly how many entries this list
caps at is an implementation detail decided during plan-writing, not a user-facing decision.

**Review flow**: on the Jobs review page, each completed theme job's similarity badge is
computed on demand (mirroring Contrast Checking's pattern) by comparing its tokens against (a)
the Style Bible's existing promoted theme assets and (b) any other completed jobs sharing the
same `batch_id`. If the distance to any of those is below the calibrated threshold, the badge
names what it's too close to (e.g. "similar to Bootswatch: Flatly" or "similar to another
candidate in this batch").

## Error handling

Per-job generation failures behave exactly as they already do today — this feature doesn't
change per-job success/failure handling, only how many jobs one request creates and what
additional context their prompts include. The similarity check itself is purely informational:
if it can't compute for any reason (e.g. a malformed existing theme's CSS fails to parse), it
fails silently — no badge shown, nothing blocks review or promotion, matching the same
degrade-quietly pattern already established by Contrast Checking.

## Testing

- `hexToOklab` gets direct unit tests against algebraically-checkable reference points (e.g.
  pure gray values, where OKLab's `a`/`b` should both be exactly 0 regardless of lightness —
  an achromatic color has no color-opponent signal) and a real round-trip test against the
  already-shipped `oklchToHex`/OKLCh pipeline (convert a real color to OKLab and back, expect
  to recover the original within a small tolerance).
- `getThemeDistance` gets tests using real theme data (e.g. two genuinely different seed
  themes should show a large distance; a theme compared against itself should show exactly 0).
- The batch-grouping logic gets a real-DB test proving N jobs from one request share a
  `batch_id`, and that a normal single-generation request still gets `batch_id = NULL` with no
  behavior change from today.
- The review-time similarity check gets tests for both comparison paths (against a promoted
  asset of the same style, and against a batch-sibling job), and confirms a candidate from a
  DIFFERENT style's history never gets flagged.

## Security note

No new external network calls or trust boundaries — this feature only adds a new field to an
existing outbound Claude API prompt (built from already-validated `ThemeTokens` data, same as
every other prompt this codebase already sends) and one new nullable database column populated
server-side, never from raw user input.
