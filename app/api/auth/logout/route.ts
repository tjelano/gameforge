import { NextRequest, NextResponse } from 'next/server';
import { sessionService } from '@/lib/services/SessionService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get('session')?.value;
    if (token) await sessionService.destroy(token);

    const res = NextResponse.json({ success: true });
    res.cookies.set('session', '', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return res;
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
