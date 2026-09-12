import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { createPlaceholderPng } from '@/lib/utils/placeholderImage';
import { PixellabGenerator } from '@/lib/services/PixellabGenerator';
import type { PlacedPiece } from '@/lib/utils/pieceShapes';
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';

export interface GenerateOptions {
  signal?: AbortSignal;
  referenceImage?: ReferenceImagePayload;
  referenceStrength?: number;
  width?: number;
  height?: number;
}

export interface GeneratedImage {
  path: string; // filename only, per the "database stores filenames, not URLs" rule
  prompt: string;
  metadata: { width: number; height: number; format: string };
}

export interface ImageGenerator {
  generate(prompt: string, styleId: string, options?: GenerateOptions): Promise<GeneratedImage>;
  generateUiAsset(
    description: string,
    pieces: PlacedPiece[],
    imageSize: { width: number; height: number },
    colorPalette?: string
  ): Promise<GeneratedImage>;
}

const PLACEHOLDER_SIZE = 64;
// GameForge's own --accent amber, so a mock placeholder reads as
// "this is a stand-in," not a broken/empty image.
const PLACEHOLDER_PNG = createPlaceholderPng(PLACEHOLDER_SIZE);

export class MockGenerator implements ImageGenerator {
  async generate(prompt: string, styleId: string, options?: GenerateOptions): Promise<GeneratedImage> {
    const signal = options?.signal;
    const filename = `mock-${Date.now()}.png`;

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Timeout', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, 2000);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Timeout', 'AbortError'));
        });
      }
    });

    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    await fsPromises.mkdir(imagesDir, { recursive: true });
    await fsPromises.writeFile(path.join(imagesDir, filename), PLACEHOLDER_PNG);

    return {
      path: filename,
      prompt,
      metadata: { width: PLACEHOLDER_SIZE, height: PLACEHOLDER_SIZE, format: 'png' },
    };
  }

  async generateUiAsset(
    description: string,
    _pieces: PlacedPiece[],
    imageSize: { width: number; height: number },
    _colorPalette?: string
  ): Promise<GeneratedImage> {
    const filename = `mock-sheet-${Date.now()}.png`;
    // createPlaceholderPng only draws a square; using the long side for both
    // dimensions means a landscape/portrait placeholder won't exactly match
    // the requested aspect ratio — fine for a mock no one inspects pixel-by-pixel.
    const longSide = Math.max(imageSize.width, imageSize.height);
    const placeholder = createPlaceholderPng(longSide);

    const imagesDir = path.join(getProjectRoot(), 'storage', 'images');
    await fsPromises.mkdir(imagesDir, { recursive: true });
    await fsPromises.writeFile(path.join(imagesDir, filename), placeholder);

    return {
      path: filename,
      prompt: description,
      metadata: { width: imageSize.width, height: imageSize.height, format: 'png' },
    };
  }
}

// Real Pixellab generation when a key is configured; otherwise the
// mock keeps the whole pipeline (review, promote, export) exercisable
// without spending real generations.
//
// Lazily constructed (matches DatabaseConnection.getInstance()'s own
// pattern) rather than built at module-import time: ESM import
// statements are hoisted ahead of any other top-level code in the
// importing module, so worker.ts's own process.loadEnvFile() call —
// needed because, unlike `next dev`, a bare `tsx worker.ts` process
// never loads .env.local on its own — would otherwise always run
// too late to affect this decision.
let cachedGenerator: ImageGenerator | undefined;

export function getImageGenerator(): ImageGenerator {
  if (!cachedGenerator) {
    cachedGenerator = process.env.PIXELLAB_API_KEY
      ? new PixellabGenerator(process.env.PIXELLAB_API_KEY)
      : new MockGenerator();
  }
  return cachedGenerator;
}
