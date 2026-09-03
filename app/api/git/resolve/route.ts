import { NextResponse } from 'next/server';
import { gitService } from '@/lib/services/GitService';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await gitService.resolveConflicts();
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
