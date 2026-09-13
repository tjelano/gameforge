import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Multi-GB downloads are slow -- generous on purpose, not the 60-120s used
// for an actual generation call. Combined with the incoming request's own
// signal so navigating away on the client cancels the upstream pull too;
// Ollama resumes a partial pull on the next attempt, so a timeout here
// isn't destructive.
const PULL_TIMEOUT_MS = 5 * 60_000;

const PullSchema = z.object({ model: z.string().min(1) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const parsed = PullSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'model is required' }, { status: 400 });
  }

  const host = (await settingsService.get(OLLAMA_HOST_SETTING_KEY)) ?? DEFAULT_OLLAMA_HOST;

  try {
    const upstream = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: parsed.data.model, stream: true }),
      signal: AbortSignal.any([AbortSignal.timeout(PULL_TIMEOUT_MS), req.signal]),
    });

    if (!upstream.ok || !upstream.body) {
      const body = await upstream.text?.().catch(() => '') ?? '';
      return NextResponse.json({ success: false, error: `Ollama rejected the pull (${upstream.status}): ${body}` }, { status: 500 });
    }

    return new NextResponse(upstream.body, { headers: { 'content-type': 'application/x-ndjson' } });
  } catch (error: any) {
    console.error(`Failed to pull Ollama model ${parsed.data.model}:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
