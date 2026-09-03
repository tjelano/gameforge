import { NextResponse } from 'next/server';
import { gitService } from '@/lib/services/GitService';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await gitService.pull();
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
