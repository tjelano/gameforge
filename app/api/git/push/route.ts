import { NextRequest, NextResponse } from 'next/server';
import { gitService } from '@/lib/services/GitService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const result = await gitService.push();
  return NextResponse.json(result, { status: result.success ? 200 : 500 });
}
