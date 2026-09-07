import { NextRequest, NextResponse } from 'next/server';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }
  try {
    return NextResponse.redirect(driveService.getAuthUrl());
  } catch (e) {
    console.error('Failed to build Google Drive auth URL:', e);
    return NextResponse.redirect(new URL('/dashboard/settings/google-drive?error=not_configured', req.url));
  }
}
