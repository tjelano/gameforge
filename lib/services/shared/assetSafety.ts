import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

export function isImageReferencedByAsset(imagePath: string): boolean {
  const db = DatabaseConnection.getInstance();
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM assets WHERE image_path = ?'
  ).get(imagePath) as { count: number };
  return result.count > 0;
}

// Sync version — works inside db.transaction() callbacks, which must
// be synchronous. Uses the plain `fs` module, not `fsPromises`.
export function deleteFileIfSafeSync(filePath: string): void {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', 'images', filePath);
    if (fs.existsSync(physicalPath)) {
      fs.unlinkSync(physicalPath);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}

// Async version — for use in normal async route handlers.
export async function deleteFileIfSafe(filePath: string): Promise<void> {
  try {
    if (!filePath) return;
    if (isImageReferencedByAsset(filePath)) return;
    const physicalPath = path.join(getProjectRoot(), 'storage', 'images', filePath);
    try {
      await fsPromises.unlink(physicalPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') console.error(`Failed to delete ${filePath}:`, e);
    }
  } catch (e) {
    console.error(`Failed to delete ${filePath}:`, e);
  }
}
