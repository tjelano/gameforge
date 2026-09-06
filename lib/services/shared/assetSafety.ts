import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

export function isImageReferencedByAsset(imagePath: string): boolean {
  // image_path values never collide across output_kind — an image
  // filename and a theme filename always differ by extension (.png/.jpg
  // vs .css) — so a plain lookup by path alone stays correct regardless
  // of which kind is being checked.
  const db = DatabaseConnection.getInstance();
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM assets WHERE image_path = ?'
  ).get(imagePath) as { count: number };
  return result.count > 0;
}

export function storageDirFor(outputKind: 'image' | 'theme' | 'component'): string {
  switch (outputKind) {
    case 'image':
      return 'images';
    case 'theme':
      return 'themes';
    case 'component':
      return 'components';
  }
}

// Sync version — works inside db.transaction() callbacks, which must
// be synchronous. Uses the plain `fs` module, not `fsPromises`.
export function deleteFileIfSafeSync(filePath: string, outputKind: 'image' | 'theme' | 'component'): void {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(outputKind), filePath);
    if (fs.existsSync(physicalPath)) {
      fs.unlinkSync(physicalPath);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}

// Async version — for use in normal async route handlers.
export async function deleteFileIfSafe(filePath: string, outputKind: 'image' | 'theme' | 'component'): Promise<void> {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', storageDirFor(outputKind), filePath);
    try {
      await fsPromises.unlink(physicalPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.error(`Failed to delete ${filePath}:`, e);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}
