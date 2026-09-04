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
  Zod-validated: trimmed, then either empty (clears the setting) or a
  genuinely absolute path — a relative path here would resolve from
  wherever the Next.js server process happens to be running, not from
  anywhere meaningful to the user. No live "test this path" probe in V1 —
  the Edit action itself will report clearly if the configured path
  doesn't resolve to a real file, which is the only moment that actually
  matters.
- On page load, `GET /api/settings/aseprite-path` populates the field with
  the currently saved value (empty if unset).

## Edit action

New button on `/dashboard/assets/[id]/page.tsx`, next to the existing
asset image: **"Edit in Aseprite"**. Only rendered when `asset.image_path`
is set (matches the existing conditional that already gates showing the
image itself).

Click → `POST /api/assets/[id]/edit` (no body). Server-side, in order
(finalized after adversarial review — see the Security note below for why
steps 2 and 4 exist):

1. Look up the asset. If it has no `image_path`, return
   `{ success: false, error: 'This asset has no image.' }`.
2. Validate the stored `image_path` is a bare filename (no `/`, `\`, or
   `..`) before resolving it to a physical path. If not, return
   `{ success: false, error: 'Invalid image path.' }`.
3. Read `aseprite_path` from `SettingsService`. If unset, return
   `{ success: false, error: 'Set your Aseprite path in Settings first.' }`.
4. Validate the configured path's filename actually looks like Aseprite
   (`aseprite*.exe`, case-insensitive). If not, return
   `{ success: false, error: 'Configured path must point to an Aseprite executable.' }`.
5. Resolve both paths to absolute (`path.join(getProjectRoot(), 'storage',
   'images', asset.image_path)` for the image, the raw stored value for
   Aseprite) and check both are regular files via `fs.statSync(...).isFile()`
   (not `existsSync` — a directory or other non-regular path would pass an
   existsSync-only check and produce a confusing spawn failure instead),
   in a try/catch per this project's fs-operation rule. Missing image file →
   `{ success: false, error: 'Image file not found on disk.' }`. Missing
   Aseprite →
   `{ success: false, error: 'Aseprite not found at the configured path. Check Settings.' }`.
6. Spawn: `child_process.spawn(asepritePath, [imageAbsolutePath], {
   detached: true, stdio: 'ignore' })`. **Array-form arguments, never a
   shell string** — this is what keeps either value from ever being
   re-parsed as shell syntax. No `shell: true`, no string concatenation
   into a command line. Attach a `once('error', ...)` listener and wait up
   to 300ms for it before calling `.unref()` — `spawn`'s realistic failure
   mode (bad permissions, not actually executable) surfaces asynchronously
   on this event, not as a synchronous throw; without a listener, an
   unhandled `'error'` event crashes the Node process.
7. If the bounded wait produced an error, return
   `{ success: false, error: 'Could not launch Aseprite. Check the configured path.' }`.
   Otherwise return `{ success: true }`. Either way the route does not
   wait for Aseprite to fully start or exit — only for that narrow,
   near-immediate failure window — and the detached child keeps running
   independent of the request/response cycle either way.

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
- The edit route's *decision logic* (which of the 7 outcomes above a given
  `(asset, settings, filesystem)` combination produces, including the
  path-safety and executable-filename checks) is written as plain,
  dependency-injected functions separate from the actual
  `child_process.spawn` call, so they're unit-testable without launching a
  real process in CI.
- The route's *wiring* to `spawn` — which arguments it's called with, and
  both its error-handling paths (a synchronous throw, and the realistic
  asynchronous `'error'` event) — is also automatically tested, via a
  mocked `child_process` module (a real Node `EventEmitter` standing in for
  the child process, so `.once('error', ...)` behaves exactly like the
  real thing). What is NOT automatically testable is the actual external
  effect: whether Aseprite really opens with the right file. That gets
  verified manually against a real local Aseprite install, the same way
  the real Pixellab API call was verified manually in the UI Sheets
  feature's end-to-end walkthrough.
- No test attempts to assert Aseprite actually opened or that the file
  was actually edited — that's a human, at a keyboard, with eyes.

## Security note

**Updated after this spec's plan went through adversarial review** (Codex,
via `claudex-loop:codex-review` — see
`docs/superpowers/plans/2026-09-04-aseprite-edit-review-log.md` for the
full argument). The original version of this note assumed "the machine's
own user" was the only trust boundary that mattered, since this app has no
authentication anywhere. That assumption was wrong: GameForge's own
`README.md` explicitly documents running it behind a VPN or tunnel for
remote access, which means an unauthenticated caller reaching this feature
over the network is a real, supported scenario — not a hypothetical.

Two inputs reach `child_process.spawn`: the asset's `image_path` and the
configured Aseprite path.

- `image_path` is server-generated in the normal upload flow, but
  `AssetSchema` does not format-validate it, and a row can arrive via
  git-imported JSON unchecked. It is now validated with
  `isSafeStoredFilename` (rejecting `/`, `\`, `..`) before ever being
  joined into a physical path — the same guard
  `app/api/images/[filename]/route.ts` already uses for reads.
- The Aseprite path is set via the Settings page, which — like every other
  route in this app — has no authentication. An unauthenticated remote
  caller (over a VPN/tunnel the user set up themselves, per the README)
  could in principle set this path and then trigger the edit action. This
  plan does not build real access control for this one route — doing so
  would be inconsistent (every other route, including git push/pull and
  asset deletion, is equally unauthenticated) and disproportionate for
  this feature.

  Instead, `looksLikeAsepriteExecutable` restricts what can ever be
  configured and launched to a filename that actually looks like Aseprite
  (`aseprite*.exe`, case-insensitive). **Be precise about what this does
  and does not do** (sharpened in round 2 of the adversarial review, which
  correctly pushed back on treating this as a security boundary): it is
  NOT a defense against an attacker who can already write files onto the
  machine — such an attacker could trivially rename any payload to
  `aseprite-evil.exe`, and at that point they already have far more direct
  ways to cause harm than this one feature, on any system. What it DOES
  do is narrow the *new* capability this feature specifically adds for an
  attacker who has ONLY network access to the app (the actual threat this
  finding named — reachable purely via `PUT` then `POST`, no local
  filesystem access needed): without this check, such a caller could point
  the launcher at any executable already present on the machine
  (`cmd.exe`, `powershell.exe`, anything). With it, they can only ever
  trigger something already named like Aseprite.

  **Round 3 of the review sharpened this further:** a filename-only check
  is not enough, because `path.isAbsolute()` (used by Task 2's settings
  route to reject relative paths) accepts Windows UNC paths
  (`\\server\share\...`) as well as genuine local paths — and a UNC path's
  *basename* can still match the Aseprite filename pattern. Without an
  additional check, the exact network-only attacker this mitigation is
  meant to narrow could host a payload named `aseprite-evil.exe` on a
  share they control and point the setting at it — no local file-write
  access required, defeating the mitigation entirely, and risking NTLM
  credential exposure during the `fs.statSync` call itself. Both
  `looksLikeAsepriteExecutable` and the settings route's own validation
  now additionally require the path be rooted on a genuine drive letter
  (`isDriveLetterRootedPath`, `/^[A-Za-z]:[\\/]/`), rejecting UNC and
  device/extended-length paths (`\\.\...`, `\\?\...`) outright. Named for
  exactly what it checks: a drive letter can still be a Windows *mapped
  network drive* (`Z:\` pointing at a UNC target), and a drive-rooted path
  can still traverse an NTFS reparse point/junction elsewhere — round 4 of
  the review flagged this precisely, and confirmed accepting it as a
  residual gap is reasonable for V1 (detecting either would need real
  OS-level drive-type/reparse-point queries, out of proportion for this
  feature). Consistent with every other mitigation in this note: narrows
  the risk, does not claim to eliminate it.

  **This app's total lack of authentication is accepted, pre-existing,
  whole-system risk, not something this feature changes.** Whether that's
  acceptable depends entirely on who has access to whatever VPN or tunnel
  fronts this app — if that access is trusted, this feature adds
  negligible incremental risk on top of everything else already
  unauthenticated in this app; if it isn't, the fix is a trusted VPN/tunnel
  in the first place, not a per-route patch. Nothing in this feature is a
  substitute for that.

Using the array-args spawn form for both invocations means neither value
is ever interpreted as shell syntax regardless of its content, independent
of the above.

**One more accepted residual, noted during the final whole-branch review:**
`POST /api/assets/[id]/edit` takes no body and no custom headers, so it's a
CORS-simple request — any page the user has open in the same browser could
fire an unauthenticated `fetch(url, { method: 'POST', mode: 'no-cors' })`
at `localhost:3000` and trigger the launch despite never seeing the
response. Impact is low (the attacker page would first need a real asset
UUID, which it has no way to obtain cross-origin) and the ceiling is the
same as everywhere else in this note — "Aseprite opens," not arbitrary
execution — but it's a genuine consequence of this app's no-auth posture
that the earlier passes through this note didn't call out explicitly.
Filed here rather than fixed, matching every other item on this list.
