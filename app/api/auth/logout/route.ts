import { NextRequest, NextResponse } from 'next/server';
import { sessionService } from '@/lib/services/SessionService';
import { SESSION_COOKIE_OPTIONS } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get('session')?.value;
    if (token) await sessionService.destroy(token);

    const res = NextResponse.json({ success: true });
    res.cookies.set('session', '', { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
    return res;
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
