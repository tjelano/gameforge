# Reverse-Sync Between Dashboard and Exported/Edited Site — Design Spec

Status: Approved by user in brainstorming chat, adversarially reviewed with DeepSeek (5 rounds,
APPROVED). Ready for implementation planning.

## Motivation

Item 4 of GameForge's competitor-gap backlog, surfaced mid-brainstorm during item 1 (image input)
and deferred until items 1-3 shipped (see `project_gameforge_competitor_gap_backlog` memory).
User's own framing: "what we are kinda building is being able to edit/add features to sites, and
not being able to go back and forth between you(claude) and the dashboard kinda breaks that
workflow."

GameForge's "Site Export" feature (`lib/services/SiteExporter.ts`) writes a real, standalone
Next.js + Tailwind project from a Style Bible's Pages and components — but it's one-way. Once
exported, hand-editing that project (in VSCode or otherwise) is a dead end: GameForge's own
dashboard/database never learns about it, and the next export would overwrite it.

## Grounding in current code

- **Canonical component storage**: `storage/components/<file>.html` — a full self-contained HTML
  document (`combineComponentHtml`/`parseComponentHtml` in `lib/services/componentDocument.ts`),
  holding UNSCOPED `<style>` and `<body>` content, exactly as the LLM (or the token-slider editor)
  produced it.
- **Export transform** (`SiteExporter.ts`): converts that HTML+CSS into a `.tsx` file (via
  `htmlToJsx`) wrapped in a `<div className={styles.root}>`, and a `.module.css` file where every
  selector has been prefixed with `.root` (`scopeComponentCss`, required because Next's CSS
  Modules "pure mode" rejects any selector with no local class). Component filenames are
  `${PascalCase(assetType)}${first 6 hex chars of the asset's UUID, dashes stripped}.tsx` — e.g.
  `HeroA3f9c1.tsx`. This is NOT a designed reverse-lookup key, just an accident of the naming
  scheme; there is no manifest or metadata file recording asset ↔ file identity today.
- **Pages export** as a `page.tsx` per route, rendering known components as self-closing JSX tags
  (`<HeroA3f9c1 />`) in the page's stored order, one per line, inside a single `<>...</>` fragment
  (`buildPageFile`).
- **`exportSite()` today refuses to write into an existing directory** (`ALREADY_EXISTS`, an
  atomic non-recursive `mkdir` used as the existence check) — it's a one-shot "create," not a
  "refresh."
- **`sanitizeComponentHtml`/`sanitizeComponentCss`** (`lib/services/componentSanitize.ts`) is this
  app's actual security guarantee for components, per its own design-doc comment: the generated
  HTML/CSS is meant to be pasted directly into a real, live website with no other safety net
  (narrow tag/attribute allowlist, no `<img>`, no `<script>`, no external resource loading).
- **Existing "existing assets only" trust precedent**: `componentsByAssetId` (SiteExporter.ts)
  already keys component identity by the full asset UUID, never the truncated display name.

## Decisions made during brainstorming

Presented as three options via AskUserQuestion; user chose the recommended, most-scoped option
each time — the reverse transform (JSX/CSS back to HTML) is materially harder and lossier than the
forward one, so the design deliberately avoids taking it on:

- **Code-level edits are a manual paste, not automatic reversal.** Reversing JSX back to HTML and
  un-scoping arbitrary hand-edited CSS is undefined once an edit uses real React (props, state,
  new imports) with no HTML equivalent. Sync only ever *detects* that a component's code changed
  (via a content hash mismatch) and flags it — it never attempts to parse the new code back into
  HTML/CSS. Bringing the edit in is a manual copy-paste into the existing component edit page.
- **Scope is existing GameForge assets only.** A brand-new, hand-authored component with no
  corresponding asset stays in the exported project as-is (rendered, untouched) — never imported
  as a new asset. GameForge's asset model (HTML+CSS, slider-editable) has no format for an
  arbitrary hand-written React component anyway.
- **Sync previews a diff before writing anything**, mirroring the existing Suggest Layout pattern
  (compute → show → explicit apply). No structural changes are written to the database without
  the user reviewing them first.
- **Re-export must support writing into an existing directory** (today it can't), and must never
  silently clobber a hand-edited component file it hasn't synced yet — it skips that one file and
  reports the skip in the export result, refreshing everything else normally.

## Architecture

- **`lib/services/ExportManifest.ts`** (new): reads/writes `gameforge-manifest.json` at the root
  of an export directory. Records, per export: `styleId`, `exportedAt`, and for every page — id,
  name, slug, its component order (asset IDs) at export time, and a sha256 hash of the written
  `page.tsx`; for every component — asset id, component name (the JSX identifier), and a sha256
  hash covering its `.tsx` + `.module.css` content.
- **Page identity survives a folder rename**: every exported `page.tsx` gets a leading comment
  embedding the page's real UUID (`// gameforge-page-id: <uuid>`). `ExportSync` matches a route
  folder back to a manifest/DB entry by this embedded ID FIRST, falling back to "no embedded ID
  found → this is a brand-new page" only when absent. Matching by folder/slug name alone breaks if
  the user renames the folder by hand.
- **`lib/services/ExportSync.ts`** (new): given a style + export directory, reads the manifest,
  re-scans the current on-disk files, and produces a diff object describing: new pages found (no
  embedded page-id comment), pages deleted externally (a manifest page-id with no matching route
  folder), per-page component-reference changes, and which existing components look hand-edited
  (current file hash ≠ manifest hash for that asset).
  - Component-reference detection uses a regex over the WHOLE file (not line-anchored),
    `/<([A-Z][A-Za-z0-9]*)\b[^>]*\/>/g`, matched against the manifest's known component names —
    tolerant of added attributes, reformatted whitespace, and multiple tags per line. Deliberately
    not a real JSX parser (per the scope decision to avoid JSX/CSS reversal complexity): a tag
    rewritten as non-self-closing, or commented out, won't be detected correctly. That's an
    accepted, disclosed limitation of the "no parser dependency" choice, not a gap to close.
  - A brand-new page (no embedded ID) has no display name on disk to recover — its `name`
    defaults to a title-cased version of its route slug (split on hyphens, capitalize each word),
    editable by the user after sync applies it.
- **`SiteExporter.exportSite()`** (modified): now accepts re-exporting into an existing directory
  (removes the `ALREADY_EXISTS` refusal for the "same style, refresh" case). Writes/refreshes the
  manifest on every export. Before overwriting each component's `.tsx`/`.module.css`, compares the
  CURRENT on-disk file's hash against the manifest's last-recorded hash for that component; if
  they differ (an unsynced hand-edit), skips writing that component's files and adds it to the
  export result's "skipped" list instead of overwriting it.
  - **Concurrency**: a second export/re-export request for the same `(styleId, subdir)` while one
    is already in flight must not interleave writes into the same directory. Uses an atomic lock
    (`fsPromises.mkdir` on a `.gameforge-export.lock` directory inside `targetDir`, the same
    atomic-mkdir-as-mutex trick this file already uses for the create-vs-`ALREADY_EXISTS` check
    today) held for the duration of the export and removed in a `finally`, before the lock
    directory itself is removed.
  - **Stale-lock recovery via heartbeat**: a released-on-completion lock is not crash-safe on its
    own — a process crash or power loss between acquiring the lock and the `finally` running would
    leave it in place forever. Fix: write a timestamp file inside the lock directory at acquire
    time, refreshed every 30 seconds via a heartbeat for as long as the export runs. A future
    export finding the lock already held checks the timestamp's age against the heartbeat interval
    (stale past 2 minutes since the LAST HEARTBEAT, not since acquire time — a fixed
    acquire-time timeout would falsely trigger on a legitimately slow export or a laptop
    sleep/resume mid-export, recreating the exact race the lock exists to prevent) — if stale,
    attempts recovery; otherwise fails with "export already in progress."
  - **Stale-lock recovery is itself made atomic**: "detect stale, remove it, then mkdir fresh" is
    two separate non-atomic steps — two contenders could both observe staleness, both remove the
    same directory, and both then successfully create their own fresh lock, reproducing the
    original interleaved-write corruption. Fixed with an atomic claim step: recovering a stale lock
    renames it away to a unique name (`fs.rename(lockDir, `${lockDir}.stale.${process.pid}`)`)
    BEFORE creating a fresh one. `rename` is a single atomic filesystem operation — only one
    contender's rename can succeed against the same source path; a second contender's rename fails
    with `ENOENT` and falls back to the normal "in progress, try again" path. Only the contender
    whose rename succeeded proceeds to `mkdir` a fresh lock, write its own heartbeat, and continue;
    it best-effort deletes the renamed-away garbage directory afterward (non-blocking).
- **New routes**: `POST /api/styles/[id]/export-sync/preview` (body: `{ subdir }`, computes and
  returns the diff, writes nothing) and `POST /api/styles/[id]/export-sync/apply` (body: `{ subdir
  }` only — no client-supplied diff). `apply` ALWAYS recomputes the diff itself, fresh, from the
  current on-disk state and current DB state at the moment it runs, and applies that — it never
  trusts a diff the client sends. This is both simpler and safer than passing the diff through the
  client: since recomputation is idempotent, `apply` needs no session/token mechanism to "match" a
  specific earlier `preview` call — it just always applies present reality, which is also the more
  correct behavior if time passed between preview and apply. Mirrors the existing "preview, then
  explicit apply" shape already used by Suggest Layout.
- **UI**: a "Sync from export" section on the Style Hub page (`app/dashboard/styles/[id]/page.tsx`)
  next to the existing Export section, using the same subdir textbox. Shows the diff for review
  before Apply. A component flagged hand-edited links to its existing edit page with a banner
  prompting a manual paste of the new HTML/CSS, with an explicit "trust this as my own edited
  code" confirmation (since it skips sanitization for that specific paste).

### Acknowledged, not fixed: `componentName()`'s 6-hex-char truncation

`SiteExporter.ts`'s existing `componentName()` (PascalCase asset_type + first 6 hex chars of the
asset UUID) is a theoretical collision risk, verified as pre-existing, already-shipped behavior —
not introduced by this feature. `componentsByAssetId` already keys identity by the FULL asset UUID
(`SiteExporter.ts:117`), and this design's manifest does the same; componentName is only ever a
filename/JSX-identifier convenience, never the identity source of truth. Collision probability is
negligible (24 bits) for any realistic per-style component count, and unaffected by this feature
either way. Changing the naming scheme is out of scope — it would break the file names of every
already-exported project. Left as a disclosed, inherited characteristic; a standalone future fix
to `SiteExporter.ts` could add a collision check independent of this feature.

### Declined: a `.tsx` syntax/parse-integrity check

This design never actually parses `.tsx` content as code — structural detection is a plain regex
over text, and hand-edit detection is a content hash — both work identically regardless of whether
the file is valid JS/TSX syntax. A "syntactically broken" file just yields fewer/different regex
matches, already handled as an ordinary structural change (that component reference is gone from
the page), not a crash or an undefined state. Adding a parser dependency here would be scope creep
with no corresponding behavior change.

## Data flow

1. Export writes `gameforge-manifest.json` alongside the site files.
2. User hand-edits files in the export directory.
3. "Sync from export" → `preview` → `ExportSync` reads manifest + scans directory → returns diff.
   Nothing written yet.
4. User reviews, clicks Apply → `apply` writes only Page changes (create/update/soft-delete). Never
   touches component asset content.
5. For each hand-edited component, user is linked to its edit page to manually paste in the new
   HTML/CSS. That asset gets `edited_externally = 1` and a persistent UI badge; sanitization is
   skipped for that specific paste.
6. Next re-export refreshes the manifest with new hashes. Any component whose on-disk file still
   doesn't match the (now-updated, if synced) asset content is skipped-and-reported again.

## Data model changes

- `pages`: no schema change (`component_asset_ids` is already a JSON string array).
- `assets`: one new nullable column, `edited_externally` (0/1, same shape as the existing
  `is_deleted` flag). Needs a new migration following this codebase's existing numbered-migration
  pattern.
  - **Lifecycle**: `edited_externally` reflects whether the asset's CURRENT stored content came
    from an external hand-edit rather than GameForge's own generation pipeline. It is SET to 1 the
    moment a paste-back is confirmed (the content just brought in unambiguously IS
    externally-sourced) and stays 1 until GameForge's own generator next produces fresh content for
    that asset (a full regenerate) — not cleared by the mere passage of time or by a later sync.
    Sanitization is skipped only for that specific paste-back write, not permanently for the asset
    id — a subsequent normal token-editor save still goes through sanitization as always, since the
    editor only ever tweaks values already inside already-sanitized markup.
- No new table for the manifest — it's a per-export-directory file, not database state. Since a
  style can have multiple named export directories, sync takes the same `subdir` input Export
  already uses (no separate picker).

## Error handling

- Manifest missing/unreadable → `preview` returns a clear error, refuses to proceed. No heuristic
  fallback (no attempt to "guess" structure without a manifest).
- A page.tsx references a JSX tag that isn't a known component name → left alone, not part of the
  synced order (matches "existing assets only" scope — never an error).
- A page.tsx references a component name that *was* in the manifest but whose asset is now
  soft-deleted → flagged in the diff as "references a deleted asset, will be dropped from this
  page's order."
- Hashing: Node's built-in `crypto` (sha256), no new dependency.

## Testing

- `ExportManifest` read/write round-trip.
- `ExportSync` diff logic: new page detected (no embedded page-id comment); deleted page detected
  (manifest page-id with no matching folder); a page RENAMED on disk still resolves to the same
  page via its embedded ID (not seen as delete+create); reordered/added/removed component
  references detected, including with added attributes/reformatted whitespace on the tag; a
  commented-out or non-self-closing-rewritten tag is correctly NOT detected (documented limitation,
  asserted directly); hand-edited component detected via hash mismatch (and confirmed NOT
  auto-imported); unrecognized JSX content ignored without erroring.
- `SiteExporter` re-export: can re-export into an existing directory; a hand-edited component file
  is skipped-and-reported rather than clobbered; manifest is refreshed each export; two concurrent
  export calls for the same (styleId, subdir) — one wins the lock, the other fails with a clear
  in-progress error, neither corrupts the output; a lock directory left behind by a simulated crash
  (present with an old heartbeat timestamp) is detected as stale, recovered atomically, and a
  subsequent export succeeds rather than failing forever; two simulated concurrent stale-recovery
  attempts — only one wins, the other backs off cleanly.
- Route tests: `preview`/`apply` auth-gated; `apply` recomputes its own diff and ignores/rejects any
  diff-shaped data in its request body; `apply` updates Page rows correctly; `apply` never touches
  asset content; a component's own reference-order change and its hash-mismatch flag are
  independent (a component can be simultaneously reordered on a page AND flagged hand-edited).
- `edited_externally`: set on a confirmed paste-back; a subsequent normal token-editor save still
  sanitizes as before; only a fresh AI regeneration clears the flag.

## Adversarial review trail (DeepSeek, 5 rounds, APPROVED)

This design went through 5 rounds of DeepSeek plan review before being approved. Each round found
a genuinely new, non-repeated correctness issue (not diminishing into trivia), concentrated almost
entirely in the export-lock concurrency mechanism — a useful signal that distributed-mutex-style
correctness is subtle enough to be worth this many passes:

- **Round 1**: page identity breaks on a folder rename (fixed: embed the page's real UUID as a
  comment in each exported page.tsx); the original line-anchored regex is fragile against
  hand-formatted edits (fixed: loosened to a non-line-anchored, attribute-tolerant regex; a real
  JSX parser was explicitly declined as scope creep against an earlier deliberate simplicity
  choice); new-page naming and `edited_externally`'s lifecycle were unspecified (both had already
  been flagged as open questions in the pre-review draft — DeepSeek's answers were used as a second
  opinion; `edited_externally` was resolved in the OPPOSITE direction from DeepSeek's literal
  suggestion after determining that was the semantically correct one); `apply`'s client-suppliable
  diff is tamperable/stale (fixed, but simplified past DeepSeek's own proposed token mechanism —
  always recompute server-side instead, which needs no correlation mechanism at all); export/
  re-export had no concurrency protection (fixed: an atomic lock file). Two round-1 findings were
  verified against the real code and declined: `componentName()`'s 6-hex-char truncation
  (pre-existing, unaffected by this feature) and a `.tsx` parse-integrity check (this design never
  parses code, so there's no such failure mode).
- **Round 2**: the round-1 lock fix wasn't crash-safe (a process crash before the `finally` ran
  would leave it stuck forever) — fixed with a stale-lock timeout. Every other round-1 resolution,
  including the two departures from DeepSeek's literal suggestions, was independently re-confirmed
  correct in this round.
- **Round 3**: the round-2 fix (a fixed "stale after 5 minutes since acquired" timeout) was itself
  a new race — a legitimately slow export or a laptop sleep/resume mid-export could exceed that
  window while still genuinely running, letting a second request delete the "stale" lock and write
  concurrently. Fixed with a heartbeat instead of a fixed timeout: staleness now measures time
  since the lock last proved it's alive, not time since it was acquired.
- **Round 4**: the round-3 heartbeat-based recovery ("detect stale, remove it, then mkdir fresh")
  was still a two-contender race, since remove-then-create isn't atomic as a unit. Fixed with an
  atomic rename-to-claim step before recovery.
- **Round 5**: confirmed the atomic rename-claim closes the gap with no remaining material
  findings. VERDICT: APPROVED.
