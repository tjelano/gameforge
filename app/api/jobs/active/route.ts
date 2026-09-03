import { NextResponse } from 'next/server';
import { jobService } from '@/lib/services/JobService';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const jobs = await jobService.getActive();
    return NextResponse.json({ success: true, data: jobs });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
