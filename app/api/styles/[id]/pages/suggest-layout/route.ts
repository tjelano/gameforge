import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { assetService } from '@/lib/services/AssetService';
import { getPageLayoutSuggester, type PageLayoutComponentCandidate } from '@/lib/services/PageLayoutSuggester';
import type { OllamaProviderOverride } from '@/lib/services/ollamaToolCall';

export const dynamic = 'force-dynamic';

const SuggestLayoutSchema = z.object({
  pageName: z.string().min(1),
  provider: z.enum(['claude', 'ollama']).optional(),
  model: z.string().min(1).optional(),
  ollamaHost: z.string().regex(/^https?:\/\//).optional(),
}).refine(
  input => input.provider !== 'ollama' || (!!input.model && !!input.ollamaHost),
  { message: 'model and ollamaHost are required when provider is "ollama"' }
);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = SuggestLayoutSchema.parse(await req.json());

    const assets = await assetService.getActiveAssetsForStyle(id);
    const candidates: PageLayoutComponentCandidate[] = assets
      .filter(a => a.output_kind === 'component')
      .map(a => ({ id: a.id, assetType: a.asset_type, prompt: a.prompt }));

    const providerOverride: OllamaProviderOverride | undefined = input.provider === 'ollama'
      ? { type: 'ollama', host: input.ollamaHost!, model: input.model! }
      : undefined;

    const componentAssetIds = await getPageLayoutSuggester().suggest(input.pageName, candidates, undefined, providerOverride);

    return NextResponse.json({ success: true, data: { componentAssetIds } });
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
