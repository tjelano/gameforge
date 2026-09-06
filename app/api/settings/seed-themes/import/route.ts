import { NextResponse } from 'next/server';
import { importSeedThemes } from '@/lib/services/SeedThemeImporter';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await importSeedThemes();
    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
