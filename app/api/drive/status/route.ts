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
    const connected = await driveService.isConnected();
    return NextResponse.json({ success: true, data: { connected } });
  } catch (error: any) {
    console.error('Failed to check Drive connection status:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
