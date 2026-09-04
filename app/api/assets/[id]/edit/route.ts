import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { assetService } from '@/lib/services/AssetService';
import { settingsService } from '@/lib/services/SettingsService';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import {
  decideEditAction,
  isSafeStoredFilename,
  looksLikeAsepriteExecutable,
} from '@/lib/services/shared/editDecision';
import { ASEPRITE_PATH_SETTING_KEY } from '@/lib/config';

export const dynamic = 'force-dynamic';

// How long to wait for spawn's asynchronous 'error' event before giving up
// and reporting success anyway. spawn() itself returns immediately either
// way; a real, immediate failure (bad permissions, not actually an
// executable) reliably surfaces well within this window in practice. This
// does not wait for Aseprite to fully start or exit — only for the narrow
// class of near-immediate launch failures, matching the spec's "fire and
// forget, don't wait for Aseprite to close" design.
const SPAWN_ERROR_WAIT_MS = 300;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const asset = await assetService.getById(id);
    if (!asset) {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }

    const asepritePathSetting = await settingsService.get(ASEPRITE_PATH_SETTING_KEY);

    const imagePathIsSafe = !!asset.image_path && isSafeStoredFilename(asset.image_path);
    const imageAbsolutePath =
      asset.image_path && imagePathIsSafe
        ? path.join(getProjectRoot(), 'storage', 'images', asset.image_path)
        : '';
    const asepritePathLooksLikeAseprite =
      !!asepritePathSetting && looksLikeAsepriteExecutable(asepritePathSetting);

    // isFile() rather than existsSync: a directory or other non-regular
    // path would pass an existsSync-only check and produce a confusing
    // spawn failure instead of the specific, actionable message below.
    // statSync throws ENOENT for a path that doesn't exist at all — that's
    // an ordinary, expected outcome here, not worth logging. Any OTHER
    // stat failure (e.g. EACCES — permission denied) is unexpected and
    // genuinely worth a server-side log, even though the user still just
    // sees the same generic "not found" decision-branch message.
    function isRegularFile(p: string): boolean {
      try {
        return fs.statSync(p).isFile();
      } catch (e: any) {
        if (e?.code !== 'ENOENT') console.error(`Unexpected error checking ${p}:`, e);
        return false;
      }
    }

    let imageExists = false;
    let asepriteExists = false;
    try {
      imageExists = !!imageAbsolutePath && isRegularFile(imageAbsolutePath);
      asepriteExists = asepritePathLooksLikeAseprite && isRegularFile(asepritePathSetting!);
    } catch (e) {
      console.error('Failed checking file existence for edit action:', e);
    }

    const decision = decideEditAction({
      imagePathColumn: asset.image_path,
      imagePathIsSafe,
      asepritePathSetting,
      asepritePathLooksLikeAseprite,
      imageAbsolutePath,
      imageExists,
      asepriteExists,
    });

    if (!decision.ok) {
      return NextResponse.json({ success: false, error: decision.error }, { status: 400 });
    }

    try {
      const child = spawn(decision.asepritePath, [decision.imagePath], {
        detached: true,
        stdio: 'ignore',
      });

      const spawnError = await new Promise<Error | null>(resolve => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(null);
        }, SPAWN_ERROR_WAIT_MS);
        // This listener can still fire AFTER the timeout above already
        // resolved the promise (resolve() on an already-settled promise is
        // a harmless no-op) — a late failure that arrives after the
        // response already reported success. That's still worth a
        // server-side log even though the HTTP response has already gone
        // out; a call to resolve() below in that case is inert but
        // harmless.
        child.once('error', err => {
          clearTimeout(timer);
          if (settled) {
            console.error('Aseprite failed to launch (after the response already reported success):', err);
          } else {
            settled = true;
          }
          resolve(err);
        });
      });

      child.unref();

      if (spawnError) {
        console.error('Failed to launch Aseprite:', spawnError);
        return NextResponse.json(
          { success: false, error: 'Could not launch Aseprite. Check the configured path.' },
          { status: 500 }
        );
      }
    } catch (e) {
      console.error('Failed to spawn Aseprite:', e);
      return NextResponse.json({ success: false, error: 'Could not launch Aseprite.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: { launched: true } });
  } catch (error: any) {
    console.error('Edit action failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
