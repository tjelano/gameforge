import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

const SetHostSchema = z.object({
  host: z.string().regex(/^https?:\/\//, 'Host must start with http:// or https://'),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    const savedHost = await settingsService.get(OLLAMA_HOST_SETTING_KEY);
    return NextResponse.json({ success: true, data: { host: savedHost ?? DEFAULT_OLLAMA_HOST } });
  } catch (error: any) {
    console.error('Failed to read ollama_host setting:', error);
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
    const parsed = SetHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    await settingsService.set(OLLAMA_HOST_SETTING_KEY, parsed.data.host);
    return NextResponse.json({ success: true, data: { host: parsed.data.host } });
  } catch (error: any) {
    console.error('Failed to save ollama_host setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
