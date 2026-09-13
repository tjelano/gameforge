import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const code = req.nextUrl.searchParams.get('code');
    if (!code) {
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=missing_code', req.url));
    }

    try {
      await driveService.exchangeCodeForTokens(code);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive', req.url));
    } catch (e: any) {
      console.error('Failed to exchange Google Drive OAuth code:', e);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=exchange_failed', req.url));
    }
  } catch (e) {
    console.error('Unexpected error in Drive callback route:', e);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=server_error', req.url));
  }
}
