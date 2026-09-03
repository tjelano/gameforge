# UI Sheets — design spec

**Date:** 2026-09-03
**Status:** Approved. Self-review pass and a final audit against the live
codebase both done — see inline "Caught during self-review" /
"Confirmed against the live code" notes throughout. Ready for
implementation.

## Motivation

Pixellab's own web UI supports composing a layout of named UI pieces (buttons,
panels, health bars, etc.), generating one composite image from that layout,
then splitting the composite into individually usable elements. GameForge
integrates with Pixellab for single-sprite generation already; this spec adds
the equivalent multi-element workflow, scoped to what GameForge actually needs
(no attempt to fully replicate Pixellab's own editor).

Discovered via direct inspection of Pixellab's live OpenAPI spec (not assumed
from their web UI alone): `POST /v2/create-ui-asset` accepts a `pieces` array
of typed, positioned shapes and returns one composite image — it does **not**
return per-piece cropped images or echo back positions. The "split into
elements" step is Pixellab's own frontend cropping client-side, seeded by the
same coordinates it already sent. GameForge can do the same: since GameForge
is the one submitting the piece layout, it already has everything needed to
seed the split step without any image analysis or second API call.

## Out of scope for V1 (explicit, not accidental)

- No automatic image-region detection / computer vision. Split boxes are
  seeded from the coordinates the user placed, nothing more.
- No per-state image generation. States are name-only metadata.
- 9-slice margins are stored but used nowhere yet — not in Export, not in
  rendering. Pure metadata, ready for a future export-time consumer.
- No duplicate protection if a job is split more than once — re-splitting
  just creates new asset rows. Cheap to clean up manually; not worth tracking
  state for in V1.
- No server-side image cropping (considered and rejected — see "Approaches
  considered" below).

## Data model

**Jobs: no schema change.** A UI-sheet job is a normal job row. Its `options`
JSON (existing column) carries the submitted `pieces` array, `color_palette`,
and any other `/create-ui-asset` parameters. `asset_type` stays a free-text
*display* label (e.g. `"ui_sheet"` is a fine value to show in the Jobs list),
but it is **never** used to select which generator code path runs — that
decision is made structurally, by checking whether `options.pieces` is a
non-empty array. This avoids the earlier draft's flaw: `asset_type` is
unvalidated free text, and matching a magic string against it would silently
misroute any job whose type happened to collide.

**No new job status.** An earlier draft proposed a `split` status; rejected
during self-audit — SQLite's `CHECK` constraint on `jobs.status` is fixed at
table-creation time, so widening it requires a full table rebuild (new table,
copy rows, drop, rename), not a plain `ALTER TABLE`. Not worth it for a
derived fact. "Has this sheet been split" is just: does any row in `assets`
exist with `source_job_id` equal to this job's id.

**Migration 006 — three new nullable/defaulted columns on `assets`:**

```sql
ALTER TABLE assets ADD COLUMN source_job_id TEXT REFERENCES jobs(id);
ALTER TABLE assets ADD COLUMN nine_slice_margins TEXT;
ALTER TABLE assets ADD COLUMN states TEXT NOT NULL DEFAULT '[]';

CREATE INDEX idx_assets_source_job_id ON assets(source_job_id);
```

- `source_job_id`: which sheet job (if any) this element was cropped from.
  Null for normal single-generation assets. `foreign_keys = ON` is already
  set on the connection, so deleting a sheet job while split children still
  reference it will correctly fail closed rather than silently orphaning
  the reference — this is the desired default, not a workaround needed.
- `nine_slice_margins`: `null`, or a JSON object
  `{ "top": number, "right": number, "bottom": number, "left": number }`.
  Validate shape with a dedicated Zod schema when read/written in
  `AssetService` (Hard Rule 3) — don't treat it as an opaque string past the
  DB layer.
- `states`: JSON array of state-name strings, e.g. `["hover", "pressed"]`.
  Defaults to `[]`, never null (simpler consumption — callers never need a
  null-check before iterating).

`schema.ts`'s `AssetSchema` gains all three fields; add a small
`NineSliceMarginsSchema` (`z.object({ top, right, bottom, left }).nullable()`)
and reuse it in both `AssetService` and any route that writes these fields.

**Checked against the live code:** `AssetService.update()` currently
hardcodes its `UPDATE` statement to exactly `prompt` and `asset_type` — the
SQL itself, not just the TypeScript parameter type, needs extending for the
two new editable fields, same for `UpdateAssetSchema` in the
`PUT /api/assets/[id]` route.

## Pixellab integration

New method on `PixellabGenerator`: `generateUiAsset(pieces, description,
imageSize, colorPalette?)`.

**Output size is a fixed preset list, not a free-range picker.** The raw
OpenAPI schema states a 192-688px min/max per axis, but Pixellab's own UI
(confirmed via screenshot) only actually exposes 10 discrete presets:

| Size | Aspect | Size | Aspect |
|---|---|---|---|
| 256x256 | square | 592x448 | 4:3 landscape |
| 296x224 | 4:3 landscape | 448x592 | 3:4 portrait |
| 224x296 | 3:4 portrait | 688x384 | 16:9 landscape |
| 344x192 | 16:9 landscape | 384x688 | 9:16 portrait |
| 192x344 | 9:16 portrait | 512x512 | square |

GameForge's canvas should offer this exact list as a dropdown rather than
free-form width/height inputs — fewer odd resolutions no one's actually
tested. It also simplifies the coordinate-space conversion mentioned above:
since the piece coordinate space's long axis is always exactly 512, and each
preset's long side is known ahead of time, the scale factor between the
canvas and Pixellab's coordinate space for any selected preset is just
`presetLongSide / 512` — a single known ratio per option, not a general
aspect-ratio calculation done at request time.

1. `POST /v2/create-ui-asset` with `{ description, image_size, pieces,
   color_palette, no_background: true }`. Response is `202` with
   `{ background_job_id, ui_asset_id, status }` — this endpoint is
   asynchronous, unlike the single-sprite `pixflux` endpoint.
2. Poll `GET /v2/ui-assets/{ui_asset_id}` on an interval until `status` is
   `"completed"` or `"failed"` (reasonable poll interval — 2-3s — and an
   overall timeout; Pixellab's own docs put typical multi-piece generation
   in the 10-90s range, size the timeout well above that, e.g. 3 minutes).
3. On completion, `image_url` is a public CDN URL — download it and write the
   bytes to `storage/images/`, same as every other generator.
4. On failure or timeout, throw — this surfaces through the existing
   worker.ts `catch` block exactly like any other generation failure, no new
   error-handling path needed.

The `ImageGenerator` interface itself does not change — this is all internal
to one `generate()`-shaped async call, just one that happens to make several
HTTP round-trips before resolving instead of one.

`worker.ts`'s `processJob()` branches once, right after parsing `options`:
if `options.pieces` is a non-empty array, call `generateUiAsset(...)`;
otherwise call the existing `generate()`.

## Placement canvas (`/dashboard/ui-sheets`, new nav item)

A new page, not a mode on the existing Generate page — different enough
workflow (canvas editor vs. a form) that combining them would complicate both.

- **Style Bible picker** — the existing Generate page has this inlined as a
  plain `<select>`, not a shared component. Extract it into one now
  (`<StyleBiblePicker>` or similar) and use it on both pages — matches the
  precedent already set by `useStyles` itself, pulled out once a second
  consumer showed up.
- **Description field maps to `job.prompt`** (required, non-empty, same as
  every other job) — the sheet's overall description, e.g. "medieval fantasy
  RPG UI kit." This is distinct from each piece's own `label`
  (`options.pieces[].label`, e.g. "Inventory") — one overall description,
  many individually-named pieces. An optional color-palette text field sits
  alongside it (Pixellab's `color_palette` param, e.g. "brown and gold").
- **Piece palette** — one-click presets matching Pixellab's own: Button,
  Icon button, Toolbar, Tab, Panel, Window, Health bar, Avatar, Triangle,
  Pentagon, Hexagon, Octagon. Each preset is a convenience that inserts a
  preconfigured piece of one of the three *real* API shape kinds
  (`rounded_rect`, `circle`, `polygon` with `sides`/`phase` for the
  triangle/pentagon/hexagon/octagon presets) at a sensible default size —
  the UI vocabulary is richer than the API's, and that's fine, it's just a
  friendlier way to pick a starting shape/size.
- **Canvas interactions** — drag to move, drag a corner handle to resize,
  per-piece label text (shown live on the piece, mirrors Pixellab's own
  layout screenshots). No new dependency needed — plain pointer event
  handlers are enough for a handful of draggable/resizable boxes.
- **Coordinate system** — pieces are submitted in Pixellab's virtual
  coordinate space (longer side spans 0-512, shorter side scales to the
  chosen output aspect ratio) — the canvas needs to convert between on-screen
  pixel coordinates and that space when building the request payload, and
  convert back the other way when seeding the split editor's boxes from a
  completed job's `options.pieces` against the actual downloaded image's
  pixel dimensions.
- **Guardrails** — cap total pieces per sheet (20 is a reasonable starting
  limit — the API's own practical ceiling isn't published, so this is a
  UX-side safety net, not a mirror of a documented server limit; adjust once
  real usage shows whether it's too tight or too loose). Warn (don't block)
  when one piece's box is more than 50% covered by another's — cheap
  client-side rectangle-overlap check, surfaced as an inline warning, not a
  submit blocker.
- Submitting creates a job exactly like `POST /api/generate` does today, with
  `options: { pieces, colorPalette }` and `assetType: 'ui_sheet'` (display
  label only, per the data-model section above).

## Split editor

Reachable via a "Split into elements" action on any completed job whose
`options.pieces` is non-empty (parallel to Promote/Discard/Retry, shown
alongside them on the Jobs page).

- Renders the job's composite image (`result_path`) with each submitted
  piece drawn as an initial crop box, converted from the piece coordinate
  space to the image's actual pixel dimensions.
- Per box: drag to move, drag a corner to resize, an X to remove it from the
  split (does not affect the composite — just excludes that piece from this
  split pass).
- **Add-box tool** — beyond adjusting the seeded boxes, the user can draw an
  entirely new box and label it. Covers the case where the generation
  includes something not in the original layout (a flourish, an extra
  decorative element) that's still worth keeping as its own element.
- "Split into N elements" crops each remaining box client-side (Canvas 2D
  `drawImage` with a source rect, then `toBlob()`), and uploads each
  resulting PNG to a new route, `POST /api/assets/from-crop` — body carries
  the image data, the label (becomes the asset's `prompt`), the style id
  (inherited from the source job), and the source job id. Each upload creates
  one normal `assets` row with `source_job_id` set. No new asset-creation
  concept beyond the existing `AssetService.create()` plus the new column.
- **Caught during self-review:** Pixellab's own piece schema defaults
  `label` to `""` (optional), but `AssetSchema.prompt` requires
  `min(1)` — an unlabeled piece would fail asset creation right at the
  moment of splitting. Fix: the "Split into N elements" button stays
  disabled while any included box has an empty label, with an inline
  "name this piece" prompt on the offending box rather than a failed
  request after the fact.
- Re-opening Split on an already-split job is allowed and unguarded — see
  "Out of scope" above. It just creates more assets; nothing prevents or
  warns about re-splitting the same piece twice.
- **Confirmed against the live code, not just designed on paper:** because a
  sheet job stays at `status: 'complete'` forever (no new status), the
  existing `cleanupOrphanedImages()` already protects the composite
  indefinitely with zero changes, and the existing 5-minute active-job
  window already makes an old, already-split job quietly stop showing up in
  the Jobs "needs a decision" view — no new hide-if-split logic needed
  anywhere. "Promote to Asset" also stays available on a sheet job
  unchanged, alongside "Split into elements" — promoting one keeps the whole
  composite as its own asset too, which is a legitimate, harmless thing to
  want, not a conflict with also splitting it.

## 9-slice and states editing

No dedicated asset detail page exists yet. Simplest fit: clicking an
`AssetCard` opens a lightweight edit affordance (modal or inline expand) with
four margin number fields and a simple states list (add/remove short text
tags). Saves through the existing `PUT /api/assets/[id]` route, extended to
accept the two new optional fields (already Zod-validated per the data model
section).

`AssetCard` gains two small badges, shown only when set: "9-sliced" and
"N states" — the per-element status-at-a-glance gap flagged earlier in this
project's own design discussion history.

## Approaches considered

**A — crop client-side (chosen).** No new dependency, no server-side image
decoding. GameForge already has the piece coordinates it needs; cropping is
Canvas 2D work in the browser, uploading only the final cropped PNGs. Mirrors
what Pixellab's own frontend almost certainly does.

**B — crop server-side (rejected).** Ship crop rects to a new route, use a
real image library (`sharp`) to cut the already-downloaded composite there.
Rejected: a real new native dependency (another node-gyp build target
alongside `better-sqlite3`) bought nothing over A here — same inputs, same
outputs, more moving parts and one more thing that can fail to install on a
given machine.

## Testing

Following the project's established real-execution discipline (no mocks for
the things that matter):

- Migration 006: real temp SQLite file, same shape as migration 004's test —
  apply 001-006, verify the new columns exist with correct defaults, verify
  a normal (non-sheet) asset insert still works unchanged.
- **Caught during planning, not tested separately:** "already split"
  derivation was never promoted to actual code anywhere — nothing in the
  UI needs to ask that question, since a split sheet job just naturally
  stops appearing in the Jobs "needs a decision" view once it falls out of
  the existing 5-minute active window, the same as any other old complete
  job. There's no function to unit test.
- `generateUiAsset()`'s poll loop: mock `fetch` (not a live network call in
  automated tests) to exercise processing → completed, processing → failed,
  and timeout paths without spending real Pixellab credits on every test run.
  The one-time live-call verification already done during this session's
  research (confirmed schema against a real generation) stands in for "does
  the real API actually work this way" — CI doesn't need to re-verify that
  on every run.
- Split-to-assets route: real temp DB + real temp storage dir, POST a small
  fixture PNG + label, assert an asset row is created with `source_job_id`
  set and the file exists on disk.
