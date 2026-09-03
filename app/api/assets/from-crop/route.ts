import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

const FromCropSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  jobId: z.string().uuid(),
  label: z.string().min(1),
  imageDataUrl: z.string().startsWith('data:image/'),
});

function decodeDataUrl(dataUrl: string): { bytes: Buffer; extension: string } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) throw new Error('Malformed image data URL');
  const [, format, base64] = match;
  return { bytes: Buffer.from(base64, 'base64'), extension: format === 'jpeg' ? 'jpg' : format };
}

export async function POST(req: NextRequest) {
  try {
    const input = FromCropSchema.parse(await req.json());
    const { bytes, extension } = decodeDataUrl(input.imageDataUrl);

    const filename = `split-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    try {
      await fsPromises.mkdir(imagesDir, { recursive: true });
      await fsPromises.writeFile(path.join(imagesDir, filename), bytes);
    } catch (e) {
      console.error(`Failed to write split element image ${filename}:`, e);
      throw e;
    }

    const asset = await assetService.create({
      styleId: input.styleId,
      createdBy: input.createdBy,
      assetType: 'ui_element',
      prompt: input.label,
      imagePath: filename,
      sourceJobId: input.jobId,
    });

    return NextResponse.json({ success: true, data: asset });
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
