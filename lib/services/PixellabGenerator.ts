import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import type { ImageGenerator, GenerateOptions, GeneratedImage } from '@/lib/services/ImageGenerator';

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

    const res = await fetch(`${API_BASE}/create-image-pixflux`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: prompt,
        image_size: { width, height },
        no_background: true,
      }),
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
}
