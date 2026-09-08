import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';

export interface ReferenceImagePayload {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

const EXTENSION_FOR_MEDIA_TYPE: Record<ReferenceImagePayload['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MEDIA_TYPE_FOR_EXTENSION: Record<string, ReferenceImagePayload['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Saves a validated reference image under storage/references/ and returns
 * its filename. Named independently of any job id (matching every other
 * generator's own output-file naming convention, e.g. ClaudeApiThemeGenerator's
 * `theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`) — the caller
 * (the /api/generate route) doesn't yet know the job's id at the point it
 * needs to write this file, since JobService.create() mints that id itself.
 */
export async function saveReferenceImage(payload: ReferenceImagePayload): Promise<string> {
  const ext = EXTENSION_FOR_MEDIA_TYPE[payload.mediaType];
  const filename = `reference-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const dir = path.join(getProjectRoot(), 'storage', 'references');
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(path.join(dir, filename), Buffer.from(payload.base64, 'base64'));
  } catch (e) {
    console.error(`Failed to write reference image ${filename}:`, e);
    throw e;
  }
  return filename;
}

/** Maps a filename's extension to its ReferenceImagePayload mediaType, or null if unrecognized. Exported so callers reading a non-reference-image file (e.g. a promoted asset's own stored image) can still build a valid ReferenceImagePayload from it without duplicating this lookup. */
export function mediaTypeForFilename(filename: string): ReferenceImagePayload['mediaType'] | null {
  const ext = filename.split('.').pop() ?? '';
  return MEDIA_TYPE_FOR_EXTENSION[ext] ?? null;
}

/**
 * Reads a reference image back off disk. Returns null (never throws) for an
 * unset filename, a missing file, or a filename that isn't a bare name —
 * `options` comes from the database, but this guards the same class of
 * defense-in-depth every other filename-from-DB read site in this codebase
 * already applies (e.g. ClaudeApiThemeGenerator.ts's dedup-steering loop).
 */
export async function loadReferenceImage(filename: string | undefined): Promise<ReferenceImagePayload | null> {
  if (!filename) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;

  const ext = filename.split('.').pop() ?? '';
  const mediaType = MEDIA_TYPE_FOR_EXTENSION[ext];
  if (!mediaType) return null;

  const filePath = path.join(getProjectRoot(), 'storage', 'references', filename);
  try {
    const buffer = await fsPromises.readFile(filePath);
    return { base64: buffer.toString('base64'), mediaType };
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    console.error(`Failed to read reference image ${filename}:`, e);
    throw e;
  }
}
