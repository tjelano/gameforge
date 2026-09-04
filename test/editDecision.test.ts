import { describe, it, expect } from 'vitest';
import {
  decideEditAction,
  isSafeStoredFilename,
  isDriveLetterRootedPath,
  looksLikeAsepriteExecutable,
} from '@/lib/services/shared/editDecision';

const BASE = {
  imagePathColumn: 'asset-123.png',
  imagePathIsSafe: true,
  asepritePathSetting: 'C:\\Aseprite\\Aseprite.exe',
  asepritePathLooksLikeAseprite: true,
  imageAbsolutePath: 'C:\\project\\storage\\images\\asset-123.png',
  imageExists: true,
  asepriteExists: true,
};

describe('decideEditAction', () => {
  it('rejects when the asset has no image at all', () => {
    const result = decideEditAction({ ...BASE, imagePathColumn: null });
    expect(result).toEqual({ ok: false, error: 'This asset has no image.' });
  });

  it('rejects an unsafe stored image path before checking anything else', () => {
    const result = decideEditAction({ ...BASE, imagePathIsSafe: false });
    expect(result).toEqual({ ok: false, error: 'Invalid image path.' });
  });

  it('rejects when no Aseprite path is configured', () => {
    const result = decideEditAction({ ...BASE, asepritePathSetting: null });
    expect(result).toEqual({ ok: false, error: 'Set your Aseprite path in Settings first.' });
  });

  it('rejects a configured path whose filename does not look like Aseprite', () => {
    const result = decideEditAction({ ...BASE, asepritePathLooksLikeAseprite: false });
    expect(result).toEqual({
      ok: false,
      error: 'Configured path must point to an Aseprite executable.',
    });
  });

  it('rejects when the image file is missing on disk', () => {
    const result = decideEditAction({ ...BASE, imageExists: false });
    expect(result).toEqual({ ok: false, error: 'Image file not found on disk.' });
  });

  it('rejects when Aseprite is not found at the configured path', () => {
    const result = decideEditAction({ ...BASE, asepriteExists: false });
    expect(result).toEqual({
      ok: false,
      error: 'Aseprite not found at the configured path. Check Settings.',
    });
  });

  it('approves when everything checks out, returning the resolved paths', () => {
    const result = decideEditAction(BASE);
    expect(result).toEqual({
      ok: true,
      asepritePath: 'C:\\Aseprite\\Aseprite.exe',
      imagePath: 'C:\\project\\storage\\images\\asset-123.png',
    });
  });
});

describe('isSafeStoredFilename', () => {
  it('accepts a bare filename', () => {
    expect(isSafeStoredFilename('asset-123.png')).toBe(true);
  });

  it('rejects a path containing a forward slash', () => {
    expect(isSafeStoredFilename('../secrets.png')).toBe(false);
  });

  it('rejects a path containing a backslash', () => {
    expect(isSafeStoredFilename('..\\secrets.png')).toBe(false);
  });

  it('rejects a path containing ..', () => {
    expect(isSafeStoredFilename('foo..png')).toBe(false);
  });
});

describe('isDriveLetterRootedPath', () => {
  it('accepts a genuine local drive path', () => {
    expect(isDriveLetterRootedPath('C:\\Aseprite\\Aseprite.exe')).toBe(true);
    expect(isDriveLetterRootedPath('C:/Aseprite/Aseprite.exe')).toBe(true);
  });

  it('rejects a UNC path', () => {
    expect(isDriveLetterRootedPath('\\\\attacker-server\\share\\aseprite.exe')).toBe(false);
  });

  it('rejects a device/extended-length path', () => {
    expect(isDriveLetterRootedPath('\\\\.\\aseprite.exe')).toBe(false);
    expect(isDriveLetterRootedPath('\\\\?\\C:\\aseprite.exe')).toBe(false);
  });

  it('rejects a relative path', () => {
    expect(isDriveLetterRootedPath('aseprite.exe')).toBe(false);
  });
});

describe('looksLikeAsepriteExecutable', () => {
  it('accepts Aseprite.exe (any casing)', () => {
    expect(looksLikeAsepriteExecutable('C:\\Program Files\\Aseprite\\Aseprite.exe')).toBe(true);
    expect(looksLikeAsepriteExecutable('C:\\tools\\aseprite.exe')).toBe(true);
  });

  it('accepts a self-built binary with a version suffix', () => {
    expect(looksLikeAsepriteExecutable('C:\\aseprite-src\\build\\bin\\aseprite-1.3.7.exe')).toBe(true);
  });

  it('rejects an unrelated executable', () => {
    expect(looksLikeAsepriteExecutable('C:\\Windows\\System32\\cmd.exe')).toBe(false);
    expect(looksLikeAsepriteExecutable('C:\\Windows\\System32\\powershell.exe')).toBe(false);
  });

  it('rejects a non-.exe file even if named aseprite', () => {
    expect(looksLikeAsepriteExecutable('C:\\notes\\aseprite.txt')).toBe(false);
  });

  it('rejects a UNC path even with a matching filename — round 3 review finding: a network-only attacker (no local file access) could host a payload on a share they control and point the setting at it, since the basename alone would otherwise pass', () => {
    expect(looksLikeAsepriteExecutable('\\\\attacker-server\\share\\aseprite-evil.exe')).toBe(false);
  });

  it('rejects a Windows device/extended-length path even with a matching filename', () => {
    expect(looksLikeAsepriteExecutable('\\\\.\\aseprite.exe')).toBe(false);
    expect(looksLikeAsepriteExecutable('\\\\?\\C:\\aseprite.exe')).toBe(false);
  });

  it('rejects a relative path even with a matching filename', () => {
    expect(looksLikeAsepriteExecutable('aseprite.exe')).toBe(false);
  });
});
