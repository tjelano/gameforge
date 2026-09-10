import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { z } from 'zod';

const MANIFEST_FILENAME = 'gameforge-manifest.json';

// Normalizes CRLF to LF before hashing so a pure line-ending difference (an
// editor re-saving with different line endings, a git checkout with
// core.autocrlf on) never produces a different hash for semantically
// identical content - shared by every caller (this manifest's own
// page/component hashes, ExportSync.ts's hand-edit detection, and
// GitService.ts's content-bound trust-preservation hashing), so normalizing
// here covers all of them at once. Two files differing in real content still
// hash differently regardless.
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');
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
  // True when contentHash is an ACCEPTED HAND-EDIT baseline (the on-disk hash
  // recorded instead of the freshly-generated one), rather than GameForge's
  // own last-generated hash. SiteExporter needs this distinction: on a hash
  // match it must always regenerate/overwrite a normal (non-hand-edited)
  // entry (to propagate upstream asset changes), but must never overwrite an
  // accepted hand-edit just because it matches its own recorded baseline -
  // that would silently destroy the hand-edit one export after "accepting"
  // it. Optional or absent means false (older manifests never had a
  // hand-edited entry, so absence is unambiguous, not a lossy default).
  handEdited: z.boolean().optional(),
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
