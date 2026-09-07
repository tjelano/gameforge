# Google Drive Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full in-dashboard Google Drive file manager for GameForge — browse, upload, rename, move, delete-to-trash, and create folders against one already-shared Drive, plus a "Share to Drive" shortcut on individual assets.

**Architecture:** One `DriveService` wrapping the official `@googleapis/drive` client (auth via `google-auth-library`'s `OAuth2Client`, a single app-wide refresh token stored in the existing `settings` table). A set of thin `/api/drive/*` routes, each gated by the existing `getCurrentUser` session check. A `/dashboard/drive` page (breadcrumb navigation + grid + actions) using the existing `usePolling` hook for live refresh — no new sync mechanism.

**Tech Stack:** Next.js 16.3.4 (Route Handlers), `@googleapis/drive@22.0.0`, `google-auth-library@11.0.2`, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-google-drive-design.md`

## Global Constraints

- **Delete must use `files.update({ fileId, requestBody: { trashed: true } })`, never `files.delete()`.** Verified against Google's own docs: `files.delete()` is immediate and permanent with no recovery. This is a hard safety requirement, not a style preference.
- **Upload uses one code path for all file sizes** — a single `files.create` call with `media: { mimeType, body: <stream> }`. The client library handles resumable behavior transparently for large files (per the spec's research). No small-vs-large branching.
- **OAuth consent URL must include both `access_type: 'offline'` and `prompt: 'consent'`.** Omitting `prompt: 'consent'` on a re-authorization can silently return no refresh token, breaking reconnection.
- **`DriveService` reads/writes the stored refresh token via `settingsService.get`/`settingsService.set`** (existing service, `lib/services/SettingsService.ts`) — never raw SQL against the `settings` table. This matches the established convention (see `app/api/assets/[id]/edit/route.ts`'s use of `settingsService.get(ASEPRITE_PATH_SETTING_KEY)`).
- **Every `/api/drive/*` route requires a session.** Call `getCurrentUser(req)` (from `lib/utils/session.ts`) first; 401 `{ success: false, error: 'Not logged in' }` if null. Matches every route migrated in the login-auth feature.
- **No permission/sharing management, no embedding Google's own UI, no extra in-app permission layer, no true push-based real-time sync, no multi-select/bulk actions.** All explicitly out of scope per the spec.
- **AGENTS.md applies throughout**: flat procedural code, no wrapper classes/DTOs/factories, try/catch with `console.error` logging on every I/O call (Drive API calls count as I/O), disable UI buttons on submission.
- **List results are capped at Drive's own page-size maximum (1000) with no further pagination UI.** A personal, project-dedicated Drive is not expected to need more than one page per folder; if that assumption ever breaks, pagination is a real, separate follow-up — not built here.

---

### Task 1: Dependencies and config constants

**Files:**
- Modify: `package.json`
- Modify: `lib/config.ts`

**Interfaces:**
- Produces: `GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY` (string constant, exported from `lib/config.ts`), used by Task 2 and any route reading/writing the stored token.

- [ ] **Step 1: Add the two new dependencies**

In `package.json`'s `"dependencies"` object, add (alphabetically, matching the existing ordering):

```json
    "@googleapis/drive": "^22.0.0",
    "google-auth-library": "^11.0.2",
```

- [ ] **Step 2: Install**

Run: `npm install --ignore-scripts`
Expected: both packages appear in `node_modules`, `package-lock.json` updated.

- [ ] **Step 3: Add the settings-key constant**

Append to `lib/config.ts` (after the existing `ASEPRITE_PATH_SETTING_KEY` line):

```ts

// Settings-table key for the stored Google Drive OAuth refresh token.
// Shared between the OAuth callback route (writes it) and DriveService
// (reads it on every Drive API call).
export const GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY = 'google_drive_refresh_token';
```

- [ ] **Step 4: Run the full suite to confirm nothing broke**

Run: `npx vitest run`
Expected: all existing tests still pass (68 files, 365 tests — no new tests from this task, it's pure config)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/config.ts
git commit -m "chore: add Google Drive API dependencies and settings key"
```

---

### Task 2: `DriveService` — OAuth connection helpers

**Files:**
- Create: `lib/services/DriveService.ts`
- Test: `test/driveServiceAuth.test.ts`

**Interfaces:**
- Consumes: `settingsService.get`/`settingsService.set` (existing, `lib/services/SettingsService.ts`), `GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY` (Task 1).
- Produces: `driveService` singleton with `isConnected(): Promise<boolean>`, `getAuthUrl(): string`, `exchangeCodeForTokens(code: string): Promise<void>`. Also a private (not exported) `getAuthedClient(): Promise<OAuth2Client>` that every later Drive-calling method in this file uses — later tasks in this same file consume it directly, no re-import needed since it's the same module.

Mirrors the `PIXELLAB_API_KEY` lazy-getter pattern (`lib/services/ImageGenerator.ts:101-108`) for reading `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — read lazily inside functions, never at module-import time, so `next dev`'s `.env.local` loading order can't race module evaluation.

- [ ] **Step 1: Write the failing tests**

```ts
// test/driveServiceAuth.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-driveauth-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('driveService auth', () => {
  it('isConnected() is false when no refresh token is stored', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    expect(await driveService.isConnected()).toBe(false);
  });

  it('getAuthUrl() includes offline access and forces the consent prompt', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    const url = driveService.getAuthUrl();
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('scope=');
  });

  it('exchangeCodeForTokens() stores the refresh token, making isConnected() true', async () => {
    const { driveService } = await import('@/lib/services/DriveService');
    const { OAuth2Client } = await import('google-auth-library');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'a-real-looking-refresh-token', access_token: 'short-lived' },
      res: null,
    } as any);

    await driveService.exchangeCodeForTokens('fake-auth-code');
    expect(await driveService.isConnected()).toBe(true);

    const { settingsService } = await import('@/lib/services/SettingsService');
    const { GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY } = await import('@/lib/config');
    expect(await settingsService.get(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY)).toBe('a-real-looking-refresh-token');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveServiceAuth.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/DriveService'`

- [ ] **Step 3: Implement `DriveService.ts`'s auth section**

```ts
// lib/services/DriveService.ts
import { OAuth2Client } from 'google-auth-library';
import { settingsService } from '@/lib/services/SettingsService';
import { GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY } from '@/lib/config';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const REDIRECT_PATH = '/api/drive/callback';

function baseUrl(): string {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}

function newOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${baseUrl()}${REDIRECT_PATH}`
  );
}

class DriveServiceImpl {
  async isConnected(): Promise<boolean> {
    const token = await settingsService.get(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY);
    return !!token;
  }

  getAuthUrl(): string {
    const client = newOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [DRIVE_SCOPE],
    });
  }

  async exchangeCodeForTokens(code: string): Promise<void> {
    const client = newOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Reconnect and make sure to approve access when prompted.');
    }
    await settingsService.set(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY, tokens.refresh_token);
  }

  // Every Drive-API-calling method below (Tasks 3-6) calls this first.
  private async getAuthedClient(): Promise<OAuth2Client> {
    const refreshToken = await settingsService.get(GOOGLE_DRIVE_REFRESH_TOKEN_SETTING_KEY);
    if (!refreshToken) {
      throw new Error('Google Drive is not connected. Visit Settings > Google Drive to connect.');
    }
    const client = newOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }
}

export const driveService = new DriveServiceImpl();
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveServiceAuth.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/DriveService.ts test/driveServiceAuth.test.ts
git commit -m "feat: add DriveService OAuth connection helpers"
```

---

### Task 3: `DriveService.listFiles`

**Files:**
- Modify: `lib/services/DriveService.ts`
- Test: `test/driveServiceListFiles.test.ts`

**Interfaces:**
- Consumes: `getAuthedClient()` (Task 2, same file).
- Produces: `interface DriveFile { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; webViewLink?: string; iconLink?: string; parents?: string[]; }` (exported), `driveService.listFiles(folderId?: string, query?: string): Promise<DriveFile[]>` — `folderId` defaults to `'root'`. Later tasks (routes, frontend) use this exact `DriveFile` shape.

- [ ] **Step 1: Write the failing test**

Mock `@googleapis/drive`'s factory function at the module boundary — this is the pattern every later DriveService test in this plan reuses:

```ts
// test/driveServiceListFiles.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFilesList = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      list: mockFilesList,
    },
  }),
}));

vi.mock('@/lib/services/SettingsService', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('fake-refresh-token'),
    set: vi.fn(),
  },
}));

beforeEach(() => {
  mockFilesList.mockReset();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

describe('driveService.listFiles', () => {
  it('lists files in the given folder, defaulting to root', async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          { id: 'f1', name: 'sprite.png', mimeType: 'image/png', size: '1024', modifiedTime: '2026-09-07T00:00:00Z', webViewLink: 'https://drive.google.com/x', iconLink: 'https://icon', parents: ['root'] },
        ],
      },
    });

    const { driveService } = await import('@/lib/services/DriveService');
    const files = await driveService.listFiles();

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('sprite.png');
    expect(mockFilesList).toHaveBeenCalledWith(expect.objectContaining({
      q: "'root' in parents and trashed = false",
    }));
  });

  it('passes a search query combined with the folder filter', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [] } });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.listFiles('folder123', 'dungeon');

    expect(mockFilesList).toHaveBeenCalledWith(expect.objectContaining({
      q: "'folder123' in parents and trashed = false and name contains 'dungeon'",
    }));
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveServiceListFiles.test.ts`
Expected: FAIL — `driveService.listFiles is not a function`

- [ ] **Step 3: Add `listFiles` to `DriveService.ts`**

Add the import at the top of the file:

```ts
import { drive } from '@googleapis/drive';
```

Add above the `DriveServiceImpl` class:

```ts
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  parents?: string[];
}

const LIST_FIELDS = 'files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink, parents)';

// Escapes a single-quoted string for Drive's `q` query language — the only
// character that needs escaping inside a single-quoted q-string is the
// single quote itself, per Drive API's search-query syntax.
function escapeDriveQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}
```

Add inside `DriveServiceImpl`:

```ts
  async listFiles(folderId: string = 'root', query?: string): Promise<DriveFile[]> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      let q = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
      if (query && query.trim()) {
        q += ` and name contains '${escapeDriveQueryValue(query.trim())}'`;
      }
      const res = await client.files.list({
        q,
        fields: LIST_FIELDS,
        pageSize: 1000,
        orderBy: 'folder,name',
      });
      return (res.data.files ?? []) as DriveFile[];
    } catch (e) {
      console.error(`Failed to list Drive files for folder ${folderId}:`, e);
      throw e;
    }
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveServiceListFiles.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/DriveService.ts test/driveServiceListFiles.test.ts
git commit -m "feat: add DriveService.listFiles"
```

---

### Task 4: `DriveService.uploadFile`

**Files:**
- Modify: `lib/services/DriveService.ts`
- Test: `test/driveServiceUpload.test.ts`

**Interfaces:**
- Consumes: `getAuthedClient()` (Task 2), `DriveFile` (Task 3).
- Produces: `driveService.uploadFile(params: { name: string; mimeType: string; stream: Readable; parentFolderId: string }): Promise<DriveFile>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/driveServiceUpload.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

const mockFilesCreate = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      create: mockFilesCreate,
    },
  }),
}));

vi.mock('@/lib/services/SettingsService', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('fake-refresh-token'),
    set: vi.fn(),
  },
}));

beforeEach(() => {
  mockFilesCreate.mockReset();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

describe('driveService.uploadFile', () => {
  it('creates a file with the given name, mimeType, and parent folder', async () => {
    mockFilesCreate.mockResolvedValue({
      data: { id: 'newfile1', name: 'sprite.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' },
    });

    const { driveService } = await import('@/lib/services/DriveService');
    const stream = Readable.from([Buffer.from('fake image bytes')]);
    const result = await driveService.uploadFile({
      name: 'sprite.png',
      mimeType: 'image/png',
      stream,
      parentFolderId: 'folder123',
    });

    expect(result.id).toBe('newfile1');
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { name: 'sprite.png', parents: ['folder123'] },
      media: { mimeType: 'image/png', body: stream },
    }), expect.anything());
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveServiceUpload.test.ts`
Expected: FAIL — `driveService.uploadFile is not a function`

- [ ] **Step 3: Add `uploadFile` to `DriveService.ts`**

Add the import at the top of the file:

```ts
import type { Readable } from 'stream';
```

Add inside `DriveServiceImpl`, after `listFiles`:

```ts
  async uploadFile(params: { name: string; mimeType: string; stream: Readable; parentFolderId: string }): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.create({
        requestBody: { name: params.name, parents: [params.parentFolderId] },
        media: { mimeType: params.mimeType, body: params.stream },
      }, {
        fields: LIST_FIELDS.replace('files(', '').replace(')', ''),
      });
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to upload ${params.name} to Drive:`, e);
      throw e;
    }
  }
```

(The second `files.create` argument's `fields` option controls which fields come back on the CREATED file's metadata — reuses the same field list as `listFiles`, stripped of the `files(...)` wrapper since a single-item response isn't wrapped in a `files` array the way a list response is.)

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveServiceUpload.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add lib/services/DriveService.ts test/driveServiceUpload.test.ts
git commit -m "feat: add DriveService.uploadFile"
```

---

### Task 5: `DriveService.trashFile`, `renameFile`, `moveFile`, `createFolder`

**Files:**
- Modify: `lib/services/DriveService.ts`
- Test: `test/driveServiceMutations.test.ts`

**Interfaces:**
- Consumes: `getAuthedClient()` (Task 2), `DriveFile` (Task 3).
- Produces: `driveService.trashFile(fileId: string): Promise<void>`, `driveService.renameFile(fileId: string, newName: string): Promise<DriveFile>`, `driveService.moveFile(fileId: string, newParentId: string, oldParentId: string): Promise<DriveFile>`, `driveService.createFolder(name: string, parentFolderId: string): Promise<DriveFile>`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/driveServiceMutations.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFilesUpdate = vi.fn();
const mockFilesCreate = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      update: mockFilesUpdate,
      create: mockFilesCreate,
    },
  }),
}));

vi.mock('@/lib/services/SettingsService', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('fake-refresh-token'),
    set: vi.fn(),
  },
}));

beforeEach(() => {
  mockFilesUpdate.mockReset();
  mockFilesCreate.mockReset();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

describe('driveService mutations', () => {
  it('trashFile sets trashed:true via files.update — never calls a delete method', async () => {
    mockFilesUpdate.mockResolvedValue({ data: {} });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.trashFile('file1');

    expect(mockFilesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file1',
      requestBody: { trashed: true },
    }));
  });

  it('renameFile updates the name field', async () => {
    mockFilesUpdate.mockResolvedValue({ data: { id: 'file1', name: 'new-name.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' } });
    const { driveService } = await import('@/lib/services/DriveService');
    const result = await driveService.renameFile('file1', 'new-name.png');

    expect(result.name).toBe('new-name.png');
    expect(mockFilesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file1',
      requestBody: { name: 'new-name.png' },
    }));
  });

  it('moveFile adds the new parent and removes the old one in one call', async () => {
    mockFilesUpdate.mockResolvedValue({ data: { id: 'file1', name: 'x.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' } });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.moveFile('file1', 'newFolder', 'oldFolder');

    expect(mockFilesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file1',
      addParents: 'newFolder',
      removeParents: 'oldFolder',
    }));
  });

  it('createFolder creates a folder-mimeType file', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'newfolder1', name: 'Sprites', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-09-07T00:00:00Z' } });
    const { driveService } = await import('@/lib/services/DriveService');
    const result = await driveService.createFolder('Sprites', 'root');

    expect(result.name).toBe('Sprites');
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { name: 'Sprites', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    }), expect.anything());
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveServiceMutations.test.ts`
Expected: FAIL — none of these 4 methods exist yet

- [ ] **Step 3: Add the four methods to `DriveService.ts`**

Add inside `DriveServiceImpl`, after `uploadFile`. `FILE_FIELDS` below is the same single-item field list already used in Task 4's `uploadFile` — extract it as a shared constant so it's not duplicated a third time:

Add near `LIST_FIELDS` (top of file, alongside the other module-level constants):

```ts
const FILE_FIELDS = 'id, name, mimeType, size, modifiedTime, webViewLink, iconLink, parents';
```

Then update Task 4's `uploadFile` call to use it instead of the inline `.replace(...)` expression:

```ts
      }, {
        fields: FILE_FIELDS,
      });
```

Now add the four new methods:

```ts
  // Moves to Trash — recoverable for 30 days, matching Drive's own web UI
  // delete button. Never calls files.delete(), which is immediate and
  // permanent with no recovery — see this plan's Global Constraints.
  async trashFile(fileId: string): Promise<void> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      await client.files.update({ fileId, requestBody: { trashed: true } });
    } catch (e) {
      console.error(`Failed to trash Drive file ${fileId}:`, e);
      throw e;
    }
  }

  async renameFile(fileId: string, newName: string): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.update(
        { fileId, requestBody: { name: newName } },
        { fields: FILE_FIELDS }
      );
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to rename Drive file ${fileId}:`, e);
      throw e;
    }
  }

  async moveFile(fileId: string, newParentId: string, oldParentId: string): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.update(
        { fileId, addParents: newParentId, removeParents: oldParentId, requestBody: {} },
        { fields: FILE_FIELDS }
      );
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to move Drive file ${fileId}:`, e);
      throw e;
    }
  }

  async createFolder(name: string, parentFolderId: string): Promise<DriveFile> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const res = await client.files.create(
        { requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] } },
        { fields: FILE_FIELDS }
      );
      return res.data as DriveFile;
    } catch (e) {
      console.error(`Failed to create Drive folder ${name}:`, e);
      throw e;
    }
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveServiceMutations.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite (confirm Task 4's refactor to `FILE_FIELDS` didn't break its own test)**

Run: `npx vitest run test/driveServiceUpload.test.ts test/driveServiceMutations.test.ts`
Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add lib/services/DriveService.ts test/driveServiceMutations.test.ts
git commit -m "feat: add DriveService trash/rename/move/createFolder"
```

**Note for the implementer:** `moveFile`'s `addParents`/`removeParents` parameter shape is a well-known Drive API v3 pattern but was NOT independently re-verified against live docs during this plan's own research (unlike delete/upload/auth, which were). If a real Drive account is available during implementation, do a live sanity-check moving a real test file between two real folders before considering this method done — don't just trust the mocked test passing.

---

### Task 6: `DriveService.getThumbnail`

**Files:**
- Modify: `lib/services/DriveService.ts`
- Test: `test/driveServiceThumbnail.test.ts`

**Interfaces:**
- Consumes: `getAuthedClient()` (Task 2).
- Produces: `driveService.getThumbnail(fileId: string): Promise<{ stream: Readable; mimeType: string } | null>`.

Drive's `files.get` with `alt: 'media'` streams a file's actual content; for a thumbnail specifically, the file's own metadata `thumbnailLink` field is a URL that itself requires the SAME OAuth bearer token to fetch (it is not a public URL). Fetch it directly with the access token from the authed client rather than through the `@googleapis/drive` client (which has no dedicated "get thumbnail" method — `thumbnailLink` is just a URL on the file resource).

- [ ] **Step 1: Write the failing tests**

```ts
// test/driveServiceThumbnail.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFilesGet = vi.fn();
const mockFetch = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      get: mockFilesGet,
    },
  }),
}));

vi.mock('@/lib/services/SettingsService', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('fake-refresh-token'),
    set: vi.fn(),
  },
}));

beforeEach(() => {
  mockFilesGet.mockReset();
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

describe('driveService.getThumbnail', () => {
  it('returns null when the file has no thumbnailLink', async () => {
    mockFilesGet.mockResolvedValue({ data: {} });
    const { driveService } = await import('@/lib/services/DriveService');
    expect(await driveService.getThumbnail('file1')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches the thumbnail with an Authorization header when thumbnailLink exists', async () => {
    mockFilesGet.mockResolvedValue({ data: { thumbnailLink: 'https://drive.example/thumb' } });
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]) as any,
      body: new ReadableStream(),
    });
    const { driveService } = await import('@/lib/services/DriveService');
    const result = await driveService.getThumbnail('file1');

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/jpeg');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://drive.example/thumb',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer ') }) })
    );
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveServiceThumbnail.test.ts`
Expected: FAIL — `driveService.getThumbnail is not a function`

- [ ] **Step 3: Add `getThumbnail` to `DriveService.ts`**

Add the import at the top of the file:

```ts
import { Readable } from 'stream';
```

(This changes the earlier `import type { Readable } from 'stream';` from Task 4 to a real, non-type-only import, since this task needs `Readable.fromWeb` as a runtime value, not just a type. Replace that line rather than adding a second one.)

Add inside `DriveServiceImpl`, after `createFolder`:

```ts
  async getThumbnail(fileId: string): Promise<{ stream: Readable; mimeType: string } | null> {
    try {
      const auth = await this.getAuthedClient();
      const client = drive({ version: 'v3', auth });
      const meta = await client.files.get({ fileId, fields: 'thumbnailLink' });
      const thumbnailLink = meta.data.thumbnailLink;
      if (!thumbnailLink) return null;

      const accessToken = (await auth.getAccessToken()).token;
      const res = await fetch(thumbnailLink, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok || !res.body) return null;

      return {
        stream: Readable.fromWeb(res.body as any),
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    } catch (e) {
      console.error(`Failed to fetch thumbnail for Drive file ${fileId}:`, e);
      return null;
    }
  }
```

(Failures here return `null` rather than throwing — a missing thumbnail is a normal, expected case the caller falls back on, not an error condition worth propagating.)

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveServiceThumbnail.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full DriveService test suite together**

Run: `npx vitest run test/driveServiceAuth.test.ts test/driveServiceListFiles.test.ts test/driveServiceUpload.test.ts test/driveServiceMutations.test.ts test/driveServiceThumbnail.test.ts`
Expected: all passing (12 tests total)

- [ ] **Step 6: Commit**

```bash
git add lib/services/DriveService.ts test/driveServiceThumbnail.test.ts
git commit -m "feat: add DriveService.getThumbnail"
```

---

### Task 7: Auth routes — `/api/drive/connect`, `/api/drive/callback`, `/api/drive/status`

**Files:**
- Create: `app/api/drive/connect/route.ts`
- Create: `app/api/drive/callback/route.ts`
- Create: `app/api/drive/status/route.ts`
- Test: `test/driveAuthRoutes.test.ts`

**Interfaces:**
- Consumes: `driveService.getAuthUrl`, `driveService.exchangeCodeForTokens`, `driveService.isConnected` (Task 2); `getCurrentUser` (existing, `lib/utils/session.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/driveAuthRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from './helpers/testSession';

let tempRoot: string;
let cookieHeader: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-driveauthroutes-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
  ({ cookieHeader } = await seedSession());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET /api/drive/connect', () => {
  it('redirects to a Google consent URL', async () => {
    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('accounts.google.com');
  });

  it('401s when not logged in', async () => {
    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/drive/status', () => {
  it('reports not connected before any token is stored', async () => {
    const { GET } = await import('@/app/api/drive/status/route');
    const req = new NextRequest('http://localhost/api/drive/status', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    const body = await res.json();
    expect(body.data.connected).toBe(false);
  });
});

describe('GET /api/drive/callback', () => {
  it('exchanges the code, stores the token, and redirects to the settings page', async () => {
    const { OAuth2Client } = await import('google-auth-library');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'a-real-looking-refresh-token' },
      res: null,
    } as any);

    const { GET } = await import('@/app/api/drive/callback/route');
    const req = new NextRequest('http://localhost/api/drive/callback?code=fake-code', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard/settings/google-drive');

    const { driveService } = await import('@/lib/services/DriveService');
    expect(await driveService.isConnected()).toBe(true);
  });

  it('redirects with an error indicator if no code is present', async () => {
    const { GET } = await import('@/app/api/drive/callback/route');
    const req = new NextRequest('http://localhost/api/drive/callback', { headers: { Cookie: cookieHeader } });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveAuthRoutes.test.ts`
Expected: FAIL — none of the three route modules exist yet

- [ ] **Step 3: Implement the three routes**

```ts
// app/api/drive/connect/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }
  return NextResponse.redirect(driveService.getAuthUrl());
}
```

```ts
// app/api/drive/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const code = req.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=missing_code', req.url));
  }

  try {
    await driveService.exchangeCodeForTokens(code);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive', req.url));
  } catch (e: any) {
    console.error('Failed to exchange Google Drive OAuth code:', e);
    return NextResponse.redirect(new URL(`/dashboard/settings/google-drive?error=${encodeURIComponent(e.message)}`, req.url));
  }
}
```

```ts
// app/api/drive/status/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }
  const connected = await driveService.isConnected();
  return NextResponse.json({ success: true, data: { connected } });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveAuthRoutes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/drive/connect app/api/drive/callback app/api/drive/status test/driveAuthRoutes.test.ts
git commit -m "feat: add Google Drive connect/callback/status routes"
```

---

### Task 8: `GET /api/drive/files` (list route)

**Files:**
- Create: `app/api/drive/files/route.ts` (GET handler only — Task 9 adds POST to the same file)
- Test: `test/driveFilesListRoute.test.ts`

**Interfaces:**
- Consumes: `driveService.listFiles` (Task 3), `getCurrentUser`.
- Produces: `GET /api/drive/files?folderId=&q=` → `{ success: true, data: DriveFile[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/driveFilesListRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    listFiles: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('GET /api/drive/files', () => {
  it('lists files for the requested folder and query', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.listFiles).mockResolvedValue([
      { id: 'f1', name: 'sprite.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' },
    ]);

    const { GET } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files?folderId=folder1&q=sprite');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(driveService.listFiles).toHaveBeenCalledWith('folder1', 'sprite');
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveFilesListRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/drive/files/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/drive/files/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const folderId = req.nextUrl.searchParams.get('folderId') ?? undefined;
    const q = req.nextUrl.searchParams.get('q') ?? undefined;
    const files = await driveService.listFiles(folderId, q);
    return NextResponse.json({ success: true, data: files });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveFilesListRoute.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/drive/files/route.ts test/driveFilesListRoute.test.ts
git commit -m "feat: add GET /api/drive/files"
```

---

### Task 9: `POST /api/drive/files` (upload route)

**Files:**
- Modify: `app/api/drive/files/route.ts` (add POST alongside Task 8's GET)
- Test: `test/driveFilesUploadRoute.test.ts`

**Interfaces:**
- Consumes: `driveService.uploadFile` (Task 4), `getCurrentUser`.
- Produces: `POST /api/drive/files` — multipart form body (`file`, `parentFolderId`) → `{ success: true, data: DriveFile }`.

Verified against the current installed Next.js docs (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, "Request Body FormData" section): `request.formData()` is the real, current API for reading a multipart body in a Route Handler, returning the standard Web `FormData`. A file field comes back as a Web `File`/`Blob`; convert its `.stream()` (a Web `ReadableStream`) to a Node `Readable` via `Readable.fromWeb()` (stable Node API, this project targets a modern Node per its `@types/node: ^24.0.0`) before handing it to `DriveService.uploadFile`, which expects a Node stream.

- [ ] **Step 1: Write the failing test**

```ts
// test/driveFilesUploadRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('POST /api/drive/files', () => {
  it('uploads the given file to the given parent folder', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.uploadFile).mockResolvedValue({
      id: 'newfile1', name: 'test.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z',
    });

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'test.png');
    formData.append('parentFolderId', 'folder1');

    const { POST } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files', { method: 'POST', body: formData });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe('newfile1');
    expect(driveService.uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'test.png',
      mimeType: 'image/png',
      parentFolderId: 'folder1',
    }));
  });

  it('returns 400 when no file is provided', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);

    const formData = new FormData();
    formData.append('parentFolderId', 'folder1');

    const { POST } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files', { method: 'POST', body: formData });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files', { method: 'POST', body: new FormData() });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveFilesUploadRoute.test.ts`
Expected: FAIL — no `POST` export in the route module yet

- [ ] **Step 3: Add `POST` to `app/api/drive/files/route.ts`**

Add the import at the top:

```ts
import { Readable } from 'stream';
```

Append after the existing `GET` function:

```ts
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const parentFolderId = formData.get('parentFolderId');

    if (!(file instanceof Blob) || typeof parentFolderId !== 'string' || !parentFolderId) {
      return NextResponse.json({ success: false, error: 'A file and parentFolderId are required.' }, { status: 400 });
    }

    const name = file instanceof File ? file.name : 'upload';
    const stream = Readable.fromWeb(file.stream() as any);
    const uploaded = await driveService.uploadFile({
      name,
      mimeType: file.type || 'application/octet-stream',
      stream,
      parentFolderId,
    });
    return NextResponse.json({ success: true, data: uploaded });
  } catch (error: any) {
    console.error('Failed to upload file to Drive:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveFilesUploadRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run both route test files together (confirm GET from Task 8 still works with POST added to the same file)**

Run: `npx vitest run test/driveFilesListRoute.test.ts test/driveFilesUploadRoute.test.ts`
Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add app/api/drive/files/route.ts test/driveFilesUploadRoute.test.ts
git commit -m "feat: add POST /api/drive/files (upload)"
```

---

### Task 10: `PATCH` and `DELETE /api/drive/files/[id]`

**Files:**
- Create: `app/api/drive/files/[id]/route.ts`
- Test: `test/driveFileItemRoute.test.ts`

**Interfaces:**
- Consumes: `driveService.renameFile`, `driveService.moveFile`, `driveService.trashFile` (Task 5), `getCurrentUser`.
- Produces: `PATCH /api/drive/files/[id]` (body `{ name?: string; newParentId?: string; oldParentId?: string }`), `DELETE /api/drive/files/[id]` → trashes.

- [ ] **Step 1: Write the failing tests**

```ts
// test/driveFileItemRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    renameFile: vi.fn(),
    moveFile: vi.fn(),
    trashFile: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

function withAuth() {
  return import('@/lib/utils/session').then(({ getCurrentUser }) => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
  });
}

describe('PATCH /api/drive/files/[id]', () => {
  it('renames when name is given', async () => {
    await withAuth();
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.renameFile).mockResolvedValue({ id: 'f1', name: 'renamed.png', mimeType: 'image/png', modifiedTime: 'x' });

    const { PATCH } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed.png' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'f1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('renamed.png');
    expect(driveService.renameFile).toHaveBeenCalledWith('f1', 'renamed.png');
  });

  it('moves when newParentId/oldParentId are given', async () => {
    await withAuth();
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.moveFile).mockResolvedValue({ id: 'f1', name: 'x.png', mimeType: 'image/png', modifiedTime: 'x' });

    const { PATCH } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newParentId: 'folderB', oldParentId: 'folderA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'f1' }) });

    expect(res.status).toBe(200);
    expect(driveService.moveFile).toHaveBeenCalledWith('f1', 'folderB', 'folderA');
  });

  it('returns 400 when neither a name nor a full move pair is given', async () => {
    await withAuth();
    const { PATCH } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/drive/files/[id]', () => {
  it('trashes the file', async () => {
    await withAuth();
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.trashFile).mockResolvedValue(undefined);

    const { DELETE } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'f1' }) });

    expect(res.status).toBe(200);
    expect(driveService.trashFile).toHaveBeenCalledWith('f1');
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { DELETE } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveFileItemRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/drive/files/[id]/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/drive/files/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  newParentId: z.string().min(1).optional(),
  oldParentId: z.string().min(1).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = PatchSchema.parse(await req.json());

    if (input.name) {
      const result = await driveService.renameFile(id, input.name);
      return NextResponse.json({ success: true, data: result });
    }

    if (input.newParentId && input.oldParentId) {
      const result = await driveService.moveFile(id, input.newParentId, input.oldParentId);
      return NextResponse.json({ success: true, data: result });
    }

    return NextResponse.json({
      success: false,
      error: 'Provide either name (to rename) or both newParentId and oldParentId (to move).',
    }, { status: 400 });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    await driveService.trashFile(id);
    return NextResponse.json({ success: true, data: { id } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveFileItemRoute.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add "app/api/drive/files/[id]/route.ts" test/driveFileItemRoute.test.ts
git commit -m "feat: add PATCH/DELETE /api/drive/files/[id]"
```

---

### Task 11: `POST /api/drive/folders`

**Files:**
- Create: `app/api/drive/folders/route.ts`
- Test: `test/driveFoldersRoute.test.ts`

**Interfaces:**
- Consumes: `driveService.createFolder` (Task 5), `getCurrentUser`.
- Produces: `POST /api/drive/folders` (body `{ name: string; parentFolderId: string }`) → `{ success: true, data: DriveFile }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/driveFoldersRoute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    createFolder: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/drive/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/drive/folders', () => {
  it('creates a folder', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.createFolder).mockResolvedValue({
      id: 'newfolder1', name: 'Sprites', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-09-07T00:00:00Z',
    });

    const { POST } = await import('@/app/api/drive/folders/route');
    const res = await POST(postRequest({ name: 'Sprites', parentFolderId: 'root' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Sprites');
    expect(driveService.createFolder).toHaveBeenCalledWith('Sprites', 'root');
  });

  it('returns 400 for a malformed body', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);

    const { POST } = await import('@/app/api/drive/folders/route');
    const res = await POST(postRequest({ name: '' }));
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/drive/folders/route');
    const res = await POST(postRequest({ name: 'Sprites', parentFolderId: 'root' }));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveFoldersRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/drive/folders/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/drive/folders/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const CreateFolderSchema = z.object({
  name: z.string().min(1),
  parentFolderId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = CreateFolderSchema.parse(await req.json());
    const folder = await driveService.createFolder(input.name, input.parentFolderId);
    return NextResponse.json({ success: true, data: folder });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveFoldersRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/drive/folders/route.ts test/driveFoldersRoute.test.ts
git commit -m "feat: add POST /api/drive/folders"
```

---

### Task 12: `GET /api/drive/files/[id]/thumbnail`

**Files:**
- Create: `app/api/drive/files/[id]/thumbnail/route.ts`
- Test: `test/driveThumbnailRoute.test.ts`

**Interfaces:**
- Consumes: `driveService.getThumbnail` (Task 6), `getCurrentUser`.
- Produces: `GET /api/drive/files/[id]/thumbnail` — streams the thumbnail bytes with the real `Content-Type`, or 404 if none exists.

- [ ] **Step 1: Write the failing tests**

```ts
// test/driveThumbnailRoute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    getThumbnail: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('GET /api/drive/files/[id]/thumbnail', () => {
  it('streams the thumbnail with its real content type', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.getThumbnail).mockResolvedValue({
      stream: Readable.from([Buffer.from('fake jpeg bytes')]),
      mimeType: 'image/jpeg',
    });

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('returns 404 when there is no thumbnail', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.getThumbnail).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(404);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/driveThumbnailRoute.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/drive/files/[id]/thumbnail/route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/drive/files/[id]/thumbnail/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const { id } = await params;
  const thumbnail = await driveService.getThumbnail(id);
  if (!thumbnail) {
    return NextResponse.json({ success: false, error: 'No thumbnail available' }, { status: 404 });
  }

  return new NextResponse(Readable.toWeb(thumbnail.stream) as any, {
    headers: { 'Content-Type': thumbnail.mimeType },
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/driveThumbnailRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run every DriveService + Drive route test file together**

Run: `npx vitest run test/driveServiceAuth.test.ts test/driveServiceListFiles.test.ts test/driveServiceUpload.test.ts test/driveServiceMutations.test.ts test/driveServiceThumbnail.test.ts test/driveAuthRoutes.test.ts test/driveFilesListRoute.test.ts test/driveFilesUploadRoute.test.ts test/driveFileItemRoute.test.ts test/driveFoldersRoute.test.ts test/driveThumbnailRoute.test.ts`
Expected: all passing (this is every backend piece of the feature — confirm it's solid before starting the frontend)

- [ ] **Step 6: Commit**

```bash
git add "app/api/drive/files/[id]/thumbnail/route.ts" test/driveThumbnailRoute.test.ts
git commit -m "feat: add GET /api/drive/files/[id]/thumbnail"
```

---

### Task 13: Settings page — `app/dashboard/settings/google-drive/page.tsx`

**Files:**
- Create: `app/dashboard/settings/google-drive/page.tsx`

**Interfaces:**
- Consumes: `GET /api/drive/status` (Task 7), `GET /api/drive/connect` (Task 7, navigated to directly, not fetched).

Mirrors `app/dashboard/settings/aseprite/page.tsx`'s load-on-mount pattern, adapted: no save button, just a status line and a Connect/Reconnect link (a real `<a href="/api/drive/connect">`, not a fetch — clicking it needs a full page navigation so the browser follows the redirect to Google's consent screen).

- [ ] **Step 1: Implement the page**

```tsx
// app/dashboard/settings/google-drive/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

export default function GoogleDriveSettingsPage() {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/drive/status');
        const body = await res.json();
        if (!ignore && body.success) setConnected(body.data.connected);
      } catch {
        if (!ignore) setConnected(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <>
      <h1 className="page-title">Google Drive</h1>
      <p className="page-subtitle">
        Connect the Google account that owns the shared Drive — everyone using GameForge browses
        and shares through this one connection.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        {connected === null ? (
          <p className="page-subtitle">Loading…</p>
        ) : (
          <>
            <p style={{ marginBottom: 12 }}>
              Status: {connected ? 'Connected' : 'Not connected'}
            </p>
            <a className="btn btn-primary" href="/api/drive/connect">
              {connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
            </a>
          </>
        )}
        {oauthError && (
          <p style={{ marginTop: 14, fontSize: 13, color: 'var(--reject)' }}>
            Connection failed: {oauthError}
          </p>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: all passing (this task adds no new automated tests — a thin status/link page over already-tested routes, matching this codebase's convention of not unit-testing purely presentational pages)

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/settings/google-drive/page.tsx
git commit -m "feat: add Google Drive settings page"
```

---

### Task 14: `/dashboard/drive` page — core navigation and listing

**Files:**
- Create: `app/dashboard/drive/DriveBrowser.tsx` (the reusable browsing component — Task 15 adds actions to it, and Task 16 reuses it inside a modal for the "Share to Drive" folder picker)
- Create: `app/dashboard/drive/page.tsx` (thin wrapper rendering `DriveBrowser` full-page)

**Interfaces:**
- Consumes: `GET /api/drive/files` (Task 8), `DriveFile` type (Task 3 — re-declare the same shape client-side since this is a Client Component and can't import a server-only-adjacent type across that boundary the same way; keep the field list identical), `usePolling` (existing, `lib/hooks/usePolling.ts`).
- Produces: `DriveBrowser` component with props `{ onOpenFolder?: (folder: DriveFile) => void }` (Task 16's folder-picker modal reuses this same component, so it needs to know when navigation happens even without a "select" action of its own yet — Task 16 adds the actual pick/select behavior on top). Internal state: `currentFolderId`, `breadcrumb: DriveFile[]`, `items: DriveFile[]`, `searchQuery`.

This is the browsing shell only — no upload/rename/move/trash/new-folder actions yet (Task 15 adds those to the same component). Polling: every 4 seconds, matching the existing job-status polling interval convention already used elsewhere in this app (`usePolling(callback, 2000)` is used for jobs; Drive listing is a slower-changing, less time-critical view, so a longer interval is reasonable — pick 4000ms).

- [ ] **Step 1: Implement `DriveBrowser.tsx`**

```tsx
// app/dashboard/drive/DriveBrowser.tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePolling } from '@/lib/hooks/usePolling';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  parents?: string[];
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function DriveBrowser({ onFolderChange }: { onFolderChange?: (folderId: string) => void }) {
  const [currentFolderId, setCurrentFolderId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [items, setItems] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams({ folderId: currentFolderId });
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      const res = await fetch(`/api/drive/files?${params.toString()}`);
      const body = await res.json();
      if (body.success) {
        setItems(body.data);
        setError(null);
      } else {
        setError(body.error ?? 'Could not load this folder.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, searchQuery]);

  usePolling(fetchItems, 4000);

  useEffect(() => {
    onFolderChange?.(currentFolderId);
  }, [currentFolderId, onFolderChange]);

  function openFolder(folder: DriveFile) {
    setCurrentFolderId(folder.id);
    setBreadcrumb([...breadcrumb, { id: folder.id, name: folder.name }]);
    setLoading(true);
  }

  function goToBreadcrumb(index: number) {
    const target = breadcrumb[index];
    setCurrentFolderId(target.id);
    setBreadcrumb(breadcrumb.slice(0, index + 1));
    setLoading(true);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {breadcrumb.map((crumb, i) => (
          <span key={crumb.id}>
            {i > 0 && <span style={{ margin: '0 4px', color: 'var(--ink-dim)' }}>/</span>}
            <button
              className="btn"
              style={{ padding: '2px 8px', fontSize: 13 }}
              onClick={() => goToBreadcrumb(i)}
              disabled={i === breadcrumb.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <input
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        placeholder="Search this folder…"
        style={{ marginBottom: 12, width: '100%', maxWidth: 320 }}
      />

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {loading && items.length === 0 ? (
        <p className="page-subtitle">Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {items.map(item => {
            const isFolder = item.mimeType === FOLDER_MIME;
            return (
              <div key={item.id} className="card" style={{ padding: 10, cursor: isFolder ? 'pointer' : 'default' }} onClick={() => isFolder && openFolder(item)}>
                {!isFolder && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/drive/files/${item.id}/thumbnail`}
                    alt=""
                    style={{ width: '100%', height: 80, objectFit: 'cover', marginBottom: 6, borderRadius: 'var(--radius)' }}
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{isFolder ? '📁 ' : ''}{item.name}</div>
                {!isFolder && item.webViewLink && (
                  <a href={item.webViewLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }} onClick={e => e.stopPropagation()}>
                    Open
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Implement the page wrapper**

```tsx
// app/dashboard/drive/page.tsx
import { DriveBrowser } from './DriveBrowser';

export default function DrivePage() {
  return (
    <>
      <h1 className="page-title">Drive</h1>
      <p className="page-subtitle">Browse, upload, and organize files in your shared Drive without leaving GameForge.</p>
      <DriveBrowser />
    </>
  );
}
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all passing, clean (no new automated tests for this task — a client component with fetch/render logic and no dedicated unit test, matching this codebase's convention for similar pages like `JobCard`/`AssetCard`)

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/drive/DriveBrowser.tsx app/dashboard/drive/page.tsx
git commit -m "feat: add Drive browser page (navigation + listing)"
```

---

### Task 15: `/dashboard/drive` page — actions (upload, new folder, rename, move, trash)

**Files:**
- Modify: `app/dashboard/drive/DriveBrowser.tsx`

**Interfaces:**
- Consumes: `POST /api/drive/files` (Task 9), `PATCH`/`DELETE /api/drive/files/[id]` (Task 10), `POST /api/drive/folders` (Task 11).

Adds an upload button (hidden `<input type="file">` triggered by a visible button, matching how file inputs are conventionally wired in this kind of UI since a bare file input can't be styled consistently), a "New folder" button (prompts for a name via a small inline form, not a browser `prompt()` — matches this app's established pattern of using `<input>` fields rather than native dialogs, seen throughout e.g. `StylesPage`'s create-style form), and a per-item action menu (rename, move, trash) shown on hover/click.

For "move," reuse `DriveBrowser` itself inside a modal as the destination picker — pass a new prop `selectMode` that, when set, renders a "Move here" button in the breadcrumb area instead of normal browsing, and calls back with the currently-viewed folder's id when clicked.

- [ ] **Step 1: Extend `DriveBrowser.tsx` with actions**

Replace the full file with this extended version (adds upload, new-folder, and per-item rename/move/trash on top of Task 14's browsing shell — every new piece of state and every new handler is additive to what Task 14 already has, nothing from Task 14 is removed):

```tsx
// app/dashboard/drive/DriveBrowser.tsx
'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePolling } from '@/lib/hooks/usePolling';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  parents?: string[];
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function DriveBrowser({
  onFolderChange,
  selectMode,
  onSelectFolder,
}: {
  onFolderChange?: (folderId: string) => void;
  selectMode?: boolean;
  onSelectFolder?: (folderId: string, folderName: string) => void;
}) {
  const [currentFolderId, setCurrentFolderId] = useState('root');
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [items, setItems] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderForm, setShowNewFolderForm] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [movingItem, setMovingItem] = useState<DriveFile | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchItems = useCallback(async () => {
    try {
      const params = new URLSearchParams({ folderId: currentFolderId });
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      const res = await fetch(`/api/drive/files?${params.toString()}`);
      const body = await res.json();
      if (body.success) {
        setItems(body.data);
        setError(null);
      } else {
        setError(body.error ?? 'Could not load this folder.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, searchQuery]);

  usePolling(fetchItems, 4000);

  useEffect(() => {
    onFolderChange?.(currentFolderId);
  }, [currentFolderId, onFolderChange]);

  function openFolder(folder: DriveFile) {
    setCurrentFolderId(folder.id);
    setBreadcrumb([...breadcrumb, { id: folder.id, name: folder.name }]);
    setLoading(true);
  }

  function goToBreadcrumb(index: number) {
    const target = breadcrumb[index];
    setCurrentFolderId(target.id);
    setBreadcrumb(breadcrumb.slice(0, index + 1));
    setLoading(true);
  }

  async function handleUploadChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('parentFolderId', currentFolderId);
      const res = await fetch('/api/drive/files', { method: 'POST', body: formData });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Upload failed.');
      } else {
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setUploading(false);
    }
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!newFolderName.trim() || creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const res = await fetch('/api/drive/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim(), parentFolderId: currentFolderId }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not create folder.');
      } else {
        setNewFolderName('');
        setShowNewFolderForm(false);
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleRename(itemId: string) {
    if (!renameValue.trim() || busyItemId) return;
    setBusyItemId(itemId);
    setError(null);
    try {
      const res = await fetch(`/api/drive/files/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Rename failed.');
      } else {
        setRenamingId(null);
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleTrash(itemId: string) {
    if (busyItemId) return;
    setBusyItemId(itemId);
    setError(null);
    try {
      const res = await fetch(`/api/drive/files/${itemId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not move to trash.');
      } else {
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleMoveHere(destinationFolderId: string) {
    if (!movingItem || busyItemId) return;
    const item = movingItem;
    setBusyItemId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/drive/files/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newParentId: destinationFolderId, oldParentId: currentFolderId }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Move failed.');
      } else {
        setMovingItem(null);
        await fetchItems();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusyItemId(null);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {breadcrumb.map((crumb, i) => (
          <span key={crumb.id}>
            {i > 0 && <span style={{ margin: '0 4px', color: 'var(--ink-dim)' }}>/</span>}
            <button
              className="btn"
              style={{ padding: '2px 8px', fontSize: 13 }}
              onClick={() => goToBreadcrumb(i)}
              disabled={i === breadcrumb.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
        {selectMode && (
          <button
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
            onClick={() => onSelectFolder?.(currentFolderId, breadcrumb[breadcrumb.length - 1].name)}
          >
            Move here
          </button>
        )}
      </div>

      {!selectMode && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input ref={fileInputRef} type="file" onChange={handleUploadChosen} style={{ display: 'none' }} />
          <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <button className="btn" onClick={() => setShowNewFolderForm(!showNewFolderForm)}>
            New folder
          </button>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search this folder…"
            style={{ width: 220 }}
          />
        </div>
      )}

      {showNewFolderForm && (
        <form onSubmit={handleCreateFolder} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="Folder name" autoFocus />
          <button className="btn btn-primary" type="submit" disabled={creatingFolder || !newFolderName.trim()}>
            {creatingFolder ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {loading && items.length === 0 ? (
        <p className="page-subtitle">Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {items.map(item => {
            const isFolder = item.mimeType === FOLDER_MIME;
            const isBusy = busyItemId === item.id;
            return (
              <div key={item.id} className="card" style={{ padding: 10, cursor: isFolder ? 'pointer' : 'default', opacity: isBusy ? 0.5 : 1 }} onClick={() => isFolder && openFolder(item)}>
                {!isFolder && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/drive/files/${item.id}/thumbnail`}
                    alt=""
                    style={{ width: '100%', height: 80, objectFit: 'cover', marginBottom: 6, borderRadius: 'var(--radius)' }}
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                {renamingId === item.id ? (
                  <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
                    <input value={renameValue} onChange={e => setRenameValue(e.target.value)} style={{ fontSize: 12, width: '100%' }} autoFocus />
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => handleRename(item.id)} disabled={isBusy}>OK</button>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{isFolder ? '📁 ' : ''}{item.name}</div>
                )}
                {!selectMode && renamingId !== item.id && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                    {!isFolder && item.webViewLink && (
                      <a href={item.webViewLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>Open</a>
                    )}
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px' }} disabled={isBusy} onClick={() => { setRenamingId(item.id); setRenameValue(item.name); }}>
                      Rename
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px' }} disabled={isBusy} onClick={() => setMovingItem(item)}>
                      Move
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 6px', color: 'var(--reject)' }} disabled={isBusy} onClick={() => handleTrash(item.id)}>
                      {isBusy ? '…' : 'Trash'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {movingItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Move &quot;{movingItem.name}&quot;</strong>
              <button className="btn" onClick={() => setMovingItem(null)}>Cancel</button>
            </div>
            <DriveBrowser selectMode onSelectFolder={handleMoveHere} />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all passing, clean

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/drive/DriveBrowser.tsx
git commit -m "feat: add Drive upload/new-folder/rename/move/trash actions"
```

---

### Task 16: "Share to Drive" on the asset detail page

**Files:**
- Modify: `app/dashboard/assets/[id]/page.tsx`
- Create: `app/api/assets/[id]/share-to-drive/route.ts`
- Test: `test/assetShareToDriveRoute.test.ts`

**Interfaces:**
- Consumes: `driveService.uploadFile` (Task 4), `assetService.getById` (existing), `storageDirFor` (existing, `lib/services/shared/assetSafety.ts`), `getCurrentUser`. Reuses `DriveBrowser` in `selectMode` (Task 15) as the folder-picker modal.

The route reads the asset's own stored file from `storage/<subdir>/<image_path>` (using `getProjectRoot()` + `storageDirFor(asset.output_kind)`, exactly like every other route that reads an asset's stored file) and uploads it as a Node `fs.createReadStream`, not a browser-provided one — this is the one call site in the whole feature where the upload source isn't a browser `File`.

- [ ] **Step 1: Write the failing tests for the new route**

```ts
// test/assetShareToDriveRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    uploadFile: vi.fn(),
  },
}));

vi.mock('@/lib/services/AssetService', () => ({
  assetService: {
    getById: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/assets/asset1/share-to-drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/assets/[id]/share-to-drive', () => {
  it('returns 404 when the asset does not exist', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue(null);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the asset has no stored file', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: null, output_kind: 'image', prompt: 'x',
    } as any);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run test/assetShareToDriveRoute.test.ts`
Expected: FAIL — route module doesn't exist yet

- [ ] **Step 3: Implement the route**

```ts
// app/api/assets/[id]/share-to-drive/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { storageDirFor } from '@/lib/services/shared/assetSafety';

export const dynamic = 'force-dynamic';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css',
  '.html': 'text/html',
};

const ShareSchema = z.object({ parentFolderId: z.string().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    if (!asset.image_path) {
      return NextResponse.json({ success: false, error: 'This asset has no stored file to share.' }, { status: 400 });
    }

    const { parentFolderId } = ShareSchema.parse(await req.json());
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(asset.output_kind), asset.image_path);

    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(physicalPath);
    } catch (e) {
      console.error(`Failed to open asset file for Drive share: ${physicalPath}`, e);
      return NextResponse.json({ success: false, error: 'Could not read this asset\'s file.' }, { status: 500 });
    }

    const extension = path.extname(asset.image_path).toLowerCase();
    const uploaded = await driveService.uploadFile({
      name: asset.image_path,
      mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
      stream,
      parentFolderId,
    });
    return NextResponse.json({ success: true, data: uploaded });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    console.error('Failed to share asset to Drive:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run test/assetShareToDriveRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the button into the asset detail page**

Modify `app/dashboard/assets/[id]/page.tsx`. Add the import at the top:

```tsx
import { useState as useStateAlias } from 'react'; // NOTE: this file already imports useState — do not add a duplicate import. Add DriveBrowser's import only:
```

(That note is for the implementer, not code to add — the file already has `import { useEffect, useState, use as usePromise } from 'react';` at line 3; do not touch it.)

Add this new import:

```tsx
import { DriveBrowser } from '@/app/dashboard/drive/DriveBrowser';
```

Add new state, alongside the existing `useState` declarations (after the `contrast` state on line 19):

```tsx
  const [sharingToDrive, setSharingToDrive] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
```

Add this new handler, alongside `handleEdit` (after it, before `addState`):

```tsx
  async function handleShareToDrive(parentFolderId: string) {
    setSharingToDrive(true);
    setShareStatus(null);
    try {
      const res = await fetch(`/api/assets/${id}/share-to-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentFolderId }),
      });
      const body = await res.json();
      setShareStatus(body.success ? `Shared to Drive as "${body.data.name}".` : (body.error ?? 'Could not share to Drive.'));
      setShowDrivePicker(false);
    } catch {
      setShareStatus('Could not reach the server.');
    } finally {
      setSharingToDrive(false);
    }
  }
```

Add the button and modal, right after the closing `</div>` of the existing 9-slice-margins card (after line 190, before the States card):

```tsx
      <div className="card" style={{ maxWidth: 420, marginBottom: 20 }}>
        <button className="btn" onClick={() => setShowDrivePicker(true)} disabled={sharingToDrive}>
          {sharingToDrive ? 'Sharing…' : 'Share to Drive'}
        </button>
        {shareStatus && <p style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-dim)' }}>{shareStatus}</p>}
      </div>

      {showDrivePicker && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Choose a destination folder</strong>
              <button className="btn" onClick={() => setShowDrivePicker(false)}>Cancel</button>
            </div>
            <DriveBrowser selectMode onSelectFolder={handleShareToDrive} />
          </div>
        </div>
      )}
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all passing, clean

- [ ] **Step 7: Manual verification via dev server**

`npm run dev`, open any asset's detail page, click "Share to Drive," confirm the folder-picker modal opens using the same `DriveBrowser` component (with "Move here" replaced by its `selectMode` label). Full end-to-end upload requires a real connected Drive account — note in the final task if this wasn't possible to test live.

- [ ] **Step 8: Commit**

```bash
git add "app/api/assets/[id]/share-to-drive/route.ts" test/assetShareToDriveRoute.test.ts app/dashboard/assets/\[id\]/page.tsx
git commit -m "feat: add Share to Drive on the asset detail page"
```

---

### Task 17: Nav link

**Files:**
- Modify: `app/components/NavRail.tsx`

- [ ] **Step 1: Add the link**

In the `LINKS` array (currently lines 7-19), add a new entry. Place it after `'/dashboard/export'` and before the settings links, matching the existing grouping (feature pages first, settings pages last):

```ts
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/drive', label: 'Drive' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
```

Also add a settings entry for the new Google Drive settings page, alongside the other settings links:

```ts
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
  { href: '/dashboard/settings/google-drive', label: 'Google Drive' },
```

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: all passing (no test covers `NavRail.tsx` directly, matches existing convention)

- [ ] **Step 3: Commit**

```bash
git add app/components/NavRail.tsx
git commit -m "feat: add Drive and Google Drive settings nav links"
```

---

### Task 18: Final verification

**Files:** none (verification-only task)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all files passing, no skipped tests

- [ ] **Step 3: Grep sweep for anything half-wired**

```bash
grep -rn "TODO\|FIXME\|files.delete(" app lib --include="*.ts" --include="*.tsx" | grep -i drive
```

Expected: no output. If `files.delete(` appears anywhere in Drive-related code, that is a Critical finding — it means somewhere bypassed the trash-only delete requirement from this plan's Global Constraints; fix it before proceeding.

- [ ] **Step 4: Confirm every new route requires a session**

```bash
grep -L "getCurrentUser" app/api/drive/*/route.ts "app/api/drive/files/[id]/route.ts" "app/api/drive/files/[id]/thumbnail/route.ts" "app/api/assets/[id]/share-to-drive/route.ts" 2>/dev/null
```

Expected: no output (every listed file contains `getCurrentUser` — `grep -L` prints files that do NOT match, so empty output means full coverage).

- [ ] **Step 5: Commit if either check required a fix, otherwise proceed with no commit**

---

## Self-Review (performed while writing this plan)

**Spec coverage:** every section of `docs/superpowers/specs/2026-09-07-google-drive-design.md` maps to a task — single app-wide OAuth connection → Task 2/7, `@googleapis/drive` dependency choice → Task 1, `DriveService`'s full method list → Tasks 3-6, every `/api/drive/*` route → Tasks 7-12, the settings page → Task 13, the full file-manager frontend → Tasks 14-15, "Share to Drive" → Task 16, polling-based live updates → Task 14 (via `usePolling`), the security note (refresh token in `settings`, never git-synced) → already true by construction since Task 2 uses `settingsService` and this plan never touches `GitService.ts`'s `DATA_DIRS`. No spec section lacks a task.

**Placeholder scan:** no TBD/TODO; every code block is complete, real code. The one explicit gap is `moveFile`'s exact API parameter shape, which the spec itself flagged as not independently re-verified — that's stated as an explicit verification step for the implementer (Task 5's note), not a placeholder standing in for missing design work.

**Type consistency:** `DriveFile` (Task 3, server-side in `lib/services/DriveService.ts`) and the client-side `DriveFile` interface (Task 14, `app/dashboard/drive/DriveBrowser.tsx`) are deliberately two separate declarations with identical fields — this is correct, not a bug: `DriveService.ts` is server-only (imports `@googleapis/drive`, which has Node-only dependencies) and cannot be imported from a `'use client'` component, the same class of constraint this codebase already solved once for `componentDocument.ts` (split out from `ComponentGenerator.ts` for exactly this reason) and `themeTokens.ts`. `driveService.uploadFile`'s parameter shape (`{ name, mimeType, stream, parentFolderId }`) is used identically by Task 9's route and Task 16's share-to-drive route. `FILE_FIELDS`/`LIST_FIELDS` are defined once (Task 3) and reused by every later DriveService method (Tasks 4-5), not redefined.

## Execution

This plan uses **superpowers:subagent-driven-development** — the standing pattern for every feature built this session (fresh implementer subagent per task, fresh task reviewer, final whole-branch review before merge).
