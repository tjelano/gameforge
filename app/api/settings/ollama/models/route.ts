import { NextRequest, NextResponse } from 'next/server';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const host = (await settingsService.get(OLLAMA_HOST_SETTING_KEY)) ?? DEFAULT_OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return NextResponse.json({ success: true, data: { models: [], host } });
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return NextResponse.json({ success: true, data: { models: (data.models ?? []).map(m => m.name), host } });
  } catch {
    // Unreachable host is not an error for this endpoint's purpose (the
    // picker just shows no local models) -- the Settings page's own
    // "Test connection" button (Task 5) is where "is it even running" gets
    // a real yes/no. `host` is still returned so the caller (Task 9's
    // picker) knows which host a subsequent generation request should
    // target, even if it's currently unreachable.
    return NextResponse.json({ success: true, data: { models: [], host } });
  }
}
