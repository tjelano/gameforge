# Google Drive Integration — Design Spec

## Goal

A full, in-dashboard file manager for a Google Drive the user already owns and
has shared with their 2-3 collaborators (everyone already has full access —
this feature never manages Drive permissions). Two things drive want it, in
the user's own words: (1) a quick way to push individual GameForge assets
("or whatever else I want to share") into Drive, and (2) never having to
leave the GameForge dashboard to work with that Drive at all — browse,
upload, delete, rename, move, create folders, all from inside GameForge.

## Non-goals (explicitly out of scope, confirmed with the user)

- **No permission/sharing management.** Everyone already has full access to
  the whole Drive. GameForge never calls Drive's permissions API.
- **No embedding Google's own Drive UI.** Verified: Google blocks iframe
  embedding of `drive.google.com` outright. This has to be a real custom UI
  talking to the Drive API directly — there's no shortcut.
- **No extra in-app permission layer.** Any logged-in GameForge user (see
  `docs/superpowers/specs/2026-09-07-login-auth-design.md`, already shipped)
  gets full Drive management through this feature. Restricting who can click
  "delete" inside GameForge wouldn't protect anything real Drive access
  doesn't already allow — they could always do the same thing directly on
  drive.google.com.
- **No true push-based real-time sync.** That needs a public HTTPS webhook
  endpoint Google can call, which conflicts with this app running purely
  locally (would require a tunnel service, domain verification, and
  subscription renewal every few days — real, ongoing infrastructure for a
  2-3 person tool). Polling instead — see "Live updates" below.
- **No multi-select / bulk actions for v1.** Single-item actions only
  (delete one, rename one, move one). Confirmed acceptable with the user.

## Architecture

### Auth: one app-wide connection, not per-person

The admin (whoever sets this up) connects their own Google account once —
the one that owns the shared Drive. Every GameForge user then reads/writes
through that single connection; nobody else needs their own Google OAuth.
This matches the actual use case: it's one specific, already-shared Drive,
not "each person's own Drive."

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars (same lazy-loaded
  pattern as `PIXELLAB_API_KEY` — never committed, read at first use, not at
  module-import time).
- `GET /api/drive/connect` builds the Google consent URL via
  `google-auth-library`'s `OAuth2Client.generateAuthUrl({ access_type:
  'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/drive'] })`
  and redirects there. **Both `access_type: 'offline'` and `prompt:
  'consent'` are required** — verified against Google's own docs: Google
  only issues a refresh token on an authorization that includes both;
  omitting `prompt: 'consent'` on a *re*-authorization (e.g. after the admin
  revokes access and needs to reconnect) can silently return no refresh
  token at all, silently breaking the whole "connect once" model.
- `GET /api/drive/callback` receives the auth code, exchanges it for tokens,
  and stores **only the refresh token** (not the short-lived access token —
  there's no reason to; see below) in the existing `settings` key/value
  table (`lib/database/migrations/007_add_settings_table.sql` — no new
  migration needed) under key `google_drive_refresh_token`.
- Every server-side Drive call constructs a fresh `OAuth2Client`, calls
  `.setCredentials({ refresh_token: storedToken })`, and passes it to the
  Drive client. Verified against `google-auth-library`'s own documented
  behavior: once a refresh token is set, the library "acquires and refreshes
  [access tokens] automatically in the next call to the API" — no manual
  token-refresh code, no access-token storage/expiry tracking needed
  anywhere in GameForge.
- `GET /api/drive/status` — `{ connected: boolean }`, checks whether the
  settings key exists. Powers both the settings page's connection indicator
  and a "Reconnect Google Drive" banner shown wherever a Drive API call
  fails with an auth error (401/invalid_grant — the refresh token itself can
  be revoked by the admin from their Google Account security settings at any
  time, independent of anything GameForge does).

### Dependency: `@googleapis/drive`, not the full `googleapis` package

`googleapis` bundles generated clients for every Google API (Gmail,
Calendar, Sheets, hundreds more) — `@googleapis/drive` is Google's own
scoped package for just the Drive API, built on the same underlying
`google-auth-library` and code generator, much smaller. Use it plus
`google-auth-library` directly (for `OAuth2Client`) as the only two new
dependencies this feature adds.

### `lib/services/DriveService.ts`

Mirrors this codebase's existing service-singleton shape. All methods take
the stored refresh token internally (read from `settings` via direct SQL,
matching every other service in this codebase) — callers never handle
tokens.

- `isConnected(): Promise<boolean>`
- `getAuthUrl(): string`
- `exchangeCodeForTokens(code: string): Promise<void>` — stores the refresh
  token
- `listFiles(folderId: string, query?: string): Promise<DriveFile[]>` —
  `folderId` defaults to Drive's special `'root'` alias for the top of My
  Drive; `query` maps to the Drive API's `q` search parameter for the
  optional search box
- `uploadFile(params: { name: string; mimeType: string; stream: Readable;
  parentFolderId: string }): Promise<DriveFile>` — a single `files.create`
  call with `media: { mimeType, body: stream }`. **Verified but not yet
  empirically tested**: per Google's own Node.js client docs and multiple
  independent sources, passing a stream here makes the client library
  transparently choose simple vs. resumable upload based on size — no
  separate code path needed. This assumption needs a real test with an
  actual large file (tens of MB+) during implementation, the same way this
  session has verified other risky assumptions by actually running them,
  not just trusting docs.
- `trashFile(fileId: string): Promise<void>` — `files.update({ fileId,
  requestBody: { trashed: true } })`. **Never `files.delete()`** — verified
  against Google's own docs: `files.delete()` is immediate and permanent,
  bypasses trash entirely, with no recovery. `trashed: true` gives the same
  30-day recovery window Drive's own web UI's delete button gives.
- `renameFile(fileId: string, newName: string): Promise<void>` —
  `files.update({ fileId, requestBody: { name: newName } })`
- `moveFile(fileId: string, newParentId: string, oldParentId: string):
  Promise<void>` — Drive API models "move" as adding the new parent and
  removing the old one on the same `files.update` call (`addParents`/
  `removeParents` query params) — verify this exact parameter shape against
  the live API during implementation (moving is not one of the facts
  independently re-verified in this design pass; it's a well-known pattern
  but wasn't checked against current docs the way delete/upload/auth were).
- `createFolder(name: string, parentFolderId: string): Promise<DriveFile>` —
  `files.create` with `mimeType: 'application/vnd.google-apps.folder'`
- `getThumbnail(fileId: string): Promise<{ stream: Readable; mimeType:
  string } | null>` — fetches the file's thumbnail bytes server-side (using
  the stored token) and streams them back through GameForge's own response,
  so thumbnails load reliably in the dashboard regardless of which Google
  account (if any) is logged into the viewer's own browser. Returns `null`
  for file types Drive doesn't generate a thumbnail for (the route falls
  back to a generic file-type icon, chosen client-side from the file's
  `mimeType`).

### API routes (all under `/api/drive/`, all require a valid GameForge
session per `getCurrentUser` — matches every other route in this app since
login/auth shipped)

- `GET /api/drive/connect` — redirect to Google's consent screen
- `GET /api/drive/callback` — OAuth redirect target, stores the refresh
  token, redirects to `/dashboard/settings/google-drive`
- `GET /api/drive/status` — `{ connected: boolean }`
- `GET /api/drive/files?folderId=X&q=search` — list
- `POST /api/drive/files` — upload (multipart form body: the file plus
  `parentFolderId`; Next.js Route Handlers read this via the standard
  `request.formData()` API, piping the resulting `Blob`'s stream straight
  into `DriveService.uploadFile` without buffering the whole file in
  memory first)
- `PATCH /api/drive/files/[id]` — body `{ name? }` (rename) and/or `{
  newParentId?, oldParentId? }` (move) — both can be set in one call
- `DELETE /api/drive/files/[id]` — trashes (see `trashFile` above; the verb
  is `DELETE` for a natural REST shape even though the underlying Drive
  call is an update, not a delete)
- `POST /api/drive/folders` — body `{ name, parentFolderId }`
- `GET /api/drive/files/[id]/thumbnail` — proxied thumbnail bytes

### Frontend: `app/dashboard/drive/page.tsx`

A file-manager page: breadcrumb trail (starting at "My Drive" =
`folderId=root`), a grid of files/folders (thumbnail or type-icon,
filename), and actions — upload, new folder, and per-item rename/move/trash
via a small action menu on each item. Live updates via polling: the page
re-fetches the current folder's listing every few seconds while it's the
active tab, reusing the existing `usePolling` hook
(`lib/hooks/usePolling.ts`) already used elsewhere in this app for job
status — same pattern, not a new mechanism. A search box maps directly to
the Drive API's own `q` parameter.

Opening a file (double-click, or an explicit "Open" action) links directly
to that file's Drive `webViewLink` in a new tab — this does **not** go
through GameForge's server; it uses the viewer's own ambient Google login in
their browser, since everyone already has direct Drive access. Only
thumbnails are proxied (for the reliability reason above); full file
content/viewing is not.

### "Share to Drive" on assets

The existing per-asset action area (theme asset detail page already has
Export buttons; this extends the pattern to all asset types) gets a "Share
to Drive" button. Clicking it opens a small folder-picker — the same
breadcrumb/grid browsing UI as the main Drive page, in a constrained modal,
letting the user navigate to and pick a destination folder — then uploads
that asset's stored file (whatever `storage/<images|themes|components>/`
file the asset already has) via the same `uploadFile` path as a generic
upload, just with the file source being GameForge's own storage instead of
a browser file picker.

## Testing approach

Matches this codebase's established pattern: real behavior over mocks where
practical. Drive API calls themselves cannot be tested against a real Drive
account in CI (no credentials to test with, and doing so would pollute a
real user's real Drive) — so `DriveService`'s Drive-API-calling methods are
tested with the `@googleapis/drive` client's request/response shape mocked
at the HTTP layer (not mocking `DriveService`'s own methods — mocking one
layer down, at the actual network boundary, so the real service logic
still runs). Route-level tests (auth requirement, request/response shaping,
error handling) follow the same `NextRequest`/session-cookie pattern this
session has used throughout. The OAuth token-exchange and refresh-token
storage/retrieval logic against the real `settings` table IS tested against
a real temporary SQLite database, matching this codebase's established
convention (no mocking the DB layer).

## Security note

The stored refresh token is a real, standing credential with full
read/write access to the connected Drive account — equivalent in
sensitivity to an API key. It lives in the `settings` table (plain SQLite,
same place this app already stores other config) — not git-synced (the
`settings` table was never part of `GitService`'s `DATA_DIRS` and this
spec doesn't change that), so it never leaves the machine it was connected
on. This matches this app's existing trust model (local-first, 2-3 trusted
people, already established for the login/auth feature) rather than
introducing a new one.
