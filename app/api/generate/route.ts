import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import crypto from 'crypto';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';
import { saveReferenceImage } from '@/lib/services/referenceImage';
import { styleService } from '@/lib/services/StyleService';

export const dynamic = 'force-dynamic';

// A base64 string of 10,000,000 chars decodes to ~7.5MB of binary — generous
// for a single screenshot/photo reference, still bounded. Real ceiling, not
// a placeholder: rejects before saveReferenceImage() ever touches disk.
const MAX_REFERENCE_IMAGE_BASE64_LENGTH = 10_000_000;

// Matches app/dashboard/components/page.tsx's COMPONENT_TYPES and
// lib/services/inspoClient.ts's INSPO_TYPE_FOR_COMPONENT_TYPE keys exactly.
const ComponentTypeSchema = z.enum(['Button', 'Card', 'Nav Bar', 'Form', 'Other']);

const ReferenceImageSchema = z.object({
  base64: z.string().max(MAX_REFERENCE_IMAGE_BASE64_LENGTH),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  referenceStrength: z.number().min(0).max(900).optional(), // 0-900 matches Pixellab's documented init-image strength range
});

const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme', 'component']).optional(),
  candidateCount: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
  referenceImage: ReferenceImageSchema.optional(),
  basedOnAssetId: z.string().uuid().optional(),
  // 16-400 matches PixellabGenerator's own MIN_SIZE/MAX_SIZE clamp range —
  // validated here too so an out-of-range value is rejected with a clear
  // 400 instead of being silently clamped deep in the generator.
  width: z.number().int().min(16).max(400).optional(),
  height: z.number().int().min(16).max(400).optional(),
  provider: z.enum(['claude', 'ollama', 'openrouter']).optional(),
  model: z.string().min(1).optional(),
  ollamaHost: z.string().regex(/^https?:\/\//).optional(),
}).refine(
  input => input.provider !== 'ollama' || (!!input.model && !!input.ollamaHost),
  { message: 'model and ollamaHost are required when provider is "ollama"' }
).refine(
  input => input.provider !== 'openrouter' || !!input.model,
  { message: 'model is required when provider is "openrouter"' }
);

// These three keys are computed by THIS route from the validated
// referenceImage/basedOnAssetId fields below - options is a generic,
// per-key-unvalidated bag (z.record(...unknown())), so a client could
// otherwise inject a raw referenceImageFilename/referenceStrength/
// basedOnAssetId directly into options and bypass ReferenceImageSchema's
// size/type checks and basedOnAssetId's uuid format check entirely.
// grounded/groundedReason/referenceIsFallbackThumbnail/colorMatched are
// computed by worker.ts and written onto a job's options on completion -
// stripped here too so a forged value at job creation can't survive into
// the completed job's options for a job where grounding never actually
// runs (worker.ts only overwrites these fields when grounding fires).
const RESERVED_OPTION_KEYS = ['referenceImageFilename', 'referenceStrength', 'basedOnAssetId', 'width', 'height', 'provider', 'model', 'ollamaHost', 'ollamaCorrectionRequested', 'componentType', 'groundWithInspo', 'grounded', 'groundedReason', 'referenceIsFallbackThumbnail', 'colorMatched'] as const;

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = GenerateSchema.parse(await req.json());

    // Validated against the known enum, not just typeof === 'string' — this value is
    // later used as an object-lookup key (INSPO_TYPE_FOR_COMPONENT_TYPE[componentType]
    // in lib/services/inspoGrounding.ts), so an unrecognized string like "constructor"
    // must not survive. An invalid value is treated exactly like an absent one
    // (componentType is optional) rather than rejecting the whole request.
    const rawComponentType = (input.options as Record<string, unknown> | undefined)?.componentType;
    const requestedComponentType = typeof rawComponentType === 'string' && ComponentTypeSchema.safeParse(rawComponentType).success
      ? rawComponentType
      : undefined;

    if (input.outputKind === 'theme') {
      const pieces = (input.options as { pieces?: unknown } | undefined)?.pieces;
      if (Array.isArray(pieces) && pieces.length > 0) {
        return NextResponse.json({ success: false, error: 'Theme jobs cannot include UI-sheet options.' }, { status: 400 });
      }
    }

    if (input.outputKind === 'component' && input.candidateCount !== undefined && input.candidateCount !== 1) {
      return NextResponse.json({ success: false, error: 'Component jobs do not support multi-candidate generation.' }, { status: 400 });
    }

    if ((input.provider === 'ollama' || input.provider === 'openrouter') && (input.outputKind === 'image' || input.outputKind === undefined)) {
      return NextResponse.json({ success: false, error: `${input.provider === 'ollama' ? 'Ollama' : 'OpenRouter'} is not supported for image (sprite) generation.` }, { status: 400 });
    }
    if ((input.provider === 'ollama' || input.provider === 'openrouter') && input.referenceImage) {
      return NextResponse.json({ success: false, error: `${input.provider === 'ollama' ? 'Ollama' : 'OpenRouter'} is not supported alongside a reference image.` }, { status: 400 });
    }

    let mergedOptions: Record<string, unknown> = { ...(input.options ?? {}) };
    for (const key of RESERVED_OPTION_KEYS) {
      delete mergedOptions[key];
    }
    if (input.referenceImage) {
      const filename = await saveReferenceImage({
        base64: input.referenceImage.base64,
        mediaType: input.referenceImage.mediaType,
      });
      mergedOptions.referenceImageFilename = filename;
      if (input.referenceImage.referenceStrength !== undefined) {
        mergedOptions.referenceStrength = input.referenceImage.referenceStrength;
      }
    }
    if (input.basedOnAssetId) {
      mergedOptions.basedOnAssetId = input.basedOnAssetId;
    }
    if (input.width !== undefined) {
      mergedOptions.width = input.width;
    }
    if (input.height !== undefined) {
      mergedOptions.height = input.height;
    }
    if (input.provider === 'ollama') {
      mergedOptions.provider = input.provider;
      mergedOptions.model = input.model;
      mergedOptions.ollamaHost = input.ollamaHost;
    } else if (input.provider === 'openrouter') {
      mergedOptions.provider = input.provider;
      mergedOptions.model = input.model;
    }
    if (input.outputKind === 'component') {
      if (requestedComponentType !== undefined) {
        mergedOptions.componentType = requestedComponentType;
      }
      const targetStyle = await styleService.getById(input.styleId);
      mergedOptions.groundWithInspo = !!targetStyle?.ground_with_inspo;
    }

    const jobInput = {
      styleId: input.styleId,
      assetType: input.assetType,
      prompt: input.prompt,
      outputKind: input.outputKind,
      options: mergedOptions,
      createdBy: user.id,
    };

    const count = input.candidateCount ?? 1;
    if (count === 1) {
      const job = await jobService.create(jobInput);
      return NextResponse.json({ success: true, data: job });
    }

    const batchId = crypto.randomUUID();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const job = await jobService.create(jobInput);
      DatabaseConnection.getInstance().prepare('UPDATE jobs SET batch_id = ? WHERE id = ?').run(batchId, job.id);
      jobs.push({ ...job, batch_id: batchId });
    }
    return NextResponse.json({ success: true, data: jobs });
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
