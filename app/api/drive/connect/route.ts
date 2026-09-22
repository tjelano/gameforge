import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.redirect(new URL('/login?reason=expired', req.url));
    }
    try {
      return NextResponse.redirect(driveService.getAuthUrl());
    } catch (e) {
      console.error('Failed to build Google Drive auth URL:', e);
      return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=not_configured', req.url));
    }
  } catch (e) {
    console.error('Unexpected error in Drive connect route:', e);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=server_error', req.url));
  }
}
