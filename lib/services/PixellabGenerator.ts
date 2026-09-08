import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import type { ImageGenerator, GenerateOptions, GeneratedImage } from '@/lib/services/ImageGenerator';
import { toUiPiece, type PlacedPiece } from '@/lib/utils/pieceShapes';

const API_BASE = 'https://api.pixellab.ai/v2';
const MIN_SIZE = 16;
const MAX_SIZE = 400;
const DEFAULT_SIZE = 64;

function clampSize(value: number | undefined): number {
  if (!value || Number.isNaN(value)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value)));
}

interface PixfluxResponse {
  image: { type: 'base64'; base64: string; format: string };
  usage?: { type: string; generations?: number; usd?: number };
}

interface CreateUiAssetResponse {
  background_job_id: string;
  ui_asset_id: string;
  status: string;
}

interface UiAssetDetail {
  id: string;
  status: string | null;
  image_url: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Real Pixellab (api.pixellab.ai) pixflux text-to-image endpoint.
 * Schema confirmed directly against their live OpenAPI spec and one
 * real test call — not guessed from docs summaries alone.
 */
export class PixellabGenerator implements ImageGenerator {
  constructor(private apiKey: string) {}

  async generate(prompt: string, styleId: string, options?: GenerateOptions & { width?: number; height?: number }): Promise<GeneratedImage> {
    const width = clampSize(options?.width);
    const height = clampSize(options?.height);

    const body: Record<string, unknown> = {
      description: prompt,
      image_size: { width, height },
      no_background: true,
    };
    // NOTE (matching this file's own header comment's precedent): the exact
    // init_image wire shape below is per Pixellab's public docs
    // (https://www.pixellab.ai/docs/options/init-image — "Supports init
    // images and forced palettes", strength range 0-900) but has NOT been
    // confirmed via a live test call the way the rest of this endpoint's
    // schema was. Before shipping, make one real create-image-pixflux call
    // with a reference image and inspect the actual accepted request/
    // response shape — adjust the field name/nesting below to match if it
    // differs, exactly as this file's existing docstring describes doing
    // for the base pixflux schema.
    if (options?.referenceImage) {
      body.init_image = { type: 'base64', base64: options.referenceImage.base64 };
      if (options.referenceStrength !== undefined) {
        body.strength = options.referenceStrength;
      }
    }

    const res = await fetch(`${API_BASE}/create-image-pixflux`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pixellab generation failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as PixfluxResponse;
    const format = data.image.format || 'png';
    const filename = `pixellab-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${format}`;

    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    await fsPromises.mkdir(imagesDir, { recursive: true });
    await fsPromises.writeFile(path.join(imagesDir, filename), Buffer.from(data.image.base64, 'base64'));

    return {
      path: filename,
      prompt,
      metadata: { width, height, format },
    };
  }

  async generateUiAsset(
    description: string,
    pieces: PlacedPiece[],
    imageSize: { width: number; height: number },
    colorPalette?: string,
    pollOptions?: { pollIntervalMs?: number; timeoutMs?: number }
  ): Promise<GeneratedImage> {
    const pollIntervalMs = pollOptions?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = pollOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const createRes = await fetch(`${API_BASE}/create-ui-asset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        image_size: imageSize,
        pieces: pieces.map(toUiPiece),
        color_palette: colorPalette,
        no_background: true,
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      throw new Error(`Pixellab UI asset creation failed (${createRes.status}): ${body || createRes.statusText}`);
    }

    const created = (await createRes.json()) as CreateUiAssetResponse;
    const deadline = Date.now() + timeoutMs;

    let detail: UiAssetDetail;
    while (true) {
      if (Date.now() > deadline) {
        throw new Error(`Pixellab UI asset ${created.ui_asset_id} timed out waiting for completion`);
      }

      const pollRes = await fetch(`${API_BASE}/ui-assets/${created.ui_asset_id}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!pollRes.ok) {
        throw new Error(`Pixellab UI asset poll failed (${pollRes.status}): ${pollRes.statusText}`);
      }
      detail = (await pollRes.json()) as UiAssetDetail;

      if (detail.status === 'completed') break;
      if (detail.status === 'failed') {
        throw new Error(`Pixellab UI asset ${created.ui_asset_id} failed`);
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    if (!detail.image_url) {
      throw new Error(`Pixellab UI asset ${created.ui_asset_id} completed with no image_url`);
    }

    const imageRes = await fetch(detail.image_url);
    if (!imageRes.ok) {
      throw new Error(`Failed to download Pixellab UI asset image (${imageRes.status})`);
    }
    const bytes = Buffer.from(await imageRes.arrayBuffer());

    const filename = `pixellab-sheet-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    await fsPromises.mkdir(imagesDir, { recursive: true });
    await fsPromises.writeFile(path.join(imagesDir, filename), bytes);

    return {
      path: filename,
      prompt: description,
      metadata: { width: imageSize.width, height: imageSize.height, format: 'png' },
    };
  }
}
