import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { driveService } from '@/lib/services/DriveService';
import { getCurrentUser } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const CreateFolderSchema = z.object({
  name: z.string().min(1),
  parentFolderId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = CreateFolderSchema.parse(await req.json());
    const folder = await driveService.createFolder(input.name, input.parentFolderId);
    return NextResponse.json({ success: true, data: folder });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
