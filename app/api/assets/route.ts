import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { assetService } from '@/lib/services/AssetService';

export const dynamic = 'force-dynamic';

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const params = PaginationSchema.parse({
      limit: searchParams.get('limit') ?? undefined,
      offset: searchParams.get('offset') ?? undefined,
    });

    const assets = await assetService.getPage(params.limit, params.offset);
    return NextResponse.json({ success: true, data: assets });
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

const CreateAssetSchema = z.object({
  styleId: z.string().uuid(),
  createdBy: z.string().min(1),
  assetType: z.string().min(1),
  prompt: z.string().min(1),
  imagePath: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = CreateAssetSchema.parse(body);

    const asset = await assetService.create({
      styleId: input.styleId,
      createdBy: input.createdBy,
      assetType: input.assetType,
      prompt: input.prompt,
      imagePath: input.imagePath ?? null,
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
