# Image Input for Generation & Regeneration — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

Item 1 of a 3-item competitor-gap backlog found during a 2026-09-08 audit (see
`project_gameforge_competitor_gap_backlog` memory). User's own framing: "would be nice if it was
possible to put in images if you want to take a look at something that you want changed... same
way I would give you a screenshot to help with my explanation." GameForge's generation flow is
text-prompt-only today, for all three generator types (theme, component, pixel-art sprite).

## Decisions made during brainstorming

- **Applies to all three generator types**, not just theme/component. Confirmed real and
  feasible: Claude (theme/component generation) has native vision support already; Pixellab's
  `create-image-pixflux` endpoint genuinely supports an `init_image` parameter with a strength
  setting (confirmed via Pixellab's public docs — not guessed). Exact wire-format field shape
  for `init_image` still needs live-spec verification at implementation time, matching this
  codebase's own existing precedent for `PixellabGenerator.ts` ("schema confirmed against their
  live OpenAPI spec and one real test call — not guessed from docs summaries alone").
- **Two entry points**: (1) fresh generation (Generate page) — attach a reference image alongside
  the text prompt; (2) a new "Regenerate with changes" flow on an existing promoted asset's
  detail page — attach an image + note describing a desired change. (2) does not exist today;
  edit pages (`jobs/[id]/edit`, `jobs/[id]/edit-component`) are manual token/HTML editors that
  never call the AI again.
- **Regenerate-with-feedback never mutates the original asset.** It creates a brand-new job,
  pre-loaded with the current asset's content as context plus the new image/note — mirroring how
  Style Bible Fork already works (never modify the original, always produce something new the
  user then chooses to promote or discard).
- **Storage: reuse `jobs.options`, no schema change.** The uploaded image is written to disk once
  per job and its path is stored in the job's existing `options` JSON blob (`JobSchema.options`,
  already a free-form JSON string column) — the same pattern the live-tweaking feature and
  dedup-steering already use for job-scoped extras. Rejected: persisting the image forever on the
  finished asset (a new DB column, an unresolved git-sync question, and no clear ongoing value
  once generation succeeds).
- **No git sync for reference images.** They're working input, not a finished asset — matches
  jobs themselves, which are already local-only (`DATA_DIRS` in `GitService.ts` never included
  `data/jobs`).
- **Cleanup**: reference images are covered by the same orphan-protection logic that already
  guards in-flight job images (`AssetService.cleanupOrphanedImages()`'s existing
  pending/processing/complete protection, per AGENTS.md's own noted convention) — a reference
  image tied to a live job must not be deleted out from under it.

## Design

### Where it shows up
- `app/dashboard/generate/page.tsx`: a new optional file-attach field next to the existing prompt
  textarea.
- A new "Regenerate with changes" button on asset detail pages (`app/dashboard/assets/[id]/page.tsx`
  today only has this one component/theme/image detail view — this feature adds the button there
  for all three `output_kind`s). Opens the same generate form, pre-filled with `styleId` +
  `assetType` from the current asset, plus a reference note field.

### Request shape
`GenerateSchema` in `app/api/generate/route.ts` already has a free-form `options:
z.record(z.string(), z.unknown()).optional()` field. The new `referenceImage` key must NOT ride
in under that untyped `z.unknown()` catch-all — an uploaded payload needs real server-side
validation, not just the client-side file-picker checks (trivially bypassable by anyone calling
the API directly). The route parses `options.referenceImage` through its own dedicated schema
before it ever reaches `jobService.create()`:
```ts
const ReferenceImageSchema = z.object({
  base64: z.string().max(<N>), // server-side size ceiling, exact N chosen at implementation time
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
});
```
Everything else in `options` (existing keys like `pieces`) stays under the current untyped
catch-all — this tightening applies only to the new image payload, since it's the only key that
represents untrusted binary-ish data rather than small structured job parameters.
`JobService.create()` saves the validated base64 payload to
`storage/references/<jobId>.<ext>` and stores the FILENAME (not the base64 blob) in
`jobs.options`, keeping the DB row small — same "store a path, not a blob" convention every other
image-bearing row in this schema already follows.

### Generator changes
- **`ClaudeApiThemeGenerator` / `ClaudeApiComponentGenerator`**: when a reference image is
  present, `messages: [{ role: 'user', content: fullPrompt }]` becomes `messages: [{ role: 'user',
  content: [{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text:
  fullPrompt }] }]` — a request-shape change only, no change to `tool_choice`/response parsing
  (both generators already force a single tool call; adding an image block doesn't affect that).
- **`PixellabGenerator`**: when present, add `init_image` (+ a sensible default strength) to the
  `create-image-pixflux` request body. Exact field name/encoding to be confirmed against
  Pixellab's live OpenAPI spec during implementation (per the precedent noted above) — this spec
  commits to the capability existing, not to an unverified exact payload shape.

### Regenerate-with-feedback context
When creating a job via the new "Regenerate with changes" path, the pre-filled prompt includes
the existing asset's current content (its stored theme tokens or component HTML, read the same
way dedup-steering already reads existing theme assets for its "avoid these colors" context) so
the model has both "here's what exists now" and "here's what I want changed," not just the raw
image in isolation.

### Error handling
- Unsupported file type or oversized image: rejected client-side before upload, same validation
  layer as any other form input in this app.
- Claude/Pixellab reject the image itself (bad format, content policy, etc.): the job fails with
  a clear error message, same failure path every other generation failure already uses — no new
  error-handling mechanism needed.

### Testing
Same convention as every other service in this codebase: real temp SQLite + real temp files, not
mocks (matches `test/gitServicePages.test.ts`, `test/siteExporter.test.ts`, etc.). New tests
cover: the job-creation path persisting `referenceImage` into `options` correctly, the two
generator classes building the right request shape when an image is present vs. absent, and
`cleanupOrphanedImages()`-equivalent protection for a reference image tied to a live job.

## Out of scope
- Reverse-sync between an exported/edited site and GameForge's dashboard (a separate, larger
  item — see `project_gameforge_competitor_gap_backlog` memory's item 4; core direction validated
  but not yet fully designed).
- W3C tokens JSON import and sitemap/page-layout AI assist (items 2 and 3 of the same backlog —
  each gets its own fresh brainstorm).
- Persisting the reference image permanently on the promoted asset (see "Storage" decision above).
- Any change to Pixellab's `generateUiAsset` (UI-sheet) path — this spec covers `pixflux` only,
  since that's GameForge's single-sprite generation path or the reference-image use case.
