import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { settingsService } from '@/lib/services/SettingsService';
import { ASEPRITE_PATH_SETTING_KEY } from '@/lib/config';
import { isDriveLetterRootedPath } from '@/lib/services/shared/editDecision';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

// Trimmed first, then either '' (clears the setting — decideEditAction in
// Task 2 already treats '' the same as null/unset) or a genuine local
// drive path. isDriveLetterRootedPath is imported from Task 2's module,
// not redefined here — this route's check and the edit route's final
// enforcement (looksLikeAsepriteExecutable, which uses the same function)
// now share one implementation, per AGENTS.md's rule to extract shared
// helpers for safety-critical logic on sight.
const SetPathSchema = z.object({
  path: z
    .string()
    .transform(s => s.trim())
    .refine(s => s === '' || isDriveLetterRootedPath(s), {
      message: 'Path must be empty (to clear) or an absolute local path (e.g. C:\\...).',
    }),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const savedPath = await settingsService.get(ASEPRITE_PATH_SETTING_KEY);
    return NextResponse.json({ success: true, data: { path: savedPath ?? '' } });
  } catch (error: any) {
    console.error('Failed to read aseprite_path setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json();
    const parsed = SetPathSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    await settingsService.set(ASEPRITE_PATH_SETTING_KEY, parsed.data.path);
    return NextResponse.json({ success: true, data: { path: parsed.data.path } });
  } catch (error: any) {
    console.error('Failed to save aseprite_path setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
