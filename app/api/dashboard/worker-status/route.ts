import { NextResponse } from 'next/server';
import { settingsService } from '@/lib/services/SettingsService';
import { WORKER_LAST_SEEN_SETTING_KEY, WORKER_ALIVE_THRESHOLD_MS } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const lastSeen = await settingsService.get(WORKER_LAST_SEEN_SETTING_KEY);
    const alive = lastSeen !== null && Date.now() - Number(lastSeen) < WORKER_ALIVE_THRESHOLD_MS;
    return NextResponse.json({ success: true, data: { alive } });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
