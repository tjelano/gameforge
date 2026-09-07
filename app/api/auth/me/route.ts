import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: true, data: null });
  }
  return NextResponse.json({
    success: true,
    data: { id: user.id, name: user.name, isAdmin: !!user.is_admin },
  });
}
