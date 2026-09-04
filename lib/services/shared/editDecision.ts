import path from 'path';

export type EditDecision =
  | { ok: true; asepritePath: string; imagePath: string }
  | { ok: false; error: string };

// Same guard app/api/images/[filename]/route.ts already uses for the read
// path — reused here because a stored image_path reaches this route
// without going through that route's own check, and can arrive via
// git-imported JSON that AssetSchema doesn't format-validate.
export function isSafeStoredFilename(filename: string): boolean {
  return !filename.includes('/') && !filename.includes('\\') && !filename.includes('..');
}

// A path rooted on a genuine drive letter (C:\...), not a UNC share
// (\\server\share\...) or a Windows device/extended-length path
// (\\.\..., \\?\...). Round 3 of this plan's adversarial review found
// that path.isAbsolute() alone accepts UNC paths — a network-only
// attacker (no local file-write access needed) could host a
// maliciously-named payload on a share they control and point the
// setting at it, since the filename check below would otherwise pass on
// its basename alone. This closes that.
//
// Named for exactly what it checks, not more (round 4 finding): a
// drive-letter-rooted path can still be a mapped network drive (Z:\
// mapped to a UNC target) or traverse an NTFS reparse point/junction to
// somewhere else entirely. Detecting either would need real OS-level
// drive-type/reparse-point queries (e.g. shelling out, or a native
// addon) — accepted as a residual gap for V1, consistent with this
// feature's other "narrows, does not eliminate" mitigations (see the
// spec's Security note).
export function isDriveLetterRootedPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate);
}

// Proportionate mitigation for this app having no auth anywhere (see this
// task's own Interfaces section above for the full reasoning): restricts
// what can be launched to something whose filename actually looks like
// Aseprite AND that lives on a local drive, rather than any already-present
// executable on the machine or anything reachable over the network.
export function looksLikeAsepriteExecutable(asepritePath: string): boolean {
  // path.win32.basename, not the platform-default path.basename: this
  // feature's target is always a Windows path (see isDriveLetterRootedPath
  // above), but path.basename is platform-dependent — on Linux CI it would
  // be path.posix.basename, which doesn't treat '\' as a separator and
  // leaves a genuine Windows path like C:\Aseprite\Aseprite.exe unchanged,
  // never matching the pattern below. path.win32.basename behaves exactly
  // like path.basename on an actual Windows host, so this is a no-op there.
  return (
    isDriveLetterRootedPath(asepritePath) && /^aseprite.*\.exe$/i.test(path.win32.basename(asepritePath))
  );
}

export function decideEditAction(params: {
  imagePathColumn: string | null;
  imagePathIsSafe: boolean;
  asepritePathSetting: string | null;
  asepritePathLooksLikeAseprite: boolean;
  imageAbsolutePath: string;
  imageExists: boolean;
  asepriteExists: boolean;
}): EditDecision {
  if (!params.imagePathColumn) {
    return { ok: false, error: 'This asset has no image.' };
  }
  if (!params.imagePathIsSafe) {
    return { ok: false, error: 'Invalid image path.' };
  }
  if (!params.asepritePathSetting) {
    return { ok: false, error: 'Set your Aseprite path in Settings first.' };
  }
  if (!params.asepritePathLooksLikeAseprite) {
    return { ok: false, error: 'Configured path must point to an Aseprite executable.' };
  }
  if (!params.imageExists) {
    return { ok: false, error: 'Image file not found on disk.' };
  }
  if (!params.asepriteExists) {
    return { ok: false, error: 'Aseprite not found at the configured path. Check Settings.' };
  }
  return { ok: true, asepritePath: params.asepritePathSetting, imagePath: params.imageAbsolutePath };
}
