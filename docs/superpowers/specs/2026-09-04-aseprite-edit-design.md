# Edit in Aseprite — Design Spec

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

GameForge generates pixel art via Pixellab, but AI generations often need a
manual touch-up pass. Aseprite is the standard pixel-art editor for exactly
this. This feature adds a one-click "Edit in Aseprite" action on a promoted
asset's detail page: it launches Aseprite, pointed at that asset's actual
image file, on the same machine GameForge is running on.

GameForge is local-first with no production/serverless deploy target (see
`AGENTS.md`) — the browser, the Next.js server, and the file being edited
are always the same machine. This is what makes "launch a native app" a
reasonable browser-triggered action here; it would not be safe or possible
in a hosted multi-tenant deployment, which this app is explicitly not.

## Out of scope for V1

- **No automated Aseprite installation.** Aseprite's official binaries are
  a paid product (Steam / itch.io); the source is free to compile
  yourself, but redistributing a compiled binary to another person —
  even a household member on their own machine — is exactly what
  Aseprite's EULA prohibits. GameForge will not host, build, or hand out
  compiled Aseprite binaries. Each machine that wants this feature needs
  Aseprite (however the user gets it) already present, at a path the user
  points GameForge to.
- **No auto-detection of Aseprite's install location.** Steam, itch.io,
  and self-built installs all land in different places. V1 asks the user
  to set the path once in Settings rather than guessing.
- **No file-watching or auto-refresh after editing.** Editing happens in
  place; the user manually navigates back to (or refreshes) the asset
  page to see the updated image. No live sync, no "Aseprite closed"
  detection.
- **No editing from the Jobs page.** Only promoted assets (which have a
  stable `image_path` under `storage/images/`) get the Edit action in V1.
  A job's `result_path` is not editable via this feature.
- **No versioning/undo at the GameForge level.** Aseprite overwrites the
  same file GameForge already serves. If a user wants to keep the
  pre-edit version, that's on them (or on Aseprite's own undo history) —
  GameForge does not snapshot before launching the editor.

## Data model

One new table, migration 007:

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Plain key-value. `settings` is local-machine config — like `jobs`, it is
**never** git-synced (not in `GitService`'s `DATA_DIRS`, not exported to
`data/`). The Aseprite path on one machine is meaningless on another; this
mirrors why `source_job_id` was deliberately excluded from git sync in the
UI Sheets feature.

First key: `aseprite_path` (absolute path to the Aseprite executable).
The key-value shape (not a dedicated `aseprite_path` column somewhere) is
chosen because it's the smallest structure that covers "one path, for now"
without over-building a settings framework nobody's asked for yet — if a
second setting shows up later, this table already supports it for free.

## Settings page

New page: `/dashboard/settings/aseprite`. New `NavRail` entry next to the
existing "Storage" link (same nesting pattern — a flat top-level link,
matching how Storage is surfaced today rather than inventing a settings
sub-menu).

- A single text field: the absolute path to `Aseprite.exe` (or the
  platform-appropriate executable name — this user is on Windows, so V1
  targets Windows path conventions; not attempting cross-platform
  detection logic since there's nothing to detect).
- Save button → `PUT /api/settings/aseprite-path` with `{ path: string }`,
  Zod-validated as a non-empty string. No live "test this path" probe in
  V1 — the Edit action itself will report clearly if the configured path
  doesn't resolve to a real file, which is the only moment that actually
  matters.
- On page load, `GET /api/settings/aseprite-path` populates the field with
  the currently saved value (empty if unset).

## Edit action

New button on `/dashboard/assets/[id]/page.tsx`, next to the existing
asset image: **"Edit in Aseprite"**. Only rendered when `asset.image_path`
is set (matches the existing conditional that already gates showing the
image itself).

Click → `POST /api/assets/[id]/edit` (no body). Server-side, in order:

1. Look up the asset. If it has no `image_path`, return
   `{ success: false, error: 'This asset has no image.' }`.
2. Read `aseprite_path` from `SettingsService`. If unset, return
   `{ success: false, error: 'Set your Aseprite path in Settings first.' }`.
3. Resolve both paths to absolute (`path.join(getProjectRoot(), 'storage',
   'images', asset.image_path)` for the image, the raw stored value for
   Aseprite) and check both exist via `fs.existsSync`, in a try/catch per
   this project's fs-operation rule. Missing image file →
   `{ success: false, error: 'Image file not found on disk.' }`. Missing
   Aseprite →
   `{ success: false, error: 'Aseprite not found at the configured path. Check Settings.' }`.
4. Spawn: `child_process.spawn(asepritePath, [imageAbsolutePath], {
   detached: true, stdio: 'ignore' }).unref()`. **Array-form arguments,
   never a shell string** — this is what keeps the image's filename (a
   server-generated UUID-based name, but treated as untrusted regardless)
   from ever being re-parsed as shell syntax. No `shell: true`, no string
   concatenation into a command line.
5. Return `{ success: true }` immediately. The route does not wait for
   Aseprite to exit — `.unref()` lets the Node process exit cleanly
   without babysitting the spawned child, and the detached child keeps
   running independent of the request/response cycle.

Client-side: on click, POST, show a small inline status — "Opening
Aseprite…" then either nothing further (success — user tabs over to the
now-open Aseprite window) or the returned error message inline, matching
the existing error-display pattern already used on this page (`{error &&
<p style={{ color: 'var(--reject)' }}>...}`).

## Error handling

Every failure mode above is a distinct, specific `{ success: false, error
}` — no generic "something went wrong." This matters here more than in
most of this app's routes because the user's *next action* differs by
failure: no image → nothing to do; no path configured → go to Settings;
path configured but wrong → go fix it in Settings; image file missing on
disk → a data-integrity problem worth noticing, not silently retrying.

All fs and process operations wrapped in try/catch with `console.error`
logging on failure, per this project's standing rule — a failed spawn
(e.g., the configured path exists but isn't actually executable) should
log server-side detail even though the user only sees the generic
"couldn't launch Aseprite" message.

## Testing

- `SettingsService` (`get`/`set`): real temp SQLite, this project's
  standard pattern (temp dir, copied real migrations, `setProjectRootForTests`,
  `DatabaseConnection.resetForTests()`) — mirrors every other service test
  in this codebase.
- The edit route's *decision logic* (which of the 4 outcomes above a given
  `(asset, settings, filesystem)` combination produces) is written as a
  plain, dependency-injected function separate from the actual
  `child_process.spawn` call, so it's unit-testable without launching a
  real process in CI. The spawn call itself is not meaningfully testable
  by an automated suite — it launches a real GUI application — and gets
  verified manually against a real local Aseprite install, the same way
  the real Pixellab API call was verified manually in the UI Sheets
  feature's end-to-end walkthrough.
- No test attempts to assert Aseprite actually opened or that the file
  was actually edited — that's a human, at a keyboard, with eyes.

## Security note

The only externally-influenceable input reaching `child_process.spawn` is
the asset's `image_path` (a server-generated filename, not user-typed) and
the Aseprite path (set by the machine's own user via Settings, not by a
network request from anyone else — this app has no auth, so "the machine's
own user" is the only meaningful trust boundary here, same as everywhere
else in GameForge). Using the array-args spawn form means neither value is
ever interpreted as shell syntax regardless of its content, so this holds
even if that assumption were ever wrong.
