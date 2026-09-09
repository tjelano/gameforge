import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z } from 'zod';

const MANIFEST_FILENAME = 'gameforge-manifest.json';

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

const ExportManifestPageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  componentAssetIds: z.array(z.string().uuid()),
  pageFileHash: z.string(),
});
export type ExportManifestPage = z.infer<typeof ExportManifestPageSchema>;

const ExportManifestComponentSchema = z.object({
  assetId: z.string().uuid(),
  componentName: z.string(),
  contentHash: z.string(),
});
export type ExportManifestComponent = z.infer<typeof ExportManifestComponentSchema>;

const ExportManifestSchema = z.object({
  styleId: z.string().uuid(),
  exportedAt: z.number(),
  pages: z.array(ExportManifestPageSchema),
  components: z.array(ExportManifestComponentSchema),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;

/** Reads the manifest from an export directory. Returns null (never throws) for a missing file, unreadable file, invalid JSON, or a shape that doesn't match — every case means "treat as if there's no manifest," never a crash. */
export async function readManifest(exportDir: string): Promise<ExportManifest | null> {
  try {
    const raw = await fsPromises.readFile(path.join(exportDir, MANIFEST_FILENAME), 'utf-8');
    const parsed = ExportManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.error(`Failed to read export manifest in ${exportDir}:`, e);
    }
    return null;
  }
}

export async function writeManifest(exportDir: string, manifest: ExportManifest): Promise<void> {
  try {
    await fsPromises.mkdir(exportDir, { recursive: true });
    await fsPromises.writeFile(path.join(exportDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error(`Failed to write export manifest to ${exportDir}:`, e);
    throw e;
  }
}
