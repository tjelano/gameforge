# Live Theme Tweaking in the Review UI — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge's theme generation (Seed Theme Library, Export Formats, Contrast Checking,
Dedup-Steering/Multi-Candidate — all shipped) lets a user accept, discard, or regenerate a
theme candidate, but never adjust one directly. This is the fifth of a 6-item backlog for the
theme feature; the last item (full component-level generation) is a separate, later initiative
and out of scope here. The user's own framing: rather than discarding a nearly-right candidate
and re-rolling the whole generation, let them tweak the specific fields that are off and keep
everything else the AI got right.

## Decisions made during brainstorming

- **Tweakable scope:** all 8 `ThemeTokens` fields (`colorBackground`, `colorForeground`,
  `colorAccent`, `colorBorder`, `fontHeading`, `fontBody`, `spaceUnit`, `radiusBase`) — not a
  colors-only subset. This is a general-purpose editor, not a similarity metric, so there's no
  reason to withhold fonts/spacing/radius the way item 4's distance scoring correctly does.
- **Persistence:** edits save immediately (debounced), not behind an explicit "Save" button and
  not preview-only. Each field change re-serializes the full token set via the existing
  `tokensToCss()` and overwrites the job's own CSS file in place. This was chosen because
  promotion (`app/api/assets/from-job/route.ts`) just points a new asset row at the job's
  existing `result_path` filename — it never copies the file — so whatever is on disk at
  promotion time is exactly what gets promoted. Persisting immediately means there is never a
  "did I remember to save before promoting" gap.
- **Edit location:** a separate detail page, `/dashboard/jobs/[id]/edit`, not inline on
  `JobCard`. This matches this codebase's existing pattern for job-specific actions needing more
  room than a card allows (`/dashboard/jobs/[id]/split`, the UI-sheet splitting page) and keeps
  the jobs list scannable when nothing is being edited.
- **Reset to original:** yes, a "Reset to original" button, since edits now save instantly with
  no confirm step and no other undo path exists.
- **Scope boundary (not separately brainstormed, stated as the design's working assumption):**
  editing is available only for a theme job in `complete` status — i.e., during the review step,
  before a promotion decision has been made. Once a job is `promoted` it becomes an ordinary
  asset like any other; editing an already-promoted asset is out of scope for this feature (a
  separate future feature if ever wanted).

## Real gap found during self-audit — now part of the design

One real, load-bearing issue was found and is addressed directly here, not glossed over:

**A sidecar file for "reset to original" would be silently deleted by existing cleanup logic.**
The first design draft proposed saving the AI's original CSS as a same-directory sidecar file
(e.g. `<filename>.original.css`) the first time an edit was made. Investigating
`AssetService.ts`'s `cleanupOrphanedIn()` — the shared logic behind `cleanupOrphanedImages()`
and `cleanupOrphanedThemes()`, which runs as part of the regular git-sync flow
(`GitService.ts:181,218`) — showed it protects a file in `storage/themes/` ONLY if its exact
filename matches either a promoted asset's `image_path` or an active job's `result_path`. A
sidecar file with a different filename matches neither, so it would be treated as orphaned
garbage and deleted on the next cleanup pass — "Reset to original" would work once, then quietly
break as soon as cleanup ran.

**Fix, now the actual design:** store the original tokens as JSON inside the existing
`jobs.options` column (already a free-form JSON blob per job, `z.string()` with no fixed shape
enforced — confirmed theme jobs don't currently populate it with anything else) rather than a
second physical file. This is part of the job row itself, so it's automatically protected by the
job's own lifecycle and has zero interaction with file-cleanup logic. No schema change needed —
`options` already exists and already tolerates arbitrary JSON shapes (it's used today for
UI-sheet `pieces` arrays on image jobs).

Separately confirmed during the same investigation, and NOT a problem: `GitService.ts`'s
`stageFilesForCommit()` only ever stages a promoted asset's own `image_path` file — job files
(edited or not, pre-promotion) are never git-synced. So editing a job's CSS file repeatedly
creates no git-sync churn or timing concern.

## Out of scope for this feature

- **No editing of already-promoted assets** — this feature only touches jobs still in the
  review queue (`complete` status, not yet promoted or discarded).
- **No multi-user conflict handling** — this is a local-first, single-user app (no real auth
  system per `AGENTS.md`); the debounced-autosave design assumes one person editing one job at a
  time. Two browser tabs open on the same job would simply last-write-win, which is an accepted,
  unremarkable outcome for this environment.
- **No edit history beyond one original snapshot** — "Reset to original" restores the AI's very
  first output, not a multi-step undo stack. If a user tweaks, likes it, tweaks again, and wants
  the *middle* state back, that's not supported.
- **No changes to the generation flow, dedup-steering, or similarity badging** — those already
  read the job's current on-disk tokens on every poll (per item 4's design), so an edited job's
  similarity badge naturally reflects its current (edited) state with zero changes needed there.

## Data model

**No schema changes.** `jobs.options` (existing `TEXT` column, arbitrary JSON) gains one new,
optional key when a theme job's first edit happens: `{ "originalTokens": { ...ThemeTokens } }`.
Written once, on the first successful `PATCH`, never overwritten afterward — it always reflects
the AI's original output, regardless of how many edits follow.

## Component design

**New route:** `PATCH /api/jobs/[id]/theme` — accepts a full `ThemeTokens` object in the request
body, validated via the existing `ThemeTokensSchema`. On success:
1. If `jobs.options` doesn't yet contain an `originalTokens` key for this job, read the job's
   current CSS file, parse it via the existing `parseThemeCss()`, and write that as
   `originalTokens` into `options` before applying the new edit (captures the AI's true original,
   not whatever the first edit happens to be).
2. Serialize the submitted tokens via the existing `tokensToCss()` and overwrite the job's
   `result_path` file in place.
3. Reject (409) if the job's status isn't `complete` (already promoted, discarded, or still
   processing) — editing only makes sense during the review step.

**New route:** `POST /api/jobs/[id]/theme/reset` — reads `originalTokens` from `jobs.options` (404
if none exists, meaning the job was never edited), re-serializes it via `tokensToCss()`, overwrites
the CSS file with it, and returns the restored tokens so the UI can repopulate the form.

**New page:** `app/dashboard/jobs/[id]/edit/page.tsx` — fetches the job, renders the same
`buildThemePreviewHtml` iframe preview `JobCard` already uses, and a form with all 8 fields
(text inputs for colors/fonts/spacing/radius — no color-picker widget, consistent with this
codebase's plain-input styling elsewhere). Each field's `onChange` debounces (~400ms) before
firing the `PATCH`. A "Reset to original" button calls the reset route and repopulates the form
from its response. Field-level error messages surface `ThemeTokensSchema`'s own Zod messages
directly, mirroring the generation form's existing error-display pattern.

**Modified:** `app/components/JobCard.tsx` gains an "Edit" link (visible only for
`output_kind === 'theme' && status === 'complete'`) pointing at the new detail route, alongside
the existing Promote/Retry/Discard actions.

## Error handling

- Invalid field values (e.g. a non-hex color, given `ThemeTokensSchema`'s `CSS_COLOR_RE`) return
  a 400 with the same per-field Zod messages the rest of this codebase already surfaces.
- A job that's been promoted or discarded out from under an open edit page (e.g. promoted from
  another tab) returns 409 on the next `PATCH`; the UI surfaces this as a plain error message
  and stops attempting further autosaves for that session.
- A missing job returns 404.
- File write failures (disk full, permissions) are caught and surfaced as a 500 with a generic
  message, following this codebase's established `try/catch`-on-all-filesystem-ops convention.

## Testing

- `PATCH /api/jobs/[id]/theme`: valid edit persists and round-trips through `parseThemeCss`;
  invalid color/font/length rejected with 400 and no file write; `originalTokens` is written to
  `options` on the first edit only, and is NOT overwritten by a second edit; a non-`complete` job
  returns 409; a nonexistent job returns 404.
- `POST /api/jobs/[id]/theme/reset`: restores the file to exactly the original tokens; a job with
  no `originalTokens` in `options` (never edited) returns 404; the restored file is independently
  re-read and confirmed byte-appropriate (round-trips through `tokensToCss`/`parseThemeCss`).
- No component test for the edit page itself — this codebase has no component-testing
  infrastructure (confirmed during earlier planning this session: zero `.test.tsx` files, no
  `@testing-library/react`). Verified manually in a real browser instead, matching item 4's UI
  task precedent.

## Security note

No new external network calls or trust boundaries. The `PATCH` body is validated end-to-end by
the same `ThemeTokensSchema` every other theme-writing path in this codebase already uses before
anything reaches disk. `originalTokens` is populated server-side from the job's own existing
file, never from raw client input.
