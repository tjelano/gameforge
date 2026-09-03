import { NextResponse } from 'next/server';
import { gitService } from '@/lib/services/GitService';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await gitService.abortMerge();
  return NextResponse.json(result, { status: result.success ? 200 : 500 });
}
