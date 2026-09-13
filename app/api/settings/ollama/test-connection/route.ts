import { NextRequest, NextResponse } from 'next/server';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const host = (await settingsService.get(OLLAMA_HOST_SETTING_KEY)) ?? DEFAULT_OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return NextResponse.json({ success: true, data: { reachable: res.ok } });
  } catch {
    return NextResponse.json({ success: true, data: { reachable: false } });
  }
}
