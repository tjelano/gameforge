import { NextResponse } from 'next/server';
import { getRecentActivity } from '@/lib/services/recentActivity';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await getRecentActivity();
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
