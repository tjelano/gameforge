import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

// This feature's path validation is deliberately Windows-only
// (isDriveLetterRootedPath requires a genuine C:\ drive letter — see
// lib/services/shared/editDecision.ts). Tests below that build their
// "real, existing Aseprite/image path" from a real OS temp dir
// (os.tmpdir() via tempRoot) can only satisfy that check when this test
// runner's own filesystem produces drive-letter-rooted absolute paths —
// i.e. on a Windows CI runner or a Windows dev machine, not on
// ubuntu-latest, where os.tmpdir() is something like /tmp/... and
// structurally can never be drive-letter-rooted. That's not a gap to
// "fix" here; loosening isDriveLetterRootedPath to also accept POSIX
// paths would silently widen what this launcher accepts. Each test below
// is gated individually, only when ITS OWN assertion actually depends on
// that drive-letter shape (not just because it happens to live in this
// file).
const WINDOWS_ONLY = process.platform !== 'win32';

// A fake ChildProcess: a real EventEmitter (so .once('error', ...) works
// exactly like the real thing) plus a stubbed unref(). Individual tests
// can grab the returned emitter via spawnMock.mock.results to fire a
// simulated async 'error' event.
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}
// Typed with an explicit (...args: unknown[]) signature rather than
// vi.fn(makeFakeChild) directly: makeFakeChild takes no parameters, so TS
// would infer spawnMock as a zero-arg mock and reject both the spread call
// below and the mock.calls[0] tuple destructuring further down. Runtime
// behavior is identical either way — makeFakeChild ignores its arguments.
const spawnMock = vi.fn((..._args: unknown[]) => makeFakeChild());
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

let tempRoot: string;
const STYLE_ID = '99999999-9999-9999-9999-999999999999';
const ASSET_WITH_IMAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ASSET_NO_IMAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ASSET_UNSAFE_PATH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function editRequest(): NextRequest {
  return new NextRequest('http://localhost/api/assets/x/edit', { method: 'POST' });
}

beforeEach(async () => {
  spawnMock.mockClear();
  spawnMock.mockImplementation(makeFakeChild);
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetedit-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'Confirm', 'confirm.png', 1000, 0)`
  ).run(ASSET_WITH_IMAGE_ID, STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'No Image', NULL, 1000, 0)`
  ).run(ASSET_NO_IMAGE_ID, STYLE_ID);
  // Simulates a row that arrived via git-imported JSON, which AssetSchema
  // does not format-validate — exactly the vector Round 1 review finding 2
  // described. A normal upload flow never produces a path like this.
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'Unsafe', '../../../outside.png', 1000, 0)`
  ).run(ASSET_UNSAFE_PATH_ID, STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('POST /api/assets/[id]/edit', () => {
  it('404s when the asset does not exist', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: 'no-such-asset' }) });
    expect(res.status).toBe(404);
  });

  it('400s with a specific message when the asset has no image', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_NO_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('This asset has no image.');
  });

  it('400s and never touches the filesystem when the stored image path is unsafe', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_UNSAFE_PATH_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid image path.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s with a specific message when no Aseprite path is configured', async () => {
    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Set your Aseprite path in Settings first.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s when the configured path exists but its filename does not look like Aseprite', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const wrongExePath = path.join(tempRoot, 'notepad.exe');
    await fsPromises.writeFile(wrongExePath, 'not-aseprite');
    await settingsService.set('aseprite_path', wrongExePath);
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'confirm.png'), 'fake-png-bytes');

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Configured path must point to an Aseprite executable.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // Needs asepritePathLooksLikeAseprite to be TRUE (to reach the
  // existence check at all) — only possible when tempRoot is genuinely
  // drive-letter-rooted.
  it.skipIf(WINDOWS_ONLY)('400s when the configured Aseprite path does not exist on disk', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    // Filename must still match looksLikeAsepriteExecutable's naming
    // pattern (starts with "aseprite") so this test actually isolates the
    // existence check rather than tripping the earlier naming check first
    // — the file itself is deliberately never written.
    await settingsService.set('aseprite_path', path.join(tempRoot, 'aseprite-not-on-disk.exe'));
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'confirm.png'), 'fake-png-bytes');

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Aseprite not found at the configured path. Check Settings.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // Needs asepritePathLooksLikeAseprite to be TRUE to reach the
  // (unrelated) imageExists check at all — otherwise decideEditAction
  // rejects earlier with a different message.
  it.skipIf(WINDOWS_ONLY)('400s when the image file is missing on disk even though the DB row has a path', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    // Deliberately NOT creating storage/images/confirm.png here.

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Image file not found on disk.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // Needs a full ok:true decision, which needs asepritePathLooksLikeAseprite
  // to be TRUE — only possible with a genuinely drive-letter-rooted
  // tempRoot.
  it.skipIf(WINDOWS_ONLY)('launches Aseprite with the resolved absolute image path when everything checks out', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    const imagePath = path.join(tempRoot, 'storage', 'images', 'confirm.png');
    await fsPromises.writeFile(imagePath, 'fake-png-bytes');

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [calledExe, calledArgs, calledOpts] = spawnMock.mock.calls[0];
    expect(calledExe).toBe(fakeAsepritePath);
    expect(calledArgs).toEqual([imagePath]);
    expect(calledOpts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  // Needs a full ok:true decision (to actually reach the spawn call) —
  // only possible with a genuinely drive-letter-rooted tempRoot.
  it.skipIf(WINDOWS_ONLY)('reports a launch failure instead of crashing when spawn emits an async error', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    const imagePath = path.join(tempRoot, 'storage', 'images', 'confirm.png');
    await fsPromises.writeFile(imagePath, 'fake-png-bytes');

    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild();
      // Simulate the real, asynchronous failure mode: spawn() returns
      // successfully, then the OS-level failure surfaces on 'error'
      // shortly after (e.g. permission denied, not actually executable).
      setImmediate(() => child.emit('error', new Error('spawn EACCES')));
      return child;
    });

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  // Needs a full ok:true decision (to actually reach the spawn call) —
  // only possible with a genuinely drive-letter-rooted tempRoot.
  it.skipIf(WINDOWS_ONLY)('reports a launch failure instead of crashing when spawn throws synchronously', async () => {
    const { settingsService } = await import('@/lib/services/SettingsService');
    const fakeAsepritePath = path.join(tempRoot, 'aseprite.exe');
    await fsPromises.writeFile(fakeAsepritePath, 'fake-exe-bytes');
    await settingsService.set('aseprite_path', fakeAsepritePath);
    const imagePath = path.join(tempRoot, 'storage', 'images', 'confirm.png');
    await fsPromises.writeFile(imagePath, 'fake-png-bytes');

    // The unlikely-but-still-handled case: spawn() itself throws
    // synchronously (e.g. an invalid options object), rather than
    // returning and failing later via the 'error' event this file's other
    // test covers. The route's outer try/catch around the spawn call is
    // what this exercises.
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed synchronously');
    });

    const { POST } = await import('@/app/api/assets/[id]/edit/route');
    const res = await POST(editRequest(), { params: Promise.resolve({ id: ASSET_WITH_IMAGE_ID }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
